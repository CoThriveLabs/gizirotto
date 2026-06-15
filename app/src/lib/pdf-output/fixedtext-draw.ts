/**
 * 固定テキスト描画の共有純関数（設計書 minutes_fixedtext_output_align_design_2026-06-08 §2-3A / §5-1）。
 *
 * 🚨 C-7 最重要（mistake.md 2026-06-06）: 本ファイルは **サーバ専用ネイティブ依存を一切 import しない
 *   独立した純関数**である。`@napi-rs/canvas` / `pdf-lib` を import してはならない。
 *   ① 編集 canvas（ブラウザ）・② サムネ（@napi-rs/canvas）・③ overlay PDF（pdf-lib）・
 *   ④ image（@napi-rs/canvas）の 4 経路が **全部ここから import** することで、固定テキストの
 *   描画式を 1 本に統一する（WYSIWYG＝ブラウザプレビューと出力の一致）。
 *   幅計測はエンジン依存（canvas measureText / pdf-lib widthOfTextAtSize）なので、本関数は
 *   幅取得をコールバック注入で受け取り、純粋計算（行分割・上端 y・幅オーバー縮小）だけを返す。
 *
 * 固定テキストは記入欄 uniform（fitTextInBox 経路）とは完全に別系統。本関数は uniform 思想
 * （heightRatio / topPad / 末尾省略）を一切持たない。幅オーバーは **縮小のみ**（truncate しない＝
 * 1 文字も欠けない）で、top 揃え・全文表示という WYSIWYG の本質を保つ。
 */

/**
 * 固定テキスト font.size の高さ比（fixedtext-adapter.FIXED_TEXT_FONT_SIZE_RATIO と同値）。
 * 1 行の高さ = fontSize / RATIO。本ファイルにも 1 点だけ持ち、4 経路の行送りを統一する。
 * （adapter は EditorField⇔FixedText 変換用で別責務のため、描画側の正本としてここに置く。
 *  値が乖離すると行送りがずれるため必ず 0.8 で一致させること。）
 */
export const FIXED_TEXT_FONT_SIZE_RATIO = 0.8

/** 幅オーバー縮小時の下限サイズ（読めなくならない最小・②④①の既存式と一致）。 */
export const FIXED_TEXT_DRAW_MIN_SIZE = 6

/** 固定テキストの配置矩形（pt・左上原点）。 */
export interface FixedTextBox {
  x: number
  y: number
  w: number
  /**
   * 矩形高さ（pt・必須）。
   * 縦中央配置の計算に使う（ブロック総高を bbox.h の中央に置く）。
   * 呼出側は元 FixedText.bbox.h（または px 換算済）を必ず渡すこと。
   */
  h: number
}

/** 1 行ぶんの描画指示（pt 基準。px 化は呼出側で sx/sy 乗算）。 */
export interface FixedTextDrawLine {
  /** 描画文字列（空行は除外済＝本配列に現れない）。 */
  text: string
  /** 採用フォントサイズ（pt）。幅オーバーで縮小された場合は元 fontSize 未満。 */
  drawSize: number
  /**
   * 行頭 x（pt）。
   * 横中央配置: `bbox.x + max(0, (bbox.w - metricsW) / 2)`（行ごとに metricsW を実測して個別中央）。
   */
  xPt: number
  /**
   * 行の上端 y（pt）。
   * 縦中央配置: `bbox.y + max(0, (bbox.h - blockH) / 2) + lineIndex * lineHeight`。
   * `blockH = lastLineIndex * lineHeight + fontSize`（最終行の em-box 高さは fontSize で、
   * lineHeight に含まれる descent 余白は除く＝最終行の余白を加算しないことで、
   * 文字の視覚的中心が bbox 中心に来るようにする）。
   */
  topYPt: number
}

