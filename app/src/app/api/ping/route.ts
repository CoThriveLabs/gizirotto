import { NextResponse } from 'next/server'

export const runtime = 'edge'

/**
 * Supabase pause 回避 + Edge Runtime 動作確認用。
 * - GitHub Actions cron から週 1 で Bearer 認証付きで叩く。
 * - production で PING_SECRET 未設定なら 500（フェイルクローズ）。
 * - local（NODE_ENV !== 'production'）で PING_SECRET 未設定なら認証スキップ（開発便宜）。
 * 設計書 v1.3 §1-5 準拠。
 */
export async function GET(request: Request) {
  const expected = process.env.PING_SECRET

  // ① production フェイルクローズ
  if (process.env.NODE_ENV === 'production' && !expected) {
    return new Response('PING_SECRET not configured', { status: 500 })
  }

  // ② local / preview で PING_SECRET 未設定なら認証スキップ
  // ③ PING_SECRET 設定済（production / preview / local 共通）なら Bearer 検証必須
  if (expected) {
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  // Supabase pause 回避: 軽量 SELECT を 1 発打つ
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  let supabaseOk = false

  if (supabaseUrl && supabaseKey) {
    try {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/families?select=id&limit=1`,
        {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
        },
      )
      supabaseOk = res.ok
    } catch {
      supabaseOk = false
    }
  }

  return NextResponse.json({
    ok: true,
    supabase: supabaseOk,
    runtime: 'edge',
    ts: new Date().toISOString(),
  })
}
