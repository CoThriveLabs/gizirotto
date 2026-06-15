'use client'

/**
 * 1px 微調整 UI（G2-1 設計書 v0.2 §2-3 / Q7）。
 *
 * 移動 4 ボタン（上下左右）＋ サイズ 4 ボタン（幅 ±・高さ ±）を PC/スマホ共通で常設。
 * 「1px」は元画像 px 基準（=stepPt）。実際の pt 加減算は親（editor-client）が行い、
 * ここは「どの操作か」を onNudge で通知するだけ。未選択時はグレーアウト（disabled）。
 *
 * スマホはキーボード矢印が無いためボタン必須。長押しリピート（連続 1px）も提供する。
 */
import { useEffect, useRef } from 'react'

export type NudgeAction =
  | 'move-up'
  | 'move-down'
  | 'move-left'
  | 'move-right'
  | 'w-plus'
  | 'w-minus'
  | 'h-plus'
  | 'h-minus'

interface Props {
  disabled: boolean
  onNudge: (action: NudgeAction) => void
  /** ⑤中央寄せ（水平センタリング・PY2-1）。選択中のみ活性。 */
  onCenter?: () => void
  /**
   * 段階2 Phase 2-D（実機FB・レイアウト改善）: コンパクト表示。
   * true で位置/大きさ/そろえる を**縦積み**にし、ボタン/フォントも一回り小さくして
   * 縦の高さを詰める（PC 右固定パネル・狭い右カラム向け）。
   * 機能・onNudge/onCenter の挙動は無改変（見た目のみ）。省略時 false＝従来の横並び。
   */
  compact?: boolean
  /**
   * 段階2 Phase 2-D 修正（実機FB）: dense＝3カラム横並びは維持しつつボタン/間隔だけ一回り小さく。
   * フロート（<lg 下部バー / タブレット近傍）で縦を詰めるために使う（compact の縦積みとは別）。
   * compact=true 指定時は dense は無視（縦積み優先）。省略時 false。
   */
  dense?: boolean
  /**
   * 微調整4点・指示1（実機FB）: ウィジェット幅追従スケール係数（0〜1・dense 時のみ有効）。
   * ズーム縮小でウィジェット幅(=PDF幅)が狭くなっても 3カラム（位置｜大きさ｜そろえる）を
   * **折り返さず横並び維持**するため、ボタン寸法・gap・フォント・アイコンをこの係数で連続縮小する。
   * 親（FloatingShell）が pdfWidth から算出して渡す。省略/1 で等倍。compact（縦積み）では無視。
   */
  scale?: number
  /**
   * 段階2 Phase 2-D 修正（実機FB・案A）: 「そろえる」列（中央寄せボタン）の**下に縦にぶら下げる**
   * 追加ノード。分割/削除ボタンをここへ渡し、第3カラム内に縦配置して縦を詰める。
   * （従来は NudgeControls の外＝全幅で縦積みされ「中央寄せの下」になっていなかった不具合を解消）。
   */
  extra?: React.ReactNode
  /**
   * C-2 v1.3 §3-2-4（A4）: 「大きさ（1px ずつ）」列を隠す。固定テキストモード専用。
   * 固定テキストは大きさ＝bbox の 4 隅ドラッグに一本化し、サイズ ±/数値入力 UI を持たない。
   * 省略時 false＝従来どおり大きさ列を表示（記入欄・白塗りモードは無改修）。
   */
  hideSize?: boolean
  /**
   * 段階 2-D2 v2.3 §1-1-0-B 案 B: 第2列「大きさ」のスロット差替え。
   * 省略時は従来の幅±/高さ±（templates 編集モード無改修）。
   * 指定時はその ReactNode を第2列の中身として描画する（AdjustView の fontSize UI 用）。
   * hideSize=true と同時指定された場合は hideSize が優先される（列ごと消える）。
   */
  sizeSlot?: React.ReactNode
}

