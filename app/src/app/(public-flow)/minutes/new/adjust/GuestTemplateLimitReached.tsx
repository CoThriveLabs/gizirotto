import Link from 'next/link'

interface Props {
  /** guestTemplateLimit.limit() の reset（epoch ms）。 */
  resetAt: number
}

/**
 * guestTemplateLimit（IPベース・既定 2 回/90 日）到達時に guest adjust route が表示する画面。
 * ログインすれば制限なく続けられることを案内するだけのシンプルな画面。
 */
export function GuestTemplateLimitReached({ resetAt }: Props) {
  const resetLabel = Number.isFinite(resetAt)
    ? new Date(resetAt).toLocaleDateString('ja-JP')
    : null

  return (
    <div className="max-w-md mx-auto px-4 py-12 text-center space-y-4">
      <h1 className="text-xl font-serif text-gizirotto-blue-900">
        テンプレ試用の上限に達しました
      </h1>
      <p className="text-sm text-gray-600">
        ログインすると引き続きご利用いただけます。
      </p>
      {resetLabel && (
        <p className="text-xs text-gray-400">{resetLabel} 頃にリセットされます</p>
      )}
      <Link
        href="/login"
        className="inline-flex items-center justify-center rounded bg-gizirotto-blue-700 text-white px-5 py-2 text-sm hover:bg-gizirotto-blue-800"
      >
        ログインする
      </Link>
    </div>
  )
}
