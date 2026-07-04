'use client'

export interface BboxGridOverlayProps {
  dispW: number
  dispH: number
  selCenter: { x: number; y: number } | null
}

/* ④グリッド/中心線オーバーレイ（PY1-4・描画のみ・fields 非破壊）。
   テンプレ中心（薄破線の十字）＋選択青枠中心（青実線の十字）。 */
export default function BboxGridOverlay({ dispW, dispH, selCenter }: BboxGridOverlayProps) {
  return (
    <div className="absolute inset-0 pointer-events-none">
      {/* テンプレ中心: 縦線(left=dispW/2)＋横線(top=dispH/2) */}
      <div
        className="absolute top-0 bottom-0 border-l border-dashed border-gray-400/70"
        style={{ left: dispW / 2 }}
      />
      <div
        className="absolute left-0 right-0 border-t border-dashed border-gray-400/70"
        style={{ top: dispH / 2 }}
      />
      {/* 選択青枠中心: 縦線＋横線（青実線）。中央寄せでテンプレ中心線と重なる。 */}
      {selCenter && (
        <>
          <div
            className="absolute top-0 bottom-0 border-l border-gizirotto-blue-600/80"
            style={{ left: selCenter.x }}
          />
          <div
            className="absolute left-0 right-0 border-t border-gizirotto-blue-600/80"
            style={{ top: selCenter.y }}
          />
        </>
      )}
    </div>
  )
}
