import Link from 'next/link'
import Image from 'next/image'
import type { ReactNode } from 'react'

/**
 * 規約系ページ共通レイアウト。
 * - (dashboard) layout の認証要件を共有しないよう独立ページとして実装。
 * - 未ログインでも閲覧可（同意モーダルからのリンクで新規タブ表示するため）。
 * - Tailwind Typography プラグイン未導入のため、見出し等は legal-content クラスで自前定義。
 */
export function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-gizirotto-blue-50">
      <header className="border-b border-gizirotto-blue-100 bg-white">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <Link
            href="/"
            aria-label="ぎじろっとホームへ"
            className="flex items-center gap-2 hover:opacity-80"
          >
            <Image
              src="/gizirottokun.png"
              alt="ぎじろっとくん"
              width={40}
              height={40}
              className="h-10 w-auto shrink-0"
            />
            <Image
              src="/gizirotto-logo.png"
              alt="ぎじろっと"
              width={973}
              height={378}
              className="h-7 w-auto shrink-0"
            />
          </Link>
          <nav className="flex items-center gap-3 text-sm">
            <Link
              href="/legal/terms"
              className="text-gizirotto-blue-700 hover:underline"
            >
              利用規約
            </Link>
            <Link
              href="/legal/privacy"
              className="text-gizirotto-blue-700 hover:underline"
            >
              プライバシーポリシー
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <article className="legal-content max-w-3xl mx-auto px-4 py-8 text-gray-800 leading-relaxed">
          {children}
        </article>
      </main>
      <footer className="border-t border-gizirotto-blue-100 bg-white">
        <div className="max-w-4xl mx-auto px-4 py-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-500">
          <span>Co-Thrive Labs / gizirotto</span>
          <Link href="/legal/terms" className="hover:underline">
            利用規約
          </Link>
          <Link href="/legal/privacy" className="hover:underline">
            プライバシーポリシー
          </Link>
          <a
            href="mailto:contact@cothrivelabs.com"
            className="hover:underline"
          >
            contact@cothrivelabs.com
          </a>
        </div>
      </footer>
    </div>
  )
}

/**
 * 規約冒頭のメタ情報カード。definition list として表示。
 */
export function LegalMetaCard({
  service,
  operator,
  contact,
  enacted,
  updated,
  version,
}: {
  service: string
  operator: string
  contact: string
  enacted: string
  updated: string
  version: string
}) {
  const items: [string, ReactNode][] = [
    ['対象サービス', service],
    ['運営者', operator],
    [
      '連絡先',
      <a
        key="contact"
        href={`mailto:${contact}`}
        className="text-gizirotto-blue-700 hover:underline"
      >
        {contact}
      </a>,
    ],
    ['制定日', enacted],
    ['最終更新', updated],
    ['バージョン', version],
  ]
  return (
    <aside
      aria-label="メタ情報"
      className="my-6 rounded-lg border border-gizirotto-blue-200 bg-white p-4"
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {items.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-semibold text-gray-700">{k}</dt>
            <dd className="text-gray-900">{v}</dd>
          </div>
        ))}
      </dl>
    </aside>
  )
}
