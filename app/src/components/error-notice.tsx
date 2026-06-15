'use client'

/**
 * エラー表示の共通プレゼンテーション。
 *
 * 生のエラーコード/メッセージ文字列を受け取り、humanizeErrorCode で素人向け日本語へ写して主表示する。
 * 詳細折りたたみには「エラーコード」だけを出す（🚨 detail/status 等の生メッセージは出さない＝
 * Supabase メッセージ・内部パス・個人情報の漏洩防止）。表示層のみ。
 */

import { humanizeErrorCode } from '@/lib/errors/user-message'

interface Props {
  /** 生のエラーコード or メッセージ文字列（サーバ `Error(CODE)` / API `{error}` / 合成文字列）。 */
  code: string | null | undefined
  /** 主表示文の前置き（例:「読み込みに失敗しました」）。省略可。 */
  prefix?: string
  /** 追加 className（レイアウト調整用）。 */
  className?: string
}

export default function ErrorNotice({ code, prefix, className }: Props) {
  if (!code) return null
  const { message, rawCode } = humanizeErrorCode(code)
  return (
    <div
      className={
        'text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3 ' +
        (className ?? '')
      }
    >
      <p>{prefix ? `${prefix}: ${message}` : message}</p>
      <details className="mt-1">
        <summary className="text-xs text-red-600 cursor-pointer select-none">
          詳細を表示
        </summary>
        <p className="mt-1 text-xs text-red-600">エラーコード: {rawCode}</p>
      </details>
    </div>
  )
}
