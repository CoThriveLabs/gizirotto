// notify-mail Edge Function (Resend 直叩き)。
//
// 2 経路の payload を出し分ける:
//  - Database Webhook (abuse_alerts INSERT): { type:'INSERT', record:{ pattern, detail } }
//  - リセット依頼 (request-reset route):      { kind:'reset_request', family_id, requested_by, usage }
//
// 送信元・宛先は Edge Function secret (NOTIFY_FROM / NOTIFY_TO) で注入する。
// 健全時はメールゼロ (異常検知 / spend 80% / リセット依頼の 4 種のみ発火)。

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!
const FROM = Deno.env.get('NOTIFY_FROM') ?? 'noreply@cothrivelabs.com'
const TO = Deno.env.get('NOTIFY_TO')
if (!TO) throw new Error('NOTIFY_TO env not set')

serve(async (req) => {
  const payload = await req.json().catch(() => null)
  if (!payload) return new Response('bad_request', { status: 400 })

  const { subject, text } = buildMail(payload)

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to: TO, subject, text }),
  })
  if (!res.ok) {
    console.error('[notify-mail] resend failed', res.status, await res.text())
    return new Response('resend_failed', { status: 502 })
  }
  return new Response('ok')
})

// deno-lint-ignore no-explicit-any
function buildMail(p: any): { subject: string; text: string } {
  // Database Webhook 経由 (abuse_alerts INSERT)
  if (p?.record?.pattern) {
    const { pattern, detail } = p.record
    if (pattern === 'spend_80pct') {
      return {
        subject: `[minutes-app] Claude 月額 80% 接近: $${detail.cost_month_to_date} / $20`,
        text: `月初〜現在のコストが $${detail.cost_month_to_date}（${detail.pct}%）に達しました。`,
      }
    }
    if (pattern === 'high_frequency') {
      return {
        subject: `[minutes-app] 異常 burst 検知: count=${detail.count}`,
        text: `5 分以内に同一ユーザーから ${detail.count} 件の AI 呼び出しを検知しました。`,
      }
    }
    if (pattern === 'signup_flood') {
      return {
        subject: `[minutes-app] signup 連投検知: ip=${detail.ip} count=${detail.count}`,
        text: `5 分以内に同一 IP から ${detail.count} 件の signup を検知しました。`,
      }
    }
  }
  // リセット依頼経由
  if (p?.kind === 'reset_request') {
    return {
      subject: `[minutes-app] リセット依頼: family=${p.family_id}`,
      text: `家族 ${p.family_id} の ${p.requested_by} さんからリセット依頼がありました。\n現使用量: ${JSON.stringify(p.usage)}`,
    }
  }
  return { subject: '[minutes-app] 通知', text: JSON.stringify(p) }
}
