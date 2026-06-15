'use server'

import { revalidatePath } from 'next/cache'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import {
  computeInviteCodeExpiresAt,
  generateInviteCode,
  isValidInviteCodeFormat,
} from '@/lib/invite-code'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'
import {
  createFamilySchema,
  joinFamilySchema,
  type CreateFamilyInput,
  type JoinFamilyInput,
  type FamilyActionResult,
} from './families.types'

/**
 * 新規家族を作成し、自分を最初のメンバーとして登録する。
 * - SECURITY DEFINER RPC `create_family_with_owner` を呼び、families INSERT + family_members INSERT を atomic に行う。
 * - 招待コードはアプリ側で生成して引数渡し（紛らわしい文字除外のアルファベット制御をアプリ層に集約）。
 * - 完了後 JWT に family_id を載せるため refreshSession() を必ず呼ぶ。
 * - hook 反映遅延時は 3 秒待機 + 1 回リトライ、それでも空なら FAMILY_CLAIM_NOT_REFLECTED 戻り値。
 */
export async function createFamily(input: CreateFamilyInput): Promise<FamilyActionResult> {
  const parsed = createFamilySchema.parse(input)
  const supabase = await createSupabaseServerClient()
  const inviteCode = generateInviteCode()
  const expiresAt = computeInviteCodeExpiresAt().toISOString()

  const { error } = await supabase.rpc('create_family_with_owner', {
    p_family_name: parsed.familyName,
    p_display_name: parsed.displayName,
    p_invite_code: inviteCode,
    p_invite_code_expires_at: expiresAt,
  })
  if (error) throw mapRpcError(error)

  return refreshAndVerifyFamilyClaim(supabase)
}

/**
 * 招待コードで既存家族に参加。
 * - SECURITY DEFINER RPC `join_family_by_invite_code` を呼ぶ。
 * - コード検証 / 期限チェック / 重複所属チェック / family_members INSERT を atomic に行う。
 */
export async function joinFamily(input: JoinFamilyInput): Promise<FamilyActionResult> {
  const parsed = joinFamilySchema.parse(input)
  if (!isValidInviteCodeFormat(parsed.inviteCode)) {
    throw new Error('INVALID_CODE')
  }
  const supabase = await createSupabaseServerClient()

  const { error } = await supabase.rpc('join_family_by_invite_code', {
    p_code: parsed.inviteCode,
    p_display_name: parsed.displayName,
  })
  if (error) throw mapRpcError(error)

  return refreshAndVerifyFamilyClaim(supabase)
}

/**
 * 招待コードを再発行する（Phase 5b §1-10、spec v1.6.5 §10-3 (3) L1412 + 設計書 v1.5.5 §17-1 (b)/(c)）。
 *
 * 二重防御:
 * 1. Server Action 層で getUser() identity + family_id (JWT decode) + admin role check
 * 2. RPC `regenerate_family_invite_code` 内で再度 admin only + 形式 check + UNIQUE 制約 verify
 *
 * 戻り値: 成功 = { ok: true, invite_code, expires_at } / 失敗 = 擬人化エラーコード（client で UI 化）
 * CODE_COLLISION 時はアプリ側で 1 回リトライ（nanoid 衝突確率 1/3.4×10^16 だが念のため）。
 */
export type RegenerateInviteCodeResult =
  | { ok: true; invite_code: string; expires_at: string }
  | {
      ok: false
      code:
        | 'UNAUTHENTICATED'
        | 'NOT_IN_FAMILY'
        | 'NOT_ADMIN'
        | 'NETWORK_ERROR'
    }

export async function regenerateInviteCode(): Promise<RegenerateInviteCodeResult> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, code: 'UNAUTHENTICATED' }

  const { data: { session } } = await supabase.auth.getSession()
  const familyId = decodeAccessTokenClaims(session?.access_token)?.family_id
  if (!familyId) return { ok: false, code: 'NOT_IN_FAMILY' }

  const { data: meRow } = await supabase
    .from('family_members')
    .select('role')
    .eq('family_id', familyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (meRow?.role !== 'admin') return { ok: false, code: 'NOT_ADMIN' }

  for (let attempt = 0; attempt < 2; attempt++) {
    const newCode = generateInviteCode()
    const { data, error } = await supabase
      .rpc('regenerate_family_invite_code', {
        p_family_id: familyId,
        p_new_code: newCode,
      })
      .single<{ invite_code: string; invite_code_expires_at: string }>()
    if (!error && data) {
      revalidatePath('/members')
      return {
        ok: true,
        invite_code: data.invite_code,
        expires_at: data.invite_code_expires_at,
      }
    }
    if (error?.message?.includes('CODE_COLLISION') && attempt === 0) {
      continue
    }
    if (error?.message?.includes('NOT_AUTHORIZED')) {
      return { ok: false, code: 'NOT_IN_FAMILY' }
    }
    if (error?.message?.includes('ADMIN_ONLY')) {
      return { ok: false, code: 'NOT_ADMIN' }
    }
    break
  }
  return { ok: false, code: 'NETWORK_ERROR' }
}

/* ------------------------------------------------------------------ */
/* internal helpers (non-export, 'use server' ファイル内で許容される)    */
/* ------------------------------------------------------------------ */

async function refreshAndVerifyFamilyClaim(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<FamilyActionResult> {
  // hook が family_id を JWT claims に注入したか確認する。
  // user.app_metadata.family_id 経由は機能しない（hook は claims 注入、user.app_metadata は別管理）。
  // 必ず session.access_token を decode して claims を読む。
  await supabase.auth.refreshSession()
  let { data: { session } } = await supabase.auth.getSession()
  let claims = decodeAccessTokenClaims(session?.access_token)
  if (claims?.family_id) return { ok: true }

  // hook 反映遅延の可能性 → 3 秒待って再 refresh
  await new Promise((r) => setTimeout(r, 3000))
  await supabase.auth.refreshSession()
  ;({ data: { session } } = await supabase.auth.getSession())
  claims = decodeAccessTokenClaims(session?.access_token)
  if (claims?.family_id) return { ok: true }

  console.warn(
    `WARN family_claim_not_reflected sub=${claims?.sub ?? 'unknown'}`,
  )
  return { ok: false, code: 'FAMILY_CLAIM_NOT_REFLECTED' }
}

function mapRpcError(error: { message?: string }): Error {
  const msg = error.message ?? ''
  if (msg.includes('UNAUTHENTICATED')) return new Error('UNAUTHENTICATED')
  if (msg.includes('ALREADY_IN_FAMILY')) return new Error('ALREADY_IN_FAMILY')
  if (msg.includes('INVALID_CODE')) return new Error('INVALID_CODE')
  if (msg.includes('CODE_EXPIRED')) return new Error('CODE_EXPIRED')
  if (msg.includes('INVALID_FAMILY_NAME')) return new Error('INVALID_FAMILY_NAME')
  if (msg.includes('INVALID_DISPLAY_NAME')) return new Error('INVALID_DISPLAY_NAME')
  if (msg.includes('INVALID_EXPIRES_AT')) return new Error('INVALID_EXPIRES_AT')
  return new Error('RPC_ERROR: ' + msg)
}
