import { notFound } from 'next/navigation'
import { getTemplate } from '@/server/templates'
import DeleteButton from './delete-button'
import BboxEditorClient from './bbox-editor-client'

export const dynamic = 'force-dynamic'

/**
 * テンプレ詳細 = bbox 可視化エディタ（G2-1 設計書 v0.2 §1-1 / §5）。
 *
 * 旧・項目一覧（型/必須/英語 name 露出）を全廃し、bbox エディタへ一本化（Q1=別ページ）。
 * Server Component で初期メタ（名前/サンプル判定）だけ取得し、編集 UI は client へ委譲。
 * 背景画像・bbox・fieldsVersion は client が GET /bbox-editor で取得する（§4-1）。
 */
export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  let template: Awaited<ReturnType<typeof getTemplate>>
  try {
    template = await getTemplate(id)
  } catch {
    notFound()
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-serif text-gizirotto-blue-900">
              {template.name}
            </h1>
            {template.is_default && (
              <span className="text-xs bg-gizirotto-blue-100 text-gizirotto-blue-700 px-2 py-0.5 rounded">
                サンプル
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1">
            登録日: {new Date(template.created_at).toLocaleDateString('ja-JP')}
          </p>
        </div>
        {!template.is_default && (
          <DeleteButton templateId={template.id} templateName={template.name} />
        )}
      </header>

      <section className="space-y-3">
        <h2 className="text-lg text-gizirotto-blue-900">記入欄の位置を調整</h2>
        <BboxEditorClient templateId={template.id} backHref="/templates" />
      </section>
    </div>
  )
}
