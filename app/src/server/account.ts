'use server'

import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { createSupabaseAdminClient } from '@/lib/supabase/admin-client'
import { resolveFamilyIdByUser } from '@/lib/ai-usage-guard'

/**
 * 退会 (アカウント削除) フローの結果型と Server Action。
 *
 * - ケース A (family_deleted): 自分が family 唯一のメンバー → family と Storage 全削除
 * - ケース C (left_family)   : 自分以外にメンバーが居る → 自分の chat_sessions + family_members のみ削除
 * - ケース B はサーバ側で SOLE_ADMIN_BLOCKED として弾く
 *
 * 物理削除順序: Storage → DB (family or 自分の行) → auth.users。
 * 各段階で個別エラーコードを返し、部分削除でも再試行で進める idempotent 設計。
 */

export type DeleteAccountResult =
  | { ok: true; case: 'family_deleted' | 'left_family' }
  | {
      ok: false
      code:
        | 'UNAUTHENTICATED'
        | 'SOLE_ADMIN_BLOCKED'
        | 'WRONG_PASSWORD'
        | 'CONFIRM_TEXT_MISMATCH'
        | 'STORAGE_DELETE_FAILED'
        | 'DB_DELETE_FAILED'
        | 'AUTH_DELETE_FAILED'
        | 'NOT_IN_FAMILY'
    }

export type PreviewDeleteCase =
  | { ok: true; case: 'A' | 'B' | 'C'; familyName: string | null; hasPassword: boolean }
  | { ok: false; code: 'UNAUTHENTICATED' | 'NOT_IN_FAMILY' | 'DB_ERROR' }

const STORAGE_BUCKETS = [
  'templates_raw',
  'templates_processed',
  'image_cache',
  'minutes_output',
] as const

const STORAGE_PAGE_SIZE = 100

/**
 * 削除前にケースを判定し UI 文言を切り替えるためのプレビュー。
 * 実削除は別途 deleteMyAccount を呼ぶ。
 */
export async function previewDeleteCase(): Promise<PreviewDeleteCase> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, code: 'UNAUTHENTICATED' }

  const familyId = await resolveFamilyIdByUser(user.id)
  if (!familyId) return { ok: false, code: 'NOT_IN_FAMILY' }

  const admin = createSupabaseAdminClient()
  const { data: members, error } = await admin
    .from('family_members')
    .select('user_id, role')
    .eq('family_id', familyId)
  if (error || !members) return { ok: false, code: 'DB_ERROR' }

  const others = members.filter((m) => m.user_id !== user.id)
  const admins = members.filter((m) => m.role === 'admin')
  const amISoleAdmin =
    admins.length === 1 && admins[0].user_id === user.id

  const { data: family } = await admin
    .from('families')
    .select('name')
    .eq('id', familyId)
    .maybeSingle()

  let caseId: 'A' | 'B' | 'C'
  if (others.length === 0) {
    caseId = 'A'
  } else if (amISoleAdmin) {
    caseId = 'B'
  } else {
    caseId = 'C'
  }

  // パスワード設定有無は identities を見る。
  // email provider があれば password 設定可能だが、実設定済みかは
  // identity_data に保持されないため、provider 'email' が居れば true とする。
  // magic link only ユーザーは provider 'email' でも password 未設定の可能性があるが、
  // UX 上は念のためパスワード欄を出して入力 → サーバで signInWithPassword エラーで弾く。
  const hasPassword = (user.identities ?? []).some((i) => i.provider === 'email')

  return {
    ok: true,
    case: caseId,
    familyName: (family?.name as string | undefined) ?? null,
    hasPassword,
  }
}

