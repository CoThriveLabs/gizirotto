'use client'

/**
 * 戻る / 進む 矢印アイコン（Phase 4 共通化）。
 *
 * bbox-editor-client.tsx L2312-2339 / AdjustView.tsx L2521-2547 は完全一致。
 * 差分ゼロのため props 化不要。
 */
export function UndoArrow({ dir }: { dir: 'back' | 'forward' }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={dir === 'forward' ? { transform: 'scaleX(-1)' } : undefined}
    >
      {/* 左向きの戻る矢印（forward は水平反転で右向き）。 */}
      <path
        d="M9 7 L4 12 L9 17"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 12 H14 a6 6 0 0 1 6 6 v1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