/** 長押しでリピート発火するボタン。初回押下で 1 回、押し続けで連続 1px。 */
function RepeatButton({
  label,
  ariaLabel,
  disabled,
  onFire,
  small = false,
  sizePx,
}: {
  label: React.ReactNode
  ariaLabel: string
  disabled: boolean
  onFire: () => void
  /** 一回り小さいボタン（compact 縦積み or dense 横並び・実機FB）。 */
  small?: boolean
  /** 微調整4点・指示1: ピクセル正方サイズ（幅追従スケール時）。指定時は small クラスより優先。 */
  sizePx?: number
}) {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onFireRef = useRef(onFire)
  onFireRef.current = onFire

  const stop = () => {
    if (delayRef.current) clearTimeout(delayRef.current)
    if (timerRef.current) clearInterval(timerRef.current)
    delayRef.current = null
    timerRef.current = null
  }

  useEffect(() => stop, [])

  const start = (e: React.PointerEvent) => {
    if (disabled) return
    e.preventDefault()
    onFireRef.current() // 初回即時
    // 400ms 後にリピート開始、以後 60ms ごと。
    delayRef.current = setTimeout(() => {
      timerRef.current = setInterval(() => onFireRef.current(), 60)
    }, 400)
  }

  // small（compact/dense）は一回り小さく（w-10 h-10）。通常はタッチ確保の w-11 h-11 据置。
  // sizePx 指定時（幅追従スケール）はクラス寸法を上書きしピクセルで連続可変にする。
  const sizeCls = sizePx != null ? '' : small ? 'w-10 h-10' : 'w-11 h-11'
  const sizeStyle =
    sizePx != null
      ? { width: sizePx, height: sizePx, fontSize: Math.max(11, sizePx * 0.36) }
      : undefined
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      style={sizeStyle}
      className={
        'flex items-center justify-center rounded border border-gizirotto-blue-200 bg-white text-gizirotto-blue-900 text-sm font-medium select-none touch-none disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gizirotto-blue-50 active:bg-gizirotto-blue-100 ' +
        sizeCls
      }
    >
      {label}
    </button>
  )
}

