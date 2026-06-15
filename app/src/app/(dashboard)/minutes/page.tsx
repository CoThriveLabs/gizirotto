import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { listMinutes } from '@/server/minutes'
import { MinutesListView } from './_components/MinutesListView'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '議事録一覧',
  robots: { index: false, follow: false },
}

interface SearchParams {
  month?: string
  page?: string
}

export default async function MinutesListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const hdrs = await headers()
  const familyId = hdrs.get('x-family-id')
  if (!familyId) redirect('/family/setup')

  const page = Number.parseInt(params.page ?? '1', 10) || 1
  const month = params.month
  const result = await listMinutes({ month, page })

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-serif text-gizirotto-blue-900">議事録一覧</h1>
          <p className="text-xs text-gray-500 mt-1">
            全 {result.totalCount} 件
          </p>
        </div>
        <Link
          href="/templates?from=cta&intent=ai"
          className="text-sm bg-gizirotto-blue-700 text-white px-4 py-2 rounded hover:bg-gizirotto-blue-800"
        >
          ＋ 新しく議事録を作る
        </Link>
      </header>

      <MinutesListView
        items={result.items}
        totalCount={result.totalCount}
        page={result.page}
        pageSize={result.pageSize}
        currentMonth={month ?? ''}
      />
    </div>
  )
}
