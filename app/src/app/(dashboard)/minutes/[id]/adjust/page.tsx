import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { getMinutes } from '@/server/minutes'
import { getTemplate } from '@/server/templates'
import { AdjustView } from './AdjustView'
import { buildAdjustInitialProps } from './build-initial-props'

export const dynamic = 'force-dynamic'

/**
 * 議事録「調整」統合エディタ画面（設計書 v2.1 minutes_adjust_editor_renewal_design_2026-06-08 §0/§1/§9 段階 2-D2）。
 *
 * 段階 2 D-core 統合: 位置 drag / 値 textarea / 文字サイズ ± / nudge（NudgeControls 8 種・templates 同型）
 * / 中央寄せ / グリッド表示 / undo / zoom / 整形 SSE を 1 画面で。
 * AI 生成議事録（ID あり）専用（段階 3 で manual 直行・lazy create を追加予定）。
 *
 * 後方互換: bbox_overrides は partial（x/y/w/h/fontSize 全任意）に拡張。
 * 旧 `{x,y}` のみ override 議事録もそのまま動く（parseFieldOverrides 緩和）。
 *
 * タイトルは「議事録を編集する」（用語統一）。ただしファイル名・URL・関数名 `AdjustView` は
 * 据置（コード ID は触らない）。
 */
export default async function MinutesAdjustPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const hdrs = await headers()
  const familyId = hdrs.get('x-family-id')
  if (!familyId) redirect('/family/setup')

  let minutes: Awaited<ReturnType<typeof getMinutes>>
  try {
    minutes = await getMinutes(id)
  } catch {
    notFound()
  }
  if (!minutes.template_id) notFound()

  const template = await getTemplate(minutes.template_id)
  const { fields, pdfFields, initialOverrides, initialValues, fixedTextSizesPt } =
    await buildAdjustInitialProps({
      template,
      contentJson: minutes.content_json,
      bboxOverridesRaw: minutes.bbox_overrides,
      newFieldsRaw: minutes.new_fields,
    })

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      {/* タイトルは「議事録を編集する」に統一。補助文は AdjustView 内ヘッダー部に集約。 */}
      <header>
        <h1 className="text-xl font-serif text-gizirotto-blue-900">議事録を編集する</h1>
      </header>

      <AdjustView
        minuteId={id}
        templateId={minutes.template_id}
        initialTitle={minutes.title}
        initialMeetingDate={minutes.meeting_date}
        fields={fields}
        pdfFields={pdfFields}
        initialOverrides={initialOverrides}
        initialValues={initialValues}
        fixedTextSizesPt={fixedTextSizesPt}
      />
    </div>
  )
}

// extractFieldDefs / extractPdfFields / extractFixedTextSizesPt / parseContentValues now
// live in build-initial-props.ts (shared with the guest adjust entry). parseContentValues
// is re-exported here so existing direct imports from this page module keep working.
export { parseContentValues } from './build-initial-props'