export async function deleteMyAccount(input: {
  confirmText: string
  password?: string
}): Promise<DeleteAccountResult> {
  // ステップ 0: 入力検証 + 認証
  if (input.confirmText !== 'DELETE') {
    return { ok: false, code: 'CONFIRM_TEXT_MISMATCH' }
  }

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, code: 'UNAUTHENTICATED' }

  // ステップ 1: パスワード再認証 (password が渡された場合のみ)
  // メイン cookie を上書きしないよう in-memory client で signInWithPassword
  if (input.password) {
    if (!user.email) return { ok: false, code: 'WRONG_PASSWORD' }
    const verifier = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const { error } = await verifier.auth.signInWithPassword({
      email: user.email,
      password: input.password,
    })
    if (error) return { ok: false, code: 'WRONG_PASSWORD' }
  }

  const familyId = await resolveFamilyIdByUser(user.id)
  if (!familyId) return { ok: false, code: 'NOT_IN_FAMILY' }

  // ステップ 2: ケース判定 (server-side で再検証、client 申告は信用しない)
  const admin = createSupabaseAdminClient()
  const { data: members, error: mErr } = await admin
    .from('family_members')
    .select('user_id, role')
    .eq('family_id', familyId)
  if (mErr || !members) return { ok: false, code: 'DB_DELETE_FAILED' }

  const others = members.filter((m) => m.user_id !== user.id)
  const admins = members.filter((m) => m.role === 'admin')
  const amISoleAdmin =
    admins.length === 1 && admins[0].user_id === user.id

  if (others.length > 0 && amISoleAdmin) {
    return { ok: false, code: 'SOLE_ADMIN_BLOCKED' }
  }
  const isCaseA = others.length === 0

  // ステップ 3: Storage 削除 (ケース A のみ)
  if (isCaseA) {
    for (const bucket of STORAGE_BUCKETS) {
      try {
        let offset = 0
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { data: list, error } = await admin.storage
            .from(bucket)
            .list(familyId, { limit: STORAGE_PAGE_SIZE, offset })
          if (error) throw error
          if (!list || list.length === 0) break
          const paths = list.map((f) => `${familyId}/${f.name}`)
          const { error: rmErr } = await admin.storage
            .from(bucket)
            .remove(paths)
          if (rmErr) throw rmErr
          if (list.length < STORAGE_PAGE_SIZE) break
          offset += STORAGE_PAGE_SIZE
        }
      } catch (e) {
        console.error(
          `[deleteMyAccount] storage cleanup failed bucket=${bucket}`,
          (e as Error)?.message ?? e,
        )
        return { ok: false, code: 'STORAGE_DELETE_FAILED' }
      }
    }
  }

  // ステップ 4: DB 削除
  if (isCaseA) {
    // family を消せば family_members / templates / minutes / chat_sessions / messages
    // / ai_usage_log / family_limits / ai_usage_exceeded / reset_requests / user_styles
    // が CASCADE で消える (init schema 設計どおり)。
    const { error } = await admin.from('families').delete().eq('id', familyId)
    if (error) {
      console.error('[deleteMyAccount] family delete failed', error.message)
      return { ok: false, code: 'DB_DELETE_FAILED' }
    }
  } else {
    // chat_sessions の所有者列は `created_by` (列名 user_id ではない点に注意)。
    // messages は session_id CASCADE で連鎖削除される。
    const { error: csErr } = await admin
      .from('chat_sessions')
      .delete()
      .eq('created_by', user.id)
      .eq('family_id', familyId)
    if (csErr) {
      console.error('[deleteMyAccount] chat_sessions delete failed', csErr.message)
      return { ok: false, code: 'DB_DELETE_FAILED' }
    }

    const { error: fmErr } = await admin
      .from('family_members')
      .delete()
      .eq('user_id', user.id)
      .eq('family_id', familyId)
    if (fmErr) {
      console.error('[deleteMyAccount] family_members delete failed', fmErr.message)
      return { ok: false, code: 'DB_DELETE_FAILED' }
    }
  }

  // ステップ 5: auth.users 削除
  // migration で templates/minutes/chat_sessions の auth.users 参照は SET NULL 済
  const { error: authErr } = await admin.auth.admin.deleteUser(user.id)
  if (authErr) {
    // 二重押下等で既に消えていれば user_not_found を返す可能性あり → 成功扱い (idempotent)
    const msg =
      (authErr as { message?: string; status?: number }).message ?? ''
    if (!/user.?not.?found|user_not_found/i.test(msg)) {
      console.error('[deleteMyAccount] auth.admin.deleteUser failed', msg)
      return { ok: false, code: 'AUTH_DELETE_FAILED' }
    }
  }

  // ステップ 6: 管理者通知 (best-effort、失敗しても削除自体は完了している)
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secretKey = process.env.SUPABASE_SECRET_KEY
  if (supabaseUrl && secretKey) {
    try {
      await fetch(`${supabaseUrl}/functions/v1/notify-mail`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secretKey}`,
        },
        body: JSON.stringify({
          kind: 'account_deleted',
          case: isCaseA ? 'family_deleted' : 'left_family',
          family_id: familyId,
          deleted_at: new Date().toISOString(),
          // PII (email / user_id) は body に含めない
        }),
      })
    } catch (e) {
      console.warn('[deleteMyAccount] notify-mail failed', e)
    }
  }

  return { ok: true, case: isCaseA ? 'family_deleted' : 'left_family' }
}
