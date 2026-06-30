'use client'

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { PasswordInput } from '@/components/PasswordInput'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { deleteMyAccount, previewDeleteCase } from '@/server/account'

type CaseId = 'A' | 'B' | 'C'

interface State {
  status: 'loading' | 'ready' | 'submitting' | 'error'
  caseId: CaseId | null
  familyName: string | null
  hasPassword: boolean
  errorMsg: string | null
}

/**
 * 退会確認モーダル。
 * mount 時に previewDeleteCase でケース判定 → A/C は確認入力 → 削除実行。
 * B は削除ボタン非表示で /members への昇格導線のみ。
 *
 * Why ハードリロード:
 *   削除完了後は router.push ではなく window.location.href = '/' で完全リロード。
 *   全 client state を flush し、不可逆操作の挙動を防御深層にする。
 */
export function DeleteAccountModal({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstFocusableRef = useRef<HTMLButtonElement>(null)

  const [state, setState] = useState<State>({
    status: 'loading',
    caseId: null,
    familyName: null,
    hasPassword: false,
    errorMsg: null,
  })
  const [confirmText, setConfirmText] = useState('')
  const [password, setPassword] = useState('')

  // mount でケース判定
  useEffect(() => {
    let mounted = true
    void (async () => {
      const res = await previewDeleteCase()
      if (!mounted) return
      if (!res.ok) {
        setState((s) => ({
          ...s,
          status: 'error',
          errorMsg:
            res.code === 'UNAUTHENTICATED'
              ? '認証が切れています。再度ログインしてください。'
              : res.code === 'NOT_IN_FAMILY'
                ? '家族に所属していません。'
                : '情報の取得に失敗しました。',
        }))
        return
      }
      setState({
        status: 'ready',
        caseId: res.case,
        familyName: res.familyName,
        hasPassword: res.hasPassword,
        errorMsg: null,
      })
    })()
    return () => {
      mounted = false
    }
  }, [])

  // Esc で閉じる
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // mount 時に最初の focusable へ
  useEffect(() => {
    firstFocusableRef.current?.focus()
  }, [])

  const submitDisabled =
    state.status === 'submitting' ||
    state.status === 'loading' ||
    state.caseId === 'B' ||
    confirmText !== 'DELETE' ||
    (state.hasPassword && password.length === 0)

  async function handleDelete() {
    if (submitDisabled) return
    setState((s) => ({ ...s, status: 'submitting', errorMsg: null }))
    const res = await deleteMyAccount({
      confirmText,
      password: state.hasPassword ? password : undefined,
    })
    if (res.ok) {
      try {
        const sb = createSupabaseBrowserClient()
        await sb.auth.signOut()
      } catch {
        // best-effort: cookie 自体は auth.admin.deleteUser 直後に invalid 化されている
      }
      window.location.href = '/'
      return
    }
    if (res.code === 'SOLE_ADMIN_BLOCKED') {
      // 念のためサーバ再判定で B 判定に変わった場合のフォールバック
      setState((s) => ({
        ...s,
        status: 'ready',
        caseId: 'B',
        errorMsg: null,
      }))
      return
    }
    const msg =
      res.code === 'WRONG_PASSWORD'
        ? 'パスワードが違います。'
        : res.code === 'CONFIRM_TEXT_MISMATCH'
          ? '「DELETE」と入力してください。'
          : res.code === 'STORAGE_DELETE_FAILED'
            ? 'ストレージの削除に失敗しました。時間をおいて再度お試しください。'
            : res.code === 'AUTH_DELETE_FAILED'
              ? 'アカウント削除の最終段階で失敗しました。再度お試しください。'
              : '削除中にエラーが発生しました。もう一度お試しください。'
    setState((s) => ({ ...s, status: 'error', errorMsg: msg }))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        ref={dialogRef}
        className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto"
      >
        <div className="p-6 space-y-4">
          <h2
            id={titleId}
            className="text-lg font-serif text-red-700"
          >
            アカウントを完全に削除
          </h2>

          {state.status === 'loading' && (
            <p className="text-sm text-gray-600">読み込み中…</p>
          )}

          {state.status !== 'loading' && state.caseId === 'A' && (
            <CaseAContent familyName={state.familyName} />
          )}
          {state.status !== 'loading' && state.caseId === 'B' && <CaseBContent />}
          {state.status !== 'loading' && state.caseId === 'C' && <CaseCContent />}

          {state.caseId !== 'B' && state.status !== 'loading' && (
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="block mb-1 text-gray-700">
                  確認のため <span className="font-mono font-bold">DELETE</span>{' '}
                  と入力してください
                </span>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  aria-label="確認のため DELETE と入力"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-base font-mono"
                  autoComplete="off"
                />
              </label>

              {state.hasPassword && (
                <label className="block text-sm">
                  <span className="block mb-1 text-gray-700">パスワード</span>
                  <PasswordInput
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    aria-label="現在のパスワード"
                  />
                </label>
              )}
            </div>
          )}

          {state.errorMsg && (
            <p className="text-red-600 text-sm" role="alert">
              {state.errorMsg}
            </p>
          )}

          <div className="flex flex-col gap-2 pt-2">
            {state.caseId === 'B' ? (
              <Link
                href="/members"
                className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium px-4 py-2 rounded text-center"
              >
                メンバー一覧へ移動
              </Link>
            ) : (
              <button
                type="button"
                onClick={handleDelete}
                disabled={submitDisabled}
                className="bg-red-600 hover:bg-red-700 text-white font-medium px-4 py-2 rounded disabled:opacity-50"
              >
                {state.status === 'submitting' ? '削除中…' : '削除を実行'}
              </button>
            )}
            <button
              ref={firstFocusableRef}
              type="button"
              onClick={onClose}
              disabled={state.status === 'submitting'}
              className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium px-4 py-2 rounded disabled:opacity-50"
            >
              キャンセル
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CaseAContent({ familyName }: { familyName: string | null }) {
  return (
    <div className="space-y-2 text-sm text-gray-800">
      <p className="font-bold text-red-700">
        あなたが退会すると、家族
        {familyName ? `「${familyName}」` : ''}
        のすべてのデータが完全に削除されます。元に戻せません。
      </p>
      <ul className="list-disc pl-5 space-y-1 text-xs text-gray-700">
        <li>議事録・テンプレ・チャット履歴</li>
        <li>音声ファイル・成果物などすべてのストレージ</li>
        <li>家族設定そのもの</li>
      </ul>
      <p className="text-xs text-gray-600">この操作は取り消せません。</p>
    </div>
  )
}

function CaseBContent() {
  return (
    <div className="space-y-2 text-sm text-gray-800">
      <p>
        管理者があなた 1 人のため、現在アカウントを削除できません。
      </p>
      <p className="text-xs text-gray-600">
        先に他のメンバーを管理者に昇格させてから、再度お試しください。
      </p>
    </div>
  )
}

function CaseCContent() {
  return (
    <div className="space-y-2 text-sm text-gray-800">
      <p>あなたのみ家族から抜けます。家族と他メンバーの議事録は残ります。</p>
      <p className="text-xs text-gray-700">
        あなたの作った議事録・テンプレは家族の他メンバーが引き続き使用できます
        （作成者表記が「（退会済みユーザー）」になります）。
      </p>
      <p className="text-xs text-gray-700">自分のチャット履歴は削除されます。</p>
    </div>
  )
}
