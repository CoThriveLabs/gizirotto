'use client'

import { useEffect, useState } from 'react'
import type React from 'react'

/**
 * フローティングウィジェットが等倍（scale=1）で 3カラムを横並びに収めるのに必要な実効幅(px)。
 * dense レイアウト実測: 位置グリッド(40*3+4*2≈128) + gap24 + 大きさ列(幅ラベル+ボタン2≈28+40*2+gap≈76)
 * + gap24 + そろえる列(中央寄せボタン・分割/削除 縦積み≈110) ＝ 約 470px。
 * これより狭い幅では scale = width / BASE_WIDTH で連続縮小し、折り返しを防ぐ。
 */
const FLOATING_BASE_WIDTH_PX = 470

/** ウィジェットが受け取った実効幅(px)から 3カラム維持用スケール係数を算出（下限 0.5・上限 1）。 */
function widthToScale(effectiveWidth: number): number {
  const s = effectiveWidth / FLOATING_BASE_WIDTH_PX
  return Math.max(0.5, Math.min(1, s))
}

/**
 * フローティングウィジェットの外殻（タブレット実機FB で統一）。
 *
 * 2系統に分岐:
 *   - md 未満（スマホ）= 画面**下部中央**バー。横幅を PDF 実表示幅(pdfWidth) に追従させ、
 *     PDF と中央で同幅に縦並び。幅に応じて 3カラム（位置｜大きさ｜そろえる）を連続スケールで折り返さず
 *     維持。ズームバー（bottom-2）直上の bottom-14。
 *   - タブレット＋PC（>= md）= 右固定パネルに集約＝本殻は md:hidden で非表示
 *     （実機FB 再修正: 640〜1024px で下部バーがズームバーと被る不便を解消）。
 *
 * renderBody(scale) で本体を受け取り、幅追従スケールを与えて描画する。
 */
export function FloatingShell({
  renderBody,
  pdfWidth,
}: {
  renderBody: (scale: number) => React.ReactNode
  pdfWidth: number | null
}) {
  // ビューポート幅（下部バーの PDF 幅追従クランプ用）。リサイズに追従。
  const [viewport, setViewport] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  })
  useEffect(() => {
    const update = () =>
      setViewport({ w: window.innerWidth, h: window.innerHeight })
    update()
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
    }
  }, [])

  // スマホ下部バー: PDF 幅に追従（横余白 24px 控除でクランプ）。幅から 3カラム維持スケールを算出。
  const phoneEffectiveWidth =
    pdfWidth && pdfWidth > 0
      ? Math.min(pdfWidth, viewport.w > 0 ? viewport.w - 24 : pdfWidth)
      : FLOATING_BASE_WIDTH_PX
  const phoneScale = widthToScale(phoneEffectiveWidth - 20) // 内側パディング(px-2.5*2=20)控除
  const phoneWidthStyle =
    pdfWidth && pdfWidth > 0
      ? { width: `min(${Math.round(pdfWidth)}px, calc(100vw - 24px))` }
      : undefined

  return (
    <>
      {/* md 未満（スマホ）: 下部中央バー・PDF 幅追従・幅追従スケール。
          実機FB 再修正: 640〜1024px のタブレットは下部バーがズームバーと位置/大きさで被って不便と
          判明したため、md(768px) 以上は PC と同じ右固定パネルへ集約。下部バーは md 未満のみ。 */}
      <div className="md:hidden fixed inset-x-0 bottom-14 z-30 flex justify-center px-3 pointer-events-none">
        <div
          className="pointer-events-auto bg-white/95 border border-gray-200 rounded-lg px-2.5 py-2 shadow-lg max-h-[50vh] overflow-y-auto"
          style={phoneWidthStyle}
        >
          {renderBody(phoneScale)}
        </div>
      </div>
    </>
  )
}
