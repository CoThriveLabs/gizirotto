import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getMinutes } from '@/server/minutes'
import { MinutesViewer } from './_components/MinutesViewer'
import { MinutesActions } from './_components/MinutesActions'
import { OutputButtons } from './_components/OutputButtons'
import { ExcludeFromLearningToggle } from './_components/ExcludeFromLearningToggle'

/**
 * 議事録詳細ページ。
 *
 * PDF / docx 起源テンプレ完全同経路（docx も blank PDF 化済前提）。
 * - 上部: タイトル + 開催日 + テンプレ名
 * - 中央: dpi 150 PNG 画像（複数ページ縦スクロール）
 * - 右側: 出力ボタン群 + 編集 / 削除
 * - 下部: ※ AI 生成は完璧でない 注記
 */
export const dynamic = 'force-dynamic'

export default async function MinutesDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  let minutes: Awaited<ReturnType<typeof getMinutes>>
  try {
    minutes = await getMinutes(id)
  } catch {
    notFound()
  }

  const template = Array.isArray(minutes.template)
    ? minutes.template[0]
    : minutes.template

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/minutes" className="text-sm text-gizirotto-blue-700 hover:underline">
          ← 議事録一覧へ
        </Link>
      </div>

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-serif text-gizirotto-blue-900 break-words">
            {minutes.title}
          </h1>
          <p className="text-xs text-gray-500 mt-2">
            開催日:{' '}
            {new Date(minutes.meeting_date).toLocaleDateString('ja-JP', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
            {template?.name && (
              <span className="ml-2 text-gizirotto-blue-600">／ {template.name}</span>
            )}
          </p>
        </div>
        {/* ヘッダー右に主要アクションを集約（テンプレ編集モード / AdjustView と統一）。
            配置順: 編集 / Word DL / PDF DL / 画像で見る・DL / 削除（右端）。
            実体は AdjustView 経路（/minutes/[id]/adjust）。 */}
        <div className="flex flex-col gap-2 items-end">
          <MinutesActions minuteId={minutes.id} title={minutes.title} />
          <OutputButtons
            minuteId={minutes.id}
            title={minutes.title}
            sourceFormat={template?.source_format ?? null}
          />
        </div>
      </header>

      <MinutesViewer
        minuteId={minutes.id}
        title={minutes.title}
        thumbnailStatus={minutes.thumbnail_status}
      />

      <section className="pt-2">
        <ExcludeFromLearningToggle
          minuteId={minutes.id}
          initialExcluded={minutes.exclude_from_learning ?? false}
        />
      </section>

      <section className="text-xs text-gray-400 space-y-1 pt-4 border-t border-gizirotto-blue-100">
        <p>※ AI による生成結果は完璧ではありません</p>
        <p>
          作成日:{' '}
          {new Date(minutes.created_at).toLocaleString('ja-JP', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
          {' / 更新日: '}
          {new Date(minutes.updated_at).toLocaleString('ja-JP', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      </section>
    </div>
  )
}
