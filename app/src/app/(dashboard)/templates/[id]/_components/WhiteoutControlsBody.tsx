'use client'

import NudgeControls, { type NudgeAction } from '../nudge-controls'

/**
 * 白塗りの操作 body（段階2 Phase 2-D 修正・案A）。
 *
 * 移動/中央寄せ（NudgeControls 共用）＋「そろえる」列下に「この白塗りを削除」を extra で縦配置。
 * 修正（実機FB・指示2/5）: auto候補の「採用/却下トグル」は**廃止**し、auto/manual 問わず
 * 「削除」に統一（state から除去＝保存 whiteout-apply の焼き込み対象外）。whiteout-modal は無改変。
 *   - compact=true（PC 右パネル）: 縦積み。 dense=true（フロート <lg）: 3カラム横並びで縮小。
 */
export function WhiteoutControlsBody({
  onNudge,
  onCenter,
  onDelete,
  compact = false,
  dense = false,
  scale = 1,
}: {
  onNudge: (action: NudgeAction) => void
  onCenter: () => void
  onDelete: () => void
  compact?: boolean
  dense?: boolean
  /** 幅追従スケール係数（0〜1）。 */
  scale?: number
}) {
  const small = compact || dense
  // dense+縮小時は削除ボタンも連続スケール（h-10/11 を px 上書き）。
  const scaled = dense && scale < 1
  const btnPx = Math.round(40 * scale)
  const delStyle = scaled
    ? { height: btnPx, fontSize: Math.max(10, Math.round(btnPx * 0.34)) }
    : undefined
  return (
    <NudgeControls
      disabled={false}
      onNudge={onNudge}
      onCenter={onCenter}
      compact={compact}
      dense={dense}
      scale={scale}
      extra={
        <div>
          {/* isFreshClick ガードは外す（削除の1回目クリックを弾いて「2回押し」になる不具合）。
              削除は確認モーダル無しの即削除＝誤爆実害が軽く undo で戻せるため、1回押しで確実に消す。
              出現直後の合成 click 誤爆ガードは「分割」ボタンだけに残す（命名パネルが開く誤爆は重い）。 */}
          <button
            type="button"
            onClick={() => {
              onDelete()
            }}
            style={delStyle}
            className={
              'w-full px-4 rounded border border-red-200 bg-white text-red-700 text-sm font-medium select-none hover:bg-red-50 active:bg-red-100 ' +
              (scaled ? '' : small ? 'h-10' : 'h-11')
            }
          >
            この白塗りを削除
          </button>
        </div>
      }
    />
  )
}
