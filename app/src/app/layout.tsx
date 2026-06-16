import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Link from 'next/link'
import './globals.css'
import { ConsentGate } from '@/components/legal/ConsentGate'

export const metadata: Metadata = {
  metadataBase: new URL('https://gizirotto.cothrivelabs.com'),
  title: 'ぎじろっと',
  description: '家族・少人数グループの議事録を AI が下書き・整形する家庭用アプリ',
  openGraph: {
    title: 'ぎじろっと',
    description: '家族・少人数グループの議事録を AI が下書き・整形する家庭用アプリ',
    url: 'https://gizirotto.cothrivelabs.com',
    siteName: 'ぎじろっと',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'ぎじろっと - 家族の議事録 AI アシスタント',
      },
    ],
    locale: 'ja_JP',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ぎじろっと',
    description: '家族・少人数グループの議事録を AI が下書き・整形する家庭用アプリ',
    images: ['/og-image.png'],
  },
}

// 同意モーダルを出さない（未認証 or 規約ページ自体）パス。
const CONSENT_SKIP_PREFIXES = [
  '/login',
  '/forgot-password',
  '/reset-password',
  '/auth',
  '/legal',
]

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const hdrs = await headers()
  const pathname = hdrs.get('x-pathname') ?? ''
  const skipConsent = CONSENT_SKIP_PREFIXES.some((p) => pathname.startsWith(p))

  return (
    <html lang="ja">
      <body className="bg-gizirotto-blue-50 text-gray-900 font-sans antialiased">
        {children}
        <RootFooter />
        {!skipConsent && <ConsentGate />}
      </body>
    </html>
  )
}

/**
 * 全ページ共通フッター。legal リンクのアクセシビリティ確保が目的。
 * 以下では非表示:
 * - /legal/* : 自前フッター内蔵
 * - /minutes, /settings, /templates : (dashboard) layout の独自フッター内蔵
 */
const ROOT_FOOTER_SKIP_PREFIXES = [
  '/legal',
  '/minutes',
  '/settings',
  '/templates',
]
async function RootFooter() {
  const hdrs = await headers()
  const pathname = hdrs.get('x-pathname') ?? ''
  if (ROOT_FOOTER_SKIP_PREFIXES.some((p) => pathname.startsWith(p))) return null
  return (
    <footer className="border-t border-gizirotto-blue-100 bg-white">
      <div className="max-w-4xl mx-auto px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        <span>Co-Thrive Labs / gizirotto</span>
        <Link href="/legal/terms" className="hover:underline">
          利用規約
        </Link>
        <Link href="/legal/privacy" className="hover:underline">
          プライバシーポリシー
        </Link>
      </div>
    </footer>
  )
}
