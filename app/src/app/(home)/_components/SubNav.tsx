'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * SP/PC サブ導線。
 *
 * - PC (md 以上): 「テンプレ管理 / 家族メンバー / 設定」3 アイコン
 * - SP (< md): 「ホーム / FAB（新規議事録 CTA）/ 設定」3 アイコン構成（v2 モック準拠）
 *   FAB は 56×56px 中央配置（マテリアル準拠、spec §3-5 タッチ 44+px）
 */

type PcItem = { href: string; label: string; icon: React.ComponentType<{ active: boolean }> }

const PC_ITEMS: PcItem[] = [
  { href: '/templates', label: 'テンプレ管理', icon: TemplateIcon },
  { href: '/members', label: '家族メンバー', icon: MembersIcon },
  { href: '/settings', label: '設定', icon: SettingsIcon },
]

const FAB_HREF = '/templates?from=cta&intent=ai'

export function SubNav({ showPcNav = true }: { showPcNav?: boolean } = {}) {
  const pathname = usePathname()
  return (
    <>
      {showPcNav && (
      <nav
        aria-label="サブ導線"
        className="hidden gap-6 md:grid grid-cols-3 max-w-xs mx-auto py-6"
      >
        {PC_ITEMS.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + '/')
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center gap-1 text-xs ${
                active ? 'text-gizirotto-blue-700' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Icon active={active} />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>
      )}

      <SpFooter pathname={pathname} />
    </>
  )
}

function SpFooter({ pathname }: { pathname: string }) {
  const homeActive = pathname === '/'
  const settingsActive =
    pathname === '/settings' || pathname.startsWith('/settings/')
  return (
    <nav
      aria-label="フッターメニュー"
      className="md:hidden fixed bottom-0 inset-x-0 bg-white border-t border-gizirotto-blue-100 z-40"
    >
      <div className="relative grid grid-cols-3 items-center min-h-[64px]">
        <Link
          href="/"
          aria-current={homeActive ? 'page' : undefined}
          className={`flex flex-col items-center justify-center gap-0.5 py-2.5 min-h-[64px] text-[11px] ${
            homeActive ? 'text-gizirotto-blue-700' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <HomeIcon active={homeActive} />
          <span>ホーム</span>
        </Link>

        <div className="flex items-start justify-center">
          <Link
            href={FAB_HREF}
            aria-label="議事録をつくる"
            className="-translate-y-4 inline-flex items-center justify-center w-14 h-14 rounded-full bg-gizirotto-blue-700 text-white shadow-lg hover:bg-gizirotto-blue-800"
          >
            <PlusIcon />
          </Link>
        </div>

        <Link
          href="/settings"
          aria-current={settingsActive ? 'page' : undefined}
          className={`flex flex-col items-center justify-center gap-0.5 py-2.5 min-h-[64px] text-[11px] ${
            settingsActive
              ? 'text-gizirotto-blue-700'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <SettingsIcon active={settingsActive} />
          <span>設定</span>
        </Link>
      </div>
    </nav>
  )
}

function HomeIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? '#3E6FAA' : 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12L12 3l9 9" />
      <path d="M5 10v10h14V10" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function TemplateIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? '#3E6FAA' : 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="21" x2="9" y2="9" />
    </svg>
  )
}

function MembersIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? '#3E6FAA' : 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function SettingsIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? '#3E6FAA' : 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
