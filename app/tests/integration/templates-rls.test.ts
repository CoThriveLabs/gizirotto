import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * templates RLS integration テスト。
 *
 * 前提:
 * - ローカル Supabase 起動済（pnpm dlx supabase start）
 * - init.sql + phase1_rls_hardening.sql + seed.sql 適用済
 * - 環境変数 SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY を export 済
 *
 * 検証:
 * - 各家族は自家族の自前テンプレ + デフォルト(builtin) のみ見える
 * - 他家族の自前テンプレは見えない
 * - 他家族の自前テンプレを DELETE しようとしても 0 行影響（RLS で消えない）
 * - デフォルトテンプレを DELETE しようとしても 0 行影響
 */

const URL = process.env.SUPABASE_URL!
const PUB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY!

describe('Templates RLS isolation (integration)', () => {
  let clientA: SupabaseClient
  let clientB: SupabaseClient
  let userAId: string
  let userBId: string
  let familyAId: string
  let familyBId: string
  let templateAId: string
  let templateBId: string

  beforeAll(async () => {
    if (!URL || !PUB_KEY || !SECRET_KEY) {
      throw new Error(
        'SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY must be set for integration test',
      )
    }
    const admin = createClient(URL, SECRET_KEY)

    await admin.from('families').delete().in('invite_code', ['TPLAAAAAAA', 'TPLBBBBBBB'])
    const { data: list } = await admin.auth.admin.listUsers()
    for (const u of list?.users ?? []) {
      if (u.email === 'tpl-a@test.local' || u.email === 'tpl-b@test.local') {
        await admin.auth.admin.deleteUser(u.id)
      }
    }

    const { data: ua, error: uaErr } = await admin.auth.admin.createUser({
      email: 'tpl-a@test.local',
      password: 'password-a-12345',
      email_confirm: true,
    })
    if (uaErr) throw uaErr
    userAId = ua.user!.id
    const { data: ub, error: ubErr } = await admin.auth.admin.createUser({
      email: 'tpl-b@test.local',
      password: 'password-b-12345',
      email_confirm: true,
    })
    if (ubErr) throw ubErr
    userBId = ub.user!.id

    clientA = createClient(URL, PUB_KEY)
    clientB = createClient(URL, PUB_KEY)
    await clientA.auth.signInWithPassword({
      email: 'tpl-a@test.local',
      password: 'password-a-12345',
    })
    await clientB.auth.signInWithPassword({
      email: 'tpl-b@test.local',
      password: 'password-b-12345',
    })

    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString()
    const { data: famA, error: famAErr } = await clientA
      .rpc('create_family_with_owner', {
        p_family_name: 'TplFam A',
        p_display_name: 'Alice',
        p_invite_code: 'TPLAAAAAAA',
        p_invite_code_expires_at: expiresAt,
      })
      .single()
    if (famAErr) throw famAErr
    const { data: famB, error: famBErr } = await clientB
      .rpc('create_family_with_owner', {
        p_family_name: 'TplFam B',
        p_display_name: 'Bob',
        p_invite_code: 'TPLBBBBBBB',
        p_invite_code_expires_at: expiresAt,
      })
      .single()
    if (famBErr) throw famBErr
    familyAId = (famA as { id: string }).id
    familyBId = (famB as { id: string }).id

    await clientA.auth.refreshSession()
    await clientB.auth.refreshSession()

    // service_role で各家族に自前テンプレを 1 件ずつ INSERT
    const { data: tplA, error: tplAErr } = await admin
      .from('templates')
      .insert({
        family_id: familyAId,
        name: 'A Custom Template',
        source_format: 'docx',
        source_path: `${familyAId}/dummy.docx`,
        processed_path: `${familyAId}/dummy_processed.docx`,
        fields: [
          { name: 'date', label: '日付', type: 'date', required: true },
        ],
        is_default: false,
        created_by: userAId,
      })
      .select()
      .single()
    if (tplAErr) throw tplAErr
    templateAId = tplA.id

    const { data: tplB, error: tplBErr } = await admin
      .from('templates')
      .insert({
        family_id: familyBId,
        name: 'B Custom Template',
        source_format: 'docx',
        source_path: `${familyBId}/dummy.docx`,
        processed_path: `${familyBId}/dummy_processed.docx`,
        fields: [
          { name: 'date', label: '日付', type: 'date', required: true },
        ],
        is_default: false,
        created_by: userBId,
      })
      .select()
      .single()
    if (tplBErr) throw tplBErr
    templateBId = tplB.id
  })

  afterAll(async () => {
    if (!URL || !SECRET_KEY) return
    const admin = createClient(URL, SECRET_KEY)
    // families を消すと init.sql L27-28 の ON DELETE CASCADE で
    // family_members / templates も自動削除される。
    await admin.from('families').delete().in('invite_code', ['TPLAAAAAAA', 'TPLBBBBBBB'])
    const { data: list } = await admin.auth.admin.listUsers()
    for (const u of list?.users ?? []) {
      if (u.email === 'tpl-a@test.local' || u.email === 'tpl-b@test.local') {
        await admin.auth.admin.deleteUser(u.id)
      }
    }
  })

  it('user A sees own custom + builtin templates only', async () => {
    const { data, error } = await clientA.from('templates').select('id, family_id, is_default')
    expect(error).toBeNull()
    const ids = (data ?? []).map((t) => t.id)
    // 自家族テンプレが含まれる
    expect(ids).toContain(templateAId)
    // 他家族テンプレは含まれない
    expect(ids).not.toContain(templateBId)
    // builtin（family_id NULL, is_default true）が見える
    expect(data!.some((t) => t.is_default === true && t.family_id === null)).toBe(true)
  })

  it('user B sees own custom + builtin templates only', async () => {
    const { data, error } = await clientB.from('templates').select('id, family_id, is_default')
    expect(error).toBeNull()
    const ids = (data ?? []).map((t) => t.id)
    expect(ids).toContain(templateBId)
    expect(ids).not.toContain(templateAId)
    expect(data!.some((t) => t.is_default === true && t.family_id === null)).toBe(true)
  })

  it('user A cannot delete user B template (no rows affected)', async () => {
    const { data, error } = await clientA
      .from('templates')
      .delete()
      .eq('id', templateBId)
      .select()
    expect(error).toBeNull()
    expect(data ?? []).toHaveLength(0)
  })

  it('user A cannot delete builtin templates (no rows affected)', async () => {
    const { data, error } = await clientA
      .from('templates')
      .delete()
      .eq('is_default', true)
      .select()
    expect(error).toBeNull()
    expect(data ?? []).toHaveLength(0)
  })
})