/**
 * 固定テキスト 1 要素を行ごとの描画指示に変換する純関数（**bbox 内 縦横中央配置**）。
 *
 * - 行分割: `value.split('\n')`。空行（''）は高さ送りのみ＝出力配列に含めない
 *   （ただし lineIndex は配列添字 i で進むため空行ぶんの送りは保たれる）。
 * - 1 行の高さ: `lineHeight = fontSize / FIXED_TEXT_FONT_SIZE_RATIO`。
 * - **縦中央**: ブロック総高 `blockH = lastIndex * lineHeight + fontSize` を `bbox.h` の中央に置く。
 *   `blockTop = bbox.y + max(0, (bbox.h - blockH) / 2)`、各行 `topYPt = blockTop + i * lineHeight`。
 *   ブロックが bbox.h より大きい場合は上端揃え（負方向にはみ出させない）。
 *   旧式 `(lastIndex + 1) * lineHeight` は最終行の descent 余白（lineHeight - fontSize）を含み、
 *   中央オフセットが下にずれて文字が bbox 上部寄りに見える問題があった（2026-06-14 修正）。
 * - **横中央**: 各行ごとに `metricsW` を再計測し、`xPt = bbox.x + max(0, (bbox.w - metricsW) / 2)`。
 *   行幅が bbox.w を超える場合は左端揃え（負方向にはみ出させない）。
 * - 幅オーバー縮小: `measure(line, fontSize) = metricsW` が `maxW(=bbox.w)` を超えたら
 *   `drawSize = max(FIXED_TEXT_DRAW_MIN_SIZE, fontSize * maxW / metricsW)`。**truncate しない**。
 *   縮小後は実描画幅で再測して中央オフセットを決める。
 *
 * @param value    表示テキスト（`\n` 区切り・呼出側で trim 済前提だが空 value は空配列を返す）
 * @param bbox     配置矩形（pt・左上原点・x/y/w/h すべて使う）
 * @param fontSize 保存 font.size（pt）。縮小の起点。
 * @param measure  幅計測コールバック（エンジン依存）。`(text, size) => width(pt 基準の幅)`。
 *                 ②④ は canvas measureText（px）、③ は pdf-lib widthOfTextAtSize（pt）。
 *                 縮小率 `maxW/metricsW` は同一単位なら正しく算出されるため、measure と maxW の
 *                 単位は呼出側で揃える（px なら maxW も px・pt なら pt）。
 */
export function layoutFixedTextLines(
  value: string,
  bbox: FixedTextBox,
  fontSize: number,
  measure: (text: string, size: number) => number,
): FixedTextDrawLine[] {
  const text = value ?? ''
  if (text.trim() === '') return []

  const rawLines = text.split('\n')
  const lineHeight = fontSize / FIXED_TEXT_FONT_SIZE_RATIO
  const maxW = bbox.w

  // 第 1 パス: 各非空行の drawSize と縮小後 metricsW を確定（中央寄せに使う実幅）。
  type Tmp = { text: string; drawSize: number; metricsW: number; lineIndex: number }
  const tmp: Tmp[] = []
  rawLines.forEach((line, i) => {
    if (line === '') return // 空行は出力しないが lineIndex は i のまま進む（縦送り保持）
    let drawSize = fontSize
    let metricsW = measure(line, drawSize)
    if (metricsW > maxW && metricsW > 0) {
      drawSize = Math.max(FIXED_TEXT_DRAW_MIN_SIZE, (drawSize * maxW) / metricsW)
      // 縮小後の実描画幅で再測し、横中央オフセットの基準にする。
      metricsW = measure(line, drawSize)
    }
    tmp.push({ text: line, drawSize, metricsW, lineIndex: i })
  })
  if (tmp.length === 0) return []

  // 第 2 パス: 縦中央のブロック総高を計算。
  //   blockH = lastIndex 行ぶんの送り（lineHeight）+ 最終行の em-box 高さ（fontSize）。
  //   旧式 (lastIndex+1)*lineHeight は最終行の descent 余白（lineHeight - fontSize = 0.25*fontSize）
  //   を含み、中央オフセットが下にずれて文字が bbox 上部寄りに見える問題があった（2026-06-14 修正）。
  //   新式により「文字 em-box 中心 ≒ bbox 中心」が成立する（1 行: topYPt + fontSize/2 ≒ bbox.y + bbox.h/2）。
  const lastIndex = tmp[tmp.length - 1].lineIndex
  const blockH = lastIndex * lineHeight + fontSize
  // bbox.h が blockH より小さい場合はオフセット負方向を許さず上端揃え（max 0）。
  const blockTop = bbox.y + Math.max(0, (bbox.h - blockH) / 2)

  // 第 3 パス: 各行ごとの xPt（横中央）/ topYPt（縦中央 + 行送り）を出力。
  return tmp.map((t) => ({
    text: t.text,
    drawSize: t.drawSize,
    xPt: bbox.x + Math.max(0, (bbox.w - t.metricsW) / 2),
    topYPt: blockTop + t.lineIndex * lineHeight,
  }))
}
