import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * RLS integration テスト。
 *
 * 前提:
 * - ローカル Supabase 起動必須（`pnpm dlx supabase start`）
 * - init.sql + phase1_rls_hardening.sql + seed.sql 適用済（`pnpm dlx supabase db reset`）
 * - 環境変数 SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY を export 済
 *
 * 検証:
 * - 2 ユーザー × 2 family を作成
 * - 各ユーザーは自家族の minutes のみ見える（cross-family SELECT 0 件）
 * - family_members 直接 INSERT が RLS で弾かれる
 * - 既参加ユーザーが別招待コードで join 試行すると ALREADY_IN_FAMILY 拒否
 */

const URL = process.env.SUPABASE_URL!
const PUB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY!

describe('Family RLS isolation (integration)', () => {
  let clientA: SupabaseClient
  let clientB: SupabaseClient
  let userAId: string
  let userBId: string
  let familyAId: string
  let familyBId: string

  beforeAll(async () => {
    if (!URL || !PUB_KEY || !SECRET_KEY) {
      throw new Error(
        'SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY must be set for integration test',
      )
    }

    // service_role でテストユーザー 2 名を auth.users に直接作成
    const admin = createClient(URL, SECRET_KEY)

    // 既存のテストユーザー / families があれば削除（テスト再実行用クリーンアップ）
    // families は invite_code UNIQUE 制約があるため、孤児行が残ると 2 回目以降の
    // create_family_with_owner が失敗する。先に families を消す（family_members は CASCADE）。
    await admin.from('families').delete().in('invite_code', ['AAAAAAAAAA', 'BBBBBBBBBB'])
    const { data: list } = await admin.auth.admin.listUsers()
    for (const u of list?.users ?? []) {
      if (u.email === 'a@test.local' || u.email === 'b@test.local') {
        await admin.auth.admin.deleteUser(u.id)
      }
    }

    const { data: userAData, error: userAErr } = await admin.auth.admin.createUser({
      email: 'a@test.local',
      password: 'password-a-12345',
      email_confirm: true,
    })
    if (userAErr) throw userAErr
    userAId = userAData.user!.id

    const { data: userBData, error: userBErr } = await admin.auth.admin.createUser({
      email: 'b@test.local',
      password: 'password-b-12345',
      email_confirm: true,
    })
    if (userBErr) throw userBErr
    userBId = userBData.user!.id

    // 各ユーザーのクライアントでログイン
    clientA = createClient(URL, PUB_KEY)
    clientB = createClient(URL, PUB_KEY)
    await clientA.auth.signInWithPassword({ email: 'a@test.local', password: 'password-a-12345' })
    await clientB.auth.signInWithPassword({ email: 'b@test.local', password: 'password-b-12345' })

    // RPC 経由で 2 家族作成
    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString()
    const { data: famA, error: famAErr } = await clientA
      .rpc('create_family_with_owner', {
        p_family_name: 'Family A',
        p_display_name: 'Alice',
        p_invite_code: 'AAAAAAAAAA', // 10 文字、許可アルファベット内
        p_invite_code_expires_at: expiresAt,
      })
      .single()
    if (famAErr) throw famAErr
    const { data: famB, error: famBErr } = await clientB
      .rpc('create_family_with_owner', {
        p_family_name: 'Family B',
        p_display_name: 'Bob',
        p_invite_code: 'BBBBBBBBBB',
        p_invite_code_expires_at: expiresAt,
      })
      .single()
    if (famBErr) throw famBErr

    familyAId = (famA as { id: string }).id
    familyBId = (famB as { id: string }).id

    // JWT に family_id を反映
    await clientA.auth.refreshSession()
    await clientB.auth.refreshSession()

    // 各 family に minutes を 1 件ずつ投入（service_role 経由でシード）
    const { error: insertErr } = await admin.from('minutes').insert([
      {
        family_id: familyAId,
        title: 'A-minutes',
        content_json: {},
        source_mode: 'B-2',
        created_by: userAId,
      },
      {
        family_id: familyBId,
        title: 'B-minutes',
        content_json: {},
        source_mode: 'B-2',
        created_by: userBId,
      },
    ])
    if (insertErr) throw insertErr
  })

  afterAll(async () => {
    if (!URL || !SECRET_KEY) return
    const admin = createClient(URL, SECRET_KEY)
    // families を直接削除（family_members / minutes は ON DELETE CASCADE で消える）
    await admin.from('families').delete().in('invite_code', ['AAAAAAAAAA', 'BBBBBBBBBB'])
    // テストユーザーも明示削除
    const { data: list } = await admin.auth.admin.listUsers()
    for (const u of list?.users ?? []) {
      if (u.email === 'a@test.local' || u.email === 'b@test.local') {
        await admin.auth.admin.deleteUser(u.id)
      }
    }
  })

  it('user A sees only family A minutes', async () => {
    const { data, error } = await clientA.from('minutes').select('*')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].family_id).toBe(familyAId)
  })

  it('user B sees only family B minutes', async () => {
    const { data, error } = await clientB.from('minutes').select('*')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].family_id).toBe(familyBId)
  })

  it('user A direct INSERT into family_members is rejected by RLS', async () => {
    const { error } = await clientA.from('family_members').insert({
      family_id: familyBId,
      user_id: userAId,
      display_name: 'evil',
      role: 'member',
    })
    expect(error).not.toBeNull()
    // RLS violation: PostgreSQL は 42501 / Supabase 経由は code: '42501'
    expect(error!.code).toBe('42501')
  })

  it('user A join attempt with B invite code while already in A is rejected', async () => {
    const { error } = await clientA.rpc('join_family_by_invite_code', {
      p_code: 'BBBBBBBBBB',
      p_display_name: 'Alice',
    })
    expect(error).not.toBeNull()
    expect(error!.message).toContain('ALREADY_IN_FAMILY')
  })
})
