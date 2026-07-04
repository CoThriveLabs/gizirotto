import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { getTemplate } from '@/server/templates'
import { isBuiltinTemplate } from '@/lib/templates/builtin-ids'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getClientIpFromHeaders } from '@/lib/client-ip'
import { guestTemplateLimit } from '@/lib/ratelimit'
import { buildAdjustInitialProps } from '@/app/(dashboard)/minutes/[id]/adjust/build-initial-props'
import { GuestAdjustBootstrap } from './GuestAdjustBootstrap'
import { GuestTemplateLimitReached } from './GuestTemplateLimitReached'

export const dynamic = 'force-dynamic'

interface SearchParams {
  template_id?: string
}

/**
 * ゲスト向け AdjustView 到達ルート（公開フロー）。
 *
 * - builtin テンプレ ID のみ通過（user テンプレへの直 URL は 404）
 * - ログイン済みユーザーがここへ来た場合は通常の作成フロー（manual 経由の createMinute）へ誘導する
 * - minute レコードは一切作らない。ログインユーザーの adjust/page.tsx と同じ
 *   build-initial-props.ts を、空の content / overrides / new_fields で呼んで同一のレイアウト
 *   計算結果を得る。
 */
export default async function MinutesNewAdjustPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams

  const templateId = params.template_id
  if (!templateId) redirect('/templates?from=cta')

  // builtin 以外の ID は 404。未ログイン時の user テンプレ偽装を弾く。
  if (!isBuiltinTemplate(templateId)) {
    notFound()
  }

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user) {
    // ログイン済みは通常の作成フロー（manual 経由で createMinute → 実 minute の adjust）へ。
    redirect(`/minutes/new/manual?template_id=${templateId}`)
  }

  // ゲストのみ: builtin を開いて AdjustView に到達したら 1 回消費する。manual/chat どちらの経路
  // から来たかをこの page には判別する信頼できる情報が無いため、経路を問わず統一で消費する。
  // クライアント改ざんで回避できないよう server side でカウントする。Turnstile は付けない
  // （guestTemplateLimit 単体で守る運用が確定済み）。
  const h = await headers()
  const ip = getClientIpFromHeaders(h)
  const limit = await guestTemplateLimit.limit(`ip:${ip}`)
  if (!limit.success) {
    return <GuestTemplateLimitReached resetAt={limit.reset} />
  }

  const template = await getTemplate(templateId)
  const { fields, pdfFields, initialOverrides, initialValues, fixedTextSizesPt } =
    await buildAdjustInitialProps({
      template,
      contentJson: {},
      bboxOverridesRaw: {},
      newFieldsRaw: [],
    })

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <header>
        <h1 className="text-xl font-serif text-gizirotto-blue-900">議事録を編集する</h1>
      </header>

      <GuestAdjustBootstrap
        templateId={templateId}
        templateName={template.name}
        fields={fields}
        pdfFields={pdfFields}
        initialOverrides={initialOverrides}
        initialValues={initialValues}
        fixedTextSizesPt={fixedTextSizesPt}
      />
    </div>
  )
}
