'use client'

/**
 * ヘッダー右上アバターをトリガーとするアカウントメニュー。
 *
 * - 通常項目: 家族メンバー / 設定（Link 遷移）
 * - ログアウト: その場で LogoutConfirmModal を起動
 * - 退会はこちらから: /settings#delete-account へ遷移（設定画面で熟考導線）
 *
 * a11y:
 *   - トリガー: aria-haspopup="menu" / aria-expanded
 *   - パネル: role="menu" / aria-label
 *   - 項目: role="menuitem"
 *   - Esc 閉じ + トリガーへ focus 戻す
 *   - 外側クリック (pointerdown) で閉じる
 *   - panel 内クリックは閉じない (event.target を panelRef.contains で判定)
 */

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MemberAvatar } from '@/components/MemberAvatar'
import { LogoutConfirmModal } from '@/app/(dashboard)/settings/_components/LogoutConfirmModal'

export interface HeaderAccountMenuProps {
  /** アバターに表示する名前 */
  displayName: string
  /** 家族名（v2 でパネル内表示用に予約・v1 未使用） */
  familyName?: string
}

export function HeaderAccountMenu({ displayName }: HeaderAccountMenuProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [logoutModalOpen, setLogoutModalOpen] = useState(false)
  const [logoutLoading, setLogoutLoading] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // 外側 pointerdown でパネルを閉じる。トリガー自身のクリックはトグル処理側で扱うので除外。
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null
      if (target && panelRef.current?.contains(target)) return
      if (target && triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Esc 閉じ + トリガーへ focus を戻す (a11y)
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  function openLogoutModal() {
    setOpen(false)
    setLogoutError(null)
    setLogoutModalOpen(true)
  }

  function cancelLogout() {
    setLogoutModalOpen(false)
    setLogoutError(null)
  }

  async function handleLogoutConfirm() {
    setLogoutError(null)
    setLogoutLoading(true)
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' })
      if (!res.ok && res.status !== 401) throw new Error('LOGOUT_FAILED')
      // cookie 削除後の SSR 反映のため push + refresh をセットで呼ぶ
      router.push('/')
      router.refresh()
    } catch {
      setLogoutError('ログアウトに失敗しました。もう一度お試しください。')
      setLogoutLoading(false)
    }
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={displayName ? `${displayName} のアカウントメニューを開く` : 'アカウントメニューを開く'}
        className="rounded-full hover:opacity-80 shrink-0 focus:outline-none focus:ring-2 focus:ring-gizirotto-blue-300"
      >
        <MemberAvatar displayName={displayName} size="sm" />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label="アカウントメニュー"
          className="absolute right-0 top-full mt-2 w-56 max-w-[calc(100vw-1rem)] rounded-lg border border-gizirotto-blue-100 bg-white shadow-lg z-40 overflow-hidden"
        >
          <Link
            href="/members"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-sm text-gray-800 hover:bg-gizirotto-blue-50"
          >
            家族メンバー
          </Link>
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-sm text-gray-800 hover:bg-gizirotto-blue-50"
          >
            設定
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={openLogoutModal}
            className="block w-full text-left px-4 py-2.5 text-sm text-gray-800 hover:bg-gizirotto-blue-50"
          >
            ログアウト
          </button>
          <Link
            href="/settings#delete-account"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-sm text-red-700 hover:bg-red-50 border-t border-gray-100"
          >
            退会はこちらから
          </Link>
        </div>
      )}

      <LogoutConfirmModal
        open={logoutModalOpen}
        onConfirm={handleLogoutConfirm}
        onCancel={cancelLogout}
        loading={logoutLoading}
        error={logoutError}
      />
    </div>
  )
}
