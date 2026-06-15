'use client'

/**
 * 「この枠を削除」ボタン（グループB Phase B-2）。
 * 選択中のみ親が描画する。最後の1枠（canDelete=false）は disabled＋理由を表示。
 * 確認ダイアログは出さず即削除（保存まで DB 不変・undo 1段あり）。
 */
export function DeleteFieldButton({
  onDelete,
  canDelete,
  small = false,
  scale = 1,
}: {
  onDelete: () => void
  canDelete: boolean
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
          // isFreshClick ガードは外す（削除1回目を弾いて「2回押し」になる不具合の解消）。
          // 削除は即削除＝誤爆実害が軽く undo で戻せるため 1回押しで確実に消す。誤爆ガードは分割のみ残置。
          onDelete()
        }}
        disabled={!canDelete}
        title={canDelete ? undefined : '最後の枠は削除できません'}
        style={style}
        className={
          'w-full px-4 rounded border border-red-200 bg-white text-red-700 text-sm font-medium select-none disabled:opacity-40 disabled:cursor-not-allowed hover:bg-red-50 active:bg-red-100 ' +
          (scaled ? '' : small ? 'h-10' : 'h-11')
        }
      >
        この枠を削除
      </button>
      {!canDelete && (
        <p className="text-xs text-gray-500 mt-1">最後の枠は削除できません</p>
      )}
    </div>
  )
}
