import Link from 'next/link'
import { MinuteCard } from './MinuteCard'

export type RecentMinute = {
  id: string
  title: string
  meeting_date: string
  thumbSignedUrl: string | null
  /**
   * サムネ状態。
   * 表示側で 3 分岐（ready / pending / failed）+ pending では on-demand 自動 trigger。
   * 'skipped' は minutes には現状到来しないが将来拡張も含め 'ready' 以外として扱う。
   */
  thumbStatus: 'ready' | 'pending' | 'failed' | 'skipped'
}

export function RecentMinutesSection({
  minutes,
}: {
  minutes: RecentMinute[]
}) {
  const showAllLink = minutes.length >= 5
  const isEmpty = minutes.length === 0

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-[#1F2937]">
          最近の議事録
        </h2>
        {showAllLink && (
          <Link
            href="/minutes"
            className="text-sm text-gizirotto-blue-700 hover:underline"
          >
            全部見る →
          </Link>
        )}
      </header>

      {isEmpty ? (
        <EmptyRecentMinutes />
      ) : (
        <>
          <ul className="md:hidden flex gap-3 overflow-x-auto snap-x snap-mandatory -mx-4 px-4 pb-2">
            {minutes.map((m, i) => (
              <li
                key={m.id}
                className="snap-start shrink-0 w-[42vw] max-w-[160px]"
              >
                <MinuteCard minute={m} eager={i < 3} />
              </li>
            ))}
          </ul>

          <ul className="hidden md:grid grid-cols-5 gap-4 max-w-6xl mx-auto">
            {minutes.map((m, i) => (
              <li key={m.id}>
                <MinuteCard minute={m} eager={i < 3} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function EmptyRecentMinutes() {
  return (
    <div
      className="bg-white border border-dashed border-[#E5E7EB] rounded-xl py-10 px-6 text-center space-y-2"
      style={{ minHeight: '160px' }}
    >
      <p className="text-sm font-medium text-[#1F2937]">
        まだ議事録はありません
      </p>
      <p className="text-xs text-[#6B7280]">
        家族会議や月例ミーティング、お気軽にお試しください
      </p>
    </div>
  )
}
