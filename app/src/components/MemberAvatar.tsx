/**
 * 家族メンバー用アバター。
 *
 * 共通仕様（ホームヘッダー / /members 自分セクション / 他メンバーリスト で統一）:
 * - 円背景: 薄ブルー (#E0EBF5 相当の gizirotto-blue-100)
 * - 文字色: 濃ブルー (gizirotto-blue-700)
 * - 中央寄せ + 多バイト文字対応の頭 1 文字
 * - 空 displayName 時は `●` プレースホルダ
 */

const SIZE_CLASSES = {
  sm: 'w-9 h-9 text-sm',
  md: 'w-14 h-14 text-xl',
  lg: 'w-20 h-20 text-2xl',
} as const

export type MemberAvatarSize = keyof typeof SIZE_CLASSES

export function MemberAvatar({
  displayName,
  size = 'sm',
  className,
}: {
  displayName: string
  size?: MemberAvatarSize
  className?: string
}) {
  const initial = displayName ? Array.from(displayName)[0] : ''
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center rounded-full bg-gizirotto-blue-100 text-gizirotto-blue-700 font-serif select-none ${SIZE_CLASSES[size]} ${className ?? ''}`}
    >
      {initial || '●'}
    </span>
  )
}