export default function NudgeControls({
  disabled,
  onNudge,
  onCenter,
  compact = false,
  dense = false,
  scale = 1,
  extra,
  hideSize = false,
  sizeSlot,
}: Props) {
  // 段階2 Phase 2-D: compact＝縦積み（PC 右固定パネル）。それ以外（dense 含む）は3カラム横並び。
  //   dense は横並びのままボタン/間隔だけ縮小（フロートの縦圧縮・実機FB）。
  const small = compact || dense

  // 微調整4点・指示1: dense（フロート）時はウィジェット幅追従で連続スケールし、3カラムが
  //   どのズーム/幅でも横並びを維持（折り返さない）。compact（縦積み）と等倍時は従来クラス制御。
  const scaled = dense && scale < 1
  const btnPx = Math.round(40 * scale) // dense 基準のボタン40px を係数で縮小
  const colGapPx = Math.round(24 * scale) // 3カラム間 gap（基準24px）
  const labelFontPx = Math.max(9, Math.round(12 * scale)) // ラベル文字（基準12px=text-xs）
  const sizePx = scaled ? btnPx : undefined
  const arrowPx = scaled ? Math.max(10, Math.round(btnPx * 0.4)) : 16

  // 微調整4点・指示1/2: フロート（dense）/通常横並びとも 折り返し禁止（flex-nowrap）＋
  //   中央揃え（justify-center）。compact は従来どおり縦積み（左揃え）。
  const wrapCls = compact
    ? 'flex flex-col items-start gap-3'
    : 'flex flex-nowrap justify-center items-start'
  // dense の列間 gap は scale 連動（style）。非 dense は従来の gap-6 相当を style で。
  const wrapStyle = compact
    ? undefined
    : { gap: dense ? colGapPx : 24 }
  // dense+scale 時のグリッド幅 = ボタン3個＋gap2個（grid 内 gap は 4px 相当を縮小）。
  const gridGapPx = scaled ? Math.max(2, Math.round(4 * scale)) : 4
  const gridWStyle = scaled
    ? { width: btnPx * 3 + gridGapPx * 2 }
    : undefined
  const gridWCls = scaled ? '' : small ? 'w-[128px]' : 'w-[140px]'
  const labelStyle = scaled ? { fontSize: labelFontPx } : undefined
  return (
    <div className={wrapCls} style={wrapStyle}>
      <div>
        <p className="text-xs text-gray-500 mb-1" style={labelStyle}>
          位置（1px ずつ）
        </p>
        {/* 十字配置: 上 / 左右 / 下（PY2-3 図どおり・据置） */}
        <div
          className={'grid grid-cols-3 grid-rows-3 ' + gridWCls}
          style={scaled ? { ...gridWStyle, gap: gridGapPx } : { gap: 4 }}
        >
          <span />
          <RepeatButton
            label={<ArrowIcon dir="up" sizePx={arrowPx} />}
            ariaLabel="上へ 1px"
            disabled={disabled}
            onFire={() => onNudge('move-up')}
            small={small}
            sizePx={sizePx}
          />
          <span />
          <RepeatButton
            label={<ArrowIcon dir="left" sizePx={arrowPx} />}
            ariaLabel="左へ 1px"
            disabled={disabled}
            onFire={() => onNudge('move-left')}
            small={small}
            sizePx={sizePx}
          />
          <span />
          <RepeatButton
            label={<ArrowIcon dir="right" sizePx={arrowPx} />}
            ariaLabel="右へ 1px"
            disabled={disabled}
            onFire={() => onNudge('move-right')}
            small={small}
            sizePx={sizePx}
          />
          <span />
          <RepeatButton
            label={<ArrowIcon dir="down" sizePx={arrowPx} />}
            ariaLabel="下へ 1px"
            disabled={disabled}
            onFire={() => onNudge('move-down')}
            small={small}
            sizePx={sizePx}
          />
          <span />
        </div>
      </div>

      {/* C-2 v1.3 §3-2-4（A4）: 固定テキストモードは「大きさ」列を撤去（大きさ＝4隅ドラッグに一本化）。
          段階 2-D2 v2.3 §1-1-0-B 案 B: sizeSlot 指定時はその ReactNode を第2列に差替え（AdjustView fontSize UI 用）。 */}
      {!hideSize && sizeSlot !== undefined && sizeSlot}
      {!hideSize && sizeSlot === undefined && (
        <div>
          <p className="text-xs text-gray-500 mb-1" style={labelStyle}>
            大きさ（1px ずつ）
          </p>
          {/* PY2-3 図どおり: 行＝ラベル＋[−][+] 横並び（幅／高さの2行）。 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: gridGapPx }}>
            <div className="flex items-center" style={{ gap: gridGapPx }}>
              <span
                className="text-sm text-gray-700 text-right pr-1 whitespace-nowrap shrink-0"
                style={scaled ? { fontSize: labelFontPx, width: labelFontPx * 2 + 10 } : { width: '2.25rem' }}
              >
                幅
              </span>
              <RepeatButton
                label="−"
                ariaLabel="幅を 1px 縮める"
                disabled={disabled}
                onFire={() => onNudge('w-minus')}
                small={small}
                sizePx={sizePx}
              />
              <RepeatButton
                label="＋"
                ariaLabel="幅を 1px 広げる"
                disabled={disabled}
                onFire={() => onNudge('w-plus')}
                small={small}
                sizePx={sizePx}
              />
            </div>
            <div className="flex items-center" style={{ gap: gridGapPx }}>
              <span
                className="text-sm text-gray-700 text-right pr-1 whitespace-nowrap shrink-0"
                style={scaled ? { fontSize: labelFontPx, width: labelFontPx * 2 + 10 } : { width: '2.25rem' }}
              >
                高さ
              </span>
              <RepeatButton
                label="−"
                ariaLabel="高さを 1px 縮める"
                disabled={disabled}
                onFire={() => onNudge('h-minus')}
                small={small}
                sizePx={sizePx}
              />
              <RepeatButton
                label="＋"
                ariaLabel="高さを 1px 広げる"
                disabled={disabled}
                onFire={() => onNudge('h-plus')}
                small={small}
                sizePx={sizePx}
              />
            </div>
          </div>
        </div>
      )}

      {/* ⑤そろえる列（中央寄せ・選択中のみ活性・PY2-1）。
          段階2 Phase 2-D 修正（案A）: この列の下に extra（分割/削除）を縦にぶら下げて縦を詰める。
          微調整4点・指示3: 「そろえる」列ラベルは削除（位置/大きさラベルは残す）。 */}
      {(onCenter || extra) && (
        <div
          className="flex flex-col items-stretch"
          style={{ gap: scaled ? Math.max(4, Math.round(8 * scale)) : 8 }}
        >
          {onCenter && (
            <div>
              {/* 指示3: ラベル文字は削除。ただし他列（位置/大きさ）のラベル行ぶんの高さを
                  空要素で確保し、中央寄せボタンの上端を他列のボタン上端に揃える。 */}
              <p className="text-xs mb-1" aria-hidden="true" style={labelStyle}>
                &nbsp;
              </p>
              <button
                type="button"
                disabled={disabled}
                onClick={onCenter}
                style={
                  scaled
                    ? { height: btnPx, fontSize: Math.max(10, Math.round(btnPx * 0.34)) }
                    : undefined
                }
                className={
                  'w-full px-3 rounded border border-gizirotto-blue-200 bg-white text-gizirotto-blue-900 text-sm font-medium select-none disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gizirotto-blue-50 active:bg-gizirotto-blue-100 ' +
                  (scaled ? '' : small ? 'h-10' : 'h-11')
                }
              >
                中央寄せ
              </button>
            </div>
          )}
          {extra}
        </div>
      )}
    </div>
  )
}

function ArrowIcon({
  dir,
  sizePx = 16,
}: {
  dir: 'up' | 'down' | 'left' | 'right'
  /** 微調整4点・指示1: 幅追従スケール時のアイコン px。 */
  sizePx?: number
}) {
  const rotate = { up: 0, right: 90, down: 180, left: 270 }[dir]
  return (
    <svg
      width={sizePx}
      height={sizePx}
      viewBox="0 0 16 16"
      fill="none"
      style={{ transform: `rotate(${rotate}deg)` }}
      aria-hidden="true"
    >
      <path
        d="M8 3 L8 13 M8 3 L4 7 M8 3 L12 7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
