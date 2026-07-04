import { listTemplatesWithThumbs } from '@/server/templates'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { TemplateGrid } from '@/app/(dashboard)/templates/_components/TemplateGrid'
import type { TemplateCardData, TemplateCardMode } from '@/app/(dashboard)/templates/_components/TemplateCard'
import ErrorNotice from '@/components/error-notice'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'テンプレ',
  robots: { index: false, follow: false },
}

interface SearchParams {
  from?: string
  intent?: string
  section?: string
}

function inferStatus(
  status: string | null | undefined,
  sourceFormat: string,
): 'pending' | 'ready' | 'failed' | 'skipped' {
  if (status === 'ready' || status === 'failed' || status === 'skipped') return status
  if (status === 'pending') {
    return sourceFormat === 'docx' ? 'skipped' : 'pending'
  }
  return sourceFormat === 'docx' ? 'skipped' : 'pending'
}

// builtin サンプルテンプレ 3 種は family_id=null のため image_cache RLS の都合で
// ユーザーテンプレ用サムネ生成パイプを流用できない。UI からアクセス可能な静的 PNG
// （public/builtin-templates/*.png）として bundle し、page.tsx で id → slug 解決して
// 静的 path を返す。PNG 生成スクリプト: scripts/build-builtin-template-thumbs.ts。
const BUILTIN_THUMB_BY_ID: Record<string, string> = {
  '00000000-0000-0000-0000-000000000001': '/builtin-templates/family-meeting.png',
  '00000000-0000-0000-0000-000000000002': '/builtin-templates/child-schedule.png',
  '00000000-0000-0000-0000-000000000003': '/builtin-templates/budget-report.png',
}

function builtinThumb(
  id: string,
  isDefault: boolean,
  sourceFormat: string,
): { url: string | null; status: 'ready' | null } {
  // 防御的に複数条件 AND: is_default && source_format='builtin' && マップに登録あり。
  // 将来 user テンプレと id 衝突しても誤適用しない。
  if (!isDefault) return { url: null, status: null }
  if (sourceFormat !== 'builtin') return { url: null, status: null }
  const url = BUILTIN_THUMB_BY_ID[id]
  if (!url) return { url: null, status: null }
  return { url, status: 'ready' }
}

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // 未ログイン時は builtin テンプレのみ取得（RLS で family_id IS NULL のもの）。
  // ログイン済みでも listTemplatesWithThumbs は同 supabase client 経由で
  // RLS に従い family テンプレを返す。
  let templatesRaw: Awaited<ReturnType<typeof listTemplatesWithThumbs>> = []
  let errorMsg: string | null = null
  try {
    templatesRaw = await listTemplatesWithThumbs()
  } catch (e) {
    errorMsg = e instanceof Error ? e.message : 'unknown error'
  }

  const all: TemplateCardData[] = templatesRaw.map((t) => {
    const builtin = builtinThumb(t.id, t.is_default, t.source_format)
    return {
      id: t.id,
      name: t.name,
      source_format: t.source_format,
      is_default: t.is_default,
      created_at: t.created_at,
      // builtin のときは static PNG が確定的に存在するので 'ready' で固定。
      // signedThumbUrl 側に static path を入れることで TemplateCard 側は無改修。
      thumbnail_status: builtin.status ?? inferStatus(t.thumbnail_status, t.source_format),
      signedThumbUrl: builtin.url ?? t.signedThumbUrl,
    }
  })

  const samples = all.filter((t) => t.is_default)
  // 未ログイン時は family テンプレが RLS で返らないため空配列になる。
  // ログイン済みでも表示するが、未ログイン時は TemplateGrid に渡さない。
  const customs = user ? all.filter((t) => !t.is_default) : []

  const mode: TemplateCardMode = params.from === 'cta' ? 'select' : 'manage'
  const intent: 'ai' | 'manual' = params.intent === 'manual' ? 'manual' : 'ai'

  const spSection: 'all' | 'sample' | 'custom' =
    params.section === 'sample'
      ? 'sample'
      : customs.length === 0
        ? 'all'
        : 'custom'

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <header>
        <h1 className="text-xl font-serif text-gizirotto-blue-900">
          {mode === 'select' ? 'テンプレを選ぶ' : 'テンプレ'}
        </h1>
      </header>

      {errorMsg && <ErrorNotice code={errorMsg} prefix="読み込みに失敗しました" />}

      {!errorMsg && (
        <TemplateGrid
          samples={samples}
          customs={customs}
          mode={mode}
          intent={intent}
          spSection={spSection}
          isAuthenticated={!!user}
        />
      )}
    </div>
  )
}
