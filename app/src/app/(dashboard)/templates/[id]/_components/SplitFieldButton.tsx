'use client'

/**
 * 「縦に2分割」ボタン（グループB Phase B-4）。
 * 選択中のみ親が描画する。件数 19 以上・最小幅未満（canSplit=false）は disabled＋理由表示。
 * 押下で選択枠（本命＝部署＋氏名）を中央左右2枠に割り、2枠命名パネルを開く。
 */
export function SplitFieldButton({
  onSplit,
  canSplit,
  disabledReason,
  isFreshClick,
  small = false,
  scale = 1,
}: {
  onSplit: () => void
  canSplit: boolean
  disabledReason?: string
  /** ウィジェット出現直後の合成 click を弾く（誤分割防止）。 */
  isFreshClick: () => boolean
  /** 一回り小さく（compact/dense・実機FB）。「そろえる」列内に縦配置されるため w-full で列幅に揃える。 */
  small?: boolean
  /** 幅追従スケール（dense フロートのみ <1）。 */
  scale?: number
}) {
  const scaled = scale < 1
  const btnPx = Math.round(40 * scale)
  const style = scaled
    ? { height: btnPx, fontSize: Math.max(10, Math.round(btnPx * 0.34)) }
    : undefined
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          // 出現/再配置直後の合成 click は選択クリックの貫通なので無視（誤分割防止）。
          if (isFreshClick()) return
          onSplit()
        }}
        disabled={!canSplit}
        title={canSplit ? undefined : disabledReason}
        style={style}
        className={
          'w-full px-4 rounded border border-gizirotto-blue-300 bg-white text-gizirotto-blue-700 text-sm font-medium select-none disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gizirotto-blue-500/10 active:bg-gizirotto-blue-500/20 ' +
          (scaled ? '' : small ? 'h-10' : 'h-11')
        }
      >
        縦に2分割
      </button>
      {!canSplit && disabledReason && (
        <p className="text-xs text-gray-500 mt-1">{disabledReason}</p>
      )}
    </div>
  )
}
