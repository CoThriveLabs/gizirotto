'use client'

import Image from 'next/image'
import Link from 'next/link'
import { MemberAvatar } from '@/components/MemberAvatar'

/**
 * 全ページ共通ヘッダー。
 * - キャラ画像（gizirottokun）を大きめ / ロゴ画像（gizirotto-logo）を小さめにしてバランス調整。
 * - familyName が空文字なら家族名は非表示（取得経路が無いページ向け）。
 * - ホームリンクは (dashboard)/layout 側で main content と同じ container 内に配置する。
 */
export function Header({
  familyName,
  displayName,
}: {
  familyName: string
  displayName: string
}) {
  return (
    <header className="border-b border-gizirotto-blue-100 bg-white sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {/* ロゴ/キャラ画像クリックでホームへ戻れるように Link で wrap */}
          <Link
            href="/"
            aria-label="ホームへ戻る"
            className="flex items-center gap-2 cursor-pointer hover:opacity-80"
          >
            <Image
              src="/gizirottokun.png"
              alt="ぎじろっとくん"
              width={40}
              height={40}
              priority
              className="h-10 w-auto shrink-0"
            />
            <Image
              src="/gizirotto-logo.png"
              alt="ぎじろっと"
              width={973}
              height={378}
              priority
              className="h-7 w-auto shrink-0"
            />
          </Link>
        </div>
        <div className="flex items-center gap-3 min-w-0">
          {familyName && (
            <span className="text-sm text-gray-600 truncate">
              {familyName}
            </span>
          )}
          <Link
            href="/members"
            aria-label={displayName ? `${displayName} の家族メンバー画面へ` : '家族メンバー'}
            className="rounded-full hover:opacity-80 shrink-0"
          >
            <MemberAvatar displayName={displayName} size="sm" />
          </Link>
        </div>
      </div>
    </header>
  )
}
