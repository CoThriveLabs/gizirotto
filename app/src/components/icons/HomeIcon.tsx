/**
 * ホームアイコン（オリジナル SVG）。
 * - Co-Thrive Labs ブランドカラー（朝霧ブルー）に合わせた線画。
 * - 24x24 viewBox / stroke-width 2 / currentColor 継承で親の text-color を反映。
 */
export function HomeIcon({
  size = 18,
  className,
}: {
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M3 12L12 3l9 9" />
      <path d="M5 10v10h14V10" />
      <path d="M10 20v-5h4v5" />
    </svg>
  )
}
