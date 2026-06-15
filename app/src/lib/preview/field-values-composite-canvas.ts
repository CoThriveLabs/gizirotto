/**
 * 記入欄値・動的プレビュー・ブラウザ Canvas2D 合成
 * （段階2-D2 v2.0 §1-2 / §1-2-3 + 段階2-D3 v2.2 §1-2-6 動的プレビュー vs PDF 完全一致）。
 *
 * AdjustView の背景は **raw=true で取得した記入値ゼロの PNG**（白塗り合成済・テンプレラベル
 * 焼き込み済・記入値は一切焼き込まれていない）。本ファイルは、その上にクライアントで
 * **現在編集中の値**を Canvas2D で都度合成する純関数を提供する。
 *
 * 段階2-D3（v2.2 §1-2-6 推し案 B + D ハイブリッド）追加:
 *   - options に `previewFont?: FittableFont`（opentype.js 経由・preview-font-loader.ts）を
 *     受けられるよう拡張。渡された場合は **`fitting.ts` の `wrapText` + `lineExtent` を直 import**
 *     して、PDF 出力経路（overlay-generator → fitMultiline）と **wrap 位置・行送りが完全一致**する。
 *   - 未渡し（or null）の場合は v2.1 の `ctx.measureText` ベース wrap に **サイレント fallback**。
 *     ロード失敗・遅延中・SSR でも UI が止まらない（劣化プレビュー）。
 *
 * これにより v1.0 の「焼き込み残り二重描画」+ v2.1 の「メトリクス 2 経路ドリフト」を構造的に
 * 解消する（§7-B 焼き込みゼロ + §1-2-6-3 fitMultiline 同型化・wrap ロジック物理的に 1 経路）。
 *
 * 🚨 サーバ専用 import 分離（§3-5・mistake.md 2026-06-06 致命傷の教訓）:
 *   - 本ファイルは pure。`@napi-rs/canvas` / `pdf-lib` / `sharp` / `node:fs` / `fontkit` を
 *     一切 import しない。
 *   - `fitting.ts` の `wrapText` / `lineExtent`（後者は internal なので等価ヘルパを内部実装）
 *     は pdf-lib 非依存の pure 関数（fitting.ts L17-25 で `FittableFont` 構造的部分型のみ要求）。
 *   - `opentype.js` も pure JS ESM だがブラウザでしか呼ばない（preview-font-loader 経由）。
 *
 * 既存類似パターン尊重（mistake.md 2026-06-07）:
 *   - whiteout-composite-canvas.ts / fixedtext-composite-canvas.ts と同型の interface
 *     （canvas を引数で受けて clearRect なしで重ね描き）。
 */
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import type { FieldOverride } from '@/lib/pdf-output/field-override'
import { applyFieldOverride } from '@/lib/pdf-output/field-override'
import type { FittableFont } from '@/lib/pdf-output/fitting'
import { wrapText, FIT_HEIGHT_RATIO } from '@/lib/pdf-output/fitting'

/**
 * 🔴 段階2-D13 案1（wrap メモ化・移動ドラッグ中 opentype.js 呼び出しゼロ化）:
 *
 * 移動ドラッグ（x/y のみ変化）でも compositeFieldValuesOnCanvas が毎フレーム全 field を
 * `wrapText`（fitting.ts）で再 wrap していた。wrapText は preview-font-loader の
 * `getAdvanceWidth`（opentype.js）を「成長プレフィックスに 1 文字ずつ」呼ぶ O(N²) glyph 参照。
 * wrap 入力（para / maxWPt / fontPt）は移動中まったく不変なので、これは 100% 捨て計算になる。
 *
 * D11/D12（RAF 間引き）が無効だった理由は、合成の「起動頻度」を間引いただけで、中身の
 * O(N²) wrap は 1 回も減っていなかったため。本メモ化で wrap 出力そのものをキャッシュし、
 * 移動 2 フレーム目以降は wrapText（= getAdvanceWidth）呼び出しを完全にゼロ化する。
 *
 * key = `fontPt|maxWPt|para`（x/y/h 非依存）。これにより：
 *   - 案D / D4（h 連動）/ D8・D10（y 中央維持）と両立（キーが x/y/h 非依存）
 *   - メモ化は純粋な最適化で wrap 出力はピクセル一致（同じ key → 同じ wrapText 結果）
 *
 * ⚠️ font はキーに含めない。font は preview-font-loader.ts のセッション単一 singleton
 *    （プロセス寿命で不変・loadPreviewFont が Promise 共有で 1 回だけ生成）であることが前提。
 *    将来 OTF を差し替える（複数 font を混在させる）場合は、キーに font の version/identity を
 *    追加すること。現状の singleton 前提では font は常に同一なのでキー省略で安全。
 */
const _wrapCache = new Map<string, string[]>()
const _WRAP_CACHE_MAX = 2000

function memoWrap(
  para: string,
  maxWPt: number,
  font: FittableFont,
  fontPt: number,
): string[] {
  const key = `${fontPt.toFixed(2)} ${maxWPt.toFixed(2)} ${para}`
  const hit = _wrapCache.get(key)
  if (hit) return hit
  const result = wrapText(para, maxWPt, font, fontPt)
  if (_wrapCache.size >= _WRAP_CACHE_MAX) _wrapCache.clear()
  _wrapCache.set(key, result)
  return result
}

/**
 * テスト用: wrap メモ化キャッシュをリセットする。本番コードからは呼ばないこと。
 * （`tests/unit/field-values-composite-canvas-wrap-memo.test.ts` で
 *   キャッシュ hit/miss を独立に検証するために用意。）
 */
export function _resetWrapCache(): void {
  _wrapCache.clear()
}

/**
 * 記入欄値の動的合成入力。
 *
 * - `field`: テンプレ既定 PdfField（bbox.page / bbox / font.size / padding 等を含む）。
 * - `value`: 現在編集中の値（空文字は呼出側でフィルタ済前提・空なら何もしない）。
 * - `override`: per-field override（x/y/w/h/fontSize partial・段階2 D-core の §3-2）。
 *   位置・サイズ・per-field fontSize はここから優先反映する（applyFieldOverride 経由）。
 */
export interface FieldValueComposite {
  field: PdfField
  value: string
  override?: FieldOverride
}

/**
 * Canvas2D 描画用の描画オプション（uniform 値・色・フォント・実 OTF メトリクス）。
 */
export interface FieldValueCompositeOptions {
  /**
   * §4 で算出された記入欄統一サイズ（pt）。**省略時は field.font.size を使う**。
   * override.fontSize があれば applyFieldOverride によりそちらが最優先。
   */
  uniformFontSize?: number
  /** 描画色（既定 '#000000'）。 */
  fillStyle?: string
  /** 描画用フォントファミリ（既定 NotoSansJP, sans-serif・whiteout/fixedtext と同型）。 */
  fontFamily?: string
  /**
   * 🔴 段階2-D3 新規（§1-2-6 推し案 B）: wrap 判定用の OTF メトリクス（preview-font-loader 経由）。
   *
   * 渡された場合: `fitting.ts` の `wrapText` を呼んで PDF 出力経路と **完全同型** の wrap 結果を得る。
   *   - pdf-lib の `widthOfTextAtSize` と同じ OTF テーブル（fontkit 内部）を opentype.js 経由で
   *     読むため、wrap 位置・行数・改行点が構造的にピクセル一致する。
   *
   * 未渡し（undefined）の場合: v2.1 の `ctx.measureText` ベース wrap に fallback（劣化プレビュー）。
   *   - フォントロード失敗・遅延中・SSR でも UI を止めないため。
   */
  previewFont?: FittableFont
}

/**
 * 1 行の高さ係数（漢字 em 基準・fitting.ts FIT_HEIGHT_RATIO と同係数 1.0）。
 *
 * 🔴 段階2-D3（§1-2-6-3 fitMultiline 同型化）:
 *   旧 v2.1 は `LINE_HEIGHT_RATIO_PREVIEW = 1.0` で `lineHeightPx = fontPx / 1.0` としていたが、
 *   PDF 出力経路（fitting.ts L205, L318）は `lineExtent(font, size, 1.0) * 1.2` = `size * 1.0 * 1.2`
 *   で **行間 1.2 倍** を適用する。プレビュー側だけ 1.0 倍だと改行位置・行数が PDF と乖離するため、
 *   段階2-D3 で `lineHeightPx = fontPx * 1.2` に統一（previewFont の有無に関わらず同係数）。
 *
 *   これにより plain `ctx.measureText` 経路でも行送りは PDF と一致する（wrap 位置の文字幅判定だけが
 *   経路依存で残るが、それは previewFont 渡しで解消される）。
 */
const LINE_HEIGHT_RATIO = FIT_HEIGHT_RATIO // 1.0 = 漢字 em 基準
const LINE_GAP_MULT = 1.2 // fitting.ts L205 / L318 と同係数（行間 1.2 倍）

/**
 * 当該ページの記入欄値を Canvas2D で上書き描画する純関数。
 *
 * 呼び出し側は背景（raw + 白塗り + 固定テキスト合成済）を canvas に drawImage 済みの状態で
 * 本関数を呼ぶ。本関数は clearRect / drawImage は行わず、既存 canvas 内容の上に fillText を
 * 重ねるだけ（合成順は呼出側責務）。
 *
 * items は当該ページぶんだけ渡す前提（呼出側で page フィルタ済み）。空 / value 空はスキップ。
 *
 * 描画仕様（§1-2-6 完全一致設計・previewFont あり時）:
 *   - effective bbox（override 反映後・applyFieldOverride 経由）
 *   - fontPt = override.fontSize → uniformFontSize → field.font.size の優先順
 *   - wrap = `fitting.ts` wrapText（PDF 経路と同一純関数）
 *   - 行送り（drawY 進行）= fontPt * LINE_HEIGHT_RATIO(1.0) * LINE_GAP_MULT(1.2)
 *   - 高さ判定（はみ出しスキップ）= fontPt * LINE_HEIGHT_RATIO(1.0)（PDF fitting.ts lineExtent と同型・案B）
 *   - uniform 注入時のみ maxH/yTop の上下 pad を 0 にして PDF 経路 lockSize=true と整合（案A）
 *   - baseline=top / fillText で 1 行ずつ描画
 *   - bbox 高さからはみ出す行は描画スキップ
 *
 * 描画仕様（previewFont 未渡し・fallback）:
 *   - wrap = `ctx.measureText` ベースの内部 `wrapByMeasure`（v2.1 据置）
 *   - 行送り係数は同じ（LINE_HEIGHT_RATIO × LINE_GAP_MULT = 1.2）
 *
 * @param canvas       描画先 canvas（backing は pixelWidth × pixelHeight 設定済前提）
 * @param items        当該ページの記入欄値配列（value 空は呼出側で除外推奨・本関数は防御で trim 確認）
 * @param pixelWidth   raw PNG 幅 px
 * @param pixelHeight  raw PNG 高さ px
 * @param widthPt      PDF ページ幅 pt
 * @param heightPt     PDF ページ高 pt
 * @param options      描画オプション（uniformFontSize / fillStyle / fontFamily / previewFont）
 */
export function compositeFieldValuesOnCanvas(
  canvas: HTMLCanvasElement,
  items: FieldValueComposite[],
  pixelWidth: number,
  pixelHeight: number,
  widthPt: number,
  heightPt: number,
  options?: FieldValueCompositeOptions,
): void {
  if (items.length === 0) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const sx = pixelWidth / widthPt
  const sy = pixelHeight / heightPt
  const fillStyle = options?.fillStyle ?? '#000000'
  const fontFamily = options?.fontFamily ?? '"NotoSansJP", sans-serif'
  const uniform = options?.uniformFontSize
  const previewFont = options?.previewFont

  ctx.save()
  ctx.fillStyle = fillStyle
  ctx.textBaseline = 'top'

  for (const item of items) {
    const value = item.value ?? ''
    if (value.trim() === '') continue

    // override を反映した派生 field（位置・サイズ・per-field fontSize の最終値）。
    const overridden = applyFieldOverride(item.field, item.override)
    // uniform が指定されており、かつ per-field fontSize override が無いときだけ uniform を使う。
    // override.fontSize がある場合は applyFieldOverride 後の overridden.font.size が既に上書き済。
    const fontPt =
      item.override?.fontSize !== undefined
        ? overridden.font.size
        : uniform ?? overridden.font.size

    // px 写像と行高（pt ベース計算 → 最後に sy で px に変換）。
    const fontPx = Math.max(1, fontPt * sy)
    // 🔴 段階2-D3 案B: 行送り（描画 Y 進行）は従来通り fontPx * 1.2（行間 1.2 倍維持）。
    //   高さ判定（はみ出しスキップ）は別変数 lineExtentPx = fontPx * LINE_HEIGHT_RATIO(=1.0) で
    //   行うことで PDF 経路 fitting.ts と同型化（fitting.ts L60: lineExtent = size * heightRatio）。
    //   描画行送りは変えないため見た目の行間は不変、判定条件だけ PDF と一致する。
    const lineHeightPx = fontPx * LINE_GAP_MULT
    const lineExtentPx = fontPx * LINE_HEIGHT_RATIO

    // padding は overridden.padding（テンプレ既定）。文字 baseline の上端揃え。
    const padLeft = overridden.padding?.left ?? 0
    const padTop = overridden.padding?.top ?? 0
    const padBottom = overridden.padding?.bottom ?? 0
    const padRight = overridden.padding?.right ?? 0
    // 🔴 段階2-D5（ユーザー実機フィードバック 2026-06-08「上辺ギリギリ・下辺と差」解消）:
    //   旧 D3 案A の `isUniformDriven` 経路で `effPad=0` 特殊化を行っていたが、D4（v2.4.1）の
    //   bbox.h 連動（requiredH = fontSize + (n-1)*1.2*fontSize + padTop + padBottom）により
    //   高さ起因の非表示問題は構造解決済み。effPad=0 特殊化は副作用源（描画上端が bbox 上辺に
    //   張り付き、下に padTop+padBottom 分の空白が残る非対称配置）に転落したため撤廃。
    //   常に実 padTop/padBottom を適用し、上下対称配置 + 全行描画を成立させる。
    //   数式追跡:
    //     yTopPx = bbox.y*sy + padTop*sy        ... 上端から padTop ぶん下げて描画
    //     maxHPx = (bbox.h - padTop - padBottom)*sy
    //            = (requiredH - padTop - padBottom)*sy
    //            = (fontSize + (n-1)*1.2*fontSize)*sy   ... A 式から pad を引いた残り
    //     描画 n 行の進行 = (n-1)*lineHeightPx + lineExtentPx
    //                    = ((n-1)*1.2 + 1.0)*fontPx
    //                    = (fontSize + (n-1)*1.2*fontSize)*sy = maxHPx → 全行入る
    const effPadTop = padTop
    const effPadBottom = padBottom
    const xPx = overridden.bbox.x * sx + padLeft * sx
    const yTopPx = overridden.bbox.y * sy + effPadTop * sy
    // wrap 判定用の最大幅（previewFont 経路は pt 空間で判定 / fallback は px 空間で判定）。
    const maxWPt = Math.max(0, overridden.bbox.w - padLeft - padRight)
    const maxWPx = Math.max(1, maxWPt * sx)
    // bbox 高さからはみ出す行は描画スキップ（最終真実は overlay 側の fitMultiline）。
    const maxHPx = Math.max(
      0,
      overridden.bbox.h * sy - effPadTop * sy - effPadBottom * sy,
    )

    // フォントは段落間で一切変えない（§1-2-5 v2.1 確定）。1 回だけ設定。
    ctx.font = `${fontPx}px ${fontFamily}`

    // §1-2-5 / §1-2-6: 横はみ出しは wrap 折返しで複数行に分割（縮小禁止）。
    //   段落（\n 区切り）ごとに word wrap し、すべての行を共通の fontPx で描画する。
    //
    // 経路選択:
    //   - previewFont 渡しあり: fitting.ts `wrapText` を pt 空間で呼ぶ（PDF 経路と同一純関数）
    //   - previewFont なし    : 内部 `wrapByMeasure` を ctx.measureText で呼ぶ（v2.1 fallback）
    let lineIndex = 0
    const paragraphs = value.split('\n')
    for (const para of paragraphs) {
      if (para === '') {
        // 空行は 1 行ぶん高さを送るのみ（描画なし）。
        lineIndex += 1
        continue
      }
      const wrappedLines = previewFont
        ? memoWrap(para, maxWPt, previewFont, fontPt) // PDF と完全同型（pt 空間）+ D13 メモ化
        : wrapByMeasure(ctx, para, maxWPx) // fallback（px 空間・ctx.measureText）
      for (const wrappedLine of wrappedLines) {
        const drawY = yTopPx + lineIndex * lineHeightPx
        // 🔴 段階2-D3 案B: 高さ判定は lineExtentPx（=fontPx*1.0）で行う（PDF 経路 fitting.ts の
        //   lineExtent = size * FIT_HEIGHT_RATIO(=1.0) と同型）。行送り(lineHeightPx) と判定の
        //   行高(lineExtentPx) を分離することで、行間 1.2 倍を保ちつつ「1 行ぶんの占有高」基準で
        //   bbox 内かを判定する。短文 field（h=14pt / uniform=14pt）でも 14 ≤ 14 で 1 行描画される。
        if (drawY + lineExtentPx > yTopPx + maxHPx) {
          lineIndex += 1
          continue
        }
        ctx.fillText(wrappedLine, xPx, drawY)
        lineIndex += 1
      }
    }
  }

  ctx.restore()
}

/**
 * 文字単位の wrap 折返し純関数（v2.1 fallback・previewFont 未渡し時のみ使う）。
 *
 * 1 行が maxW（px）を超えそうになったら、現在累積中の文字列を 1 行として確定し、次行へ送る。
 * 日本語は語境界が単純に取れないため文字単位で十分。最終真実は overlay PDF の fitMultiline。
 *
 * - 1 文字目から既に maxW を超える場合: その 1 文字を 1 行として強制確定（無限ループ防止）。
 * - 改行文字（\n）は呼出側で split 済前提・本関数は単一段落を扱う。
 * - 空文字は呼出側でスキップ済（本関数は空文字を受けない想定だが、防御で空配列を返す）。
 *
 * @returns 折返し後の各行の配列（fillText に 1 行ずつ渡せる）。
 */
function wrapByMeasure(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string[] {
  if (text === '') return []
  if (maxW <= 0) return [text] // 不正な maxW は 1 行で返す（防御）。
  const out: string[] = []
  let line = ''
  for (const ch of text) {
    const candidate = line + ch
    const w = ctx.measureText(candidate).width
    if (w <= maxW || line === '') {
      line = candidate
    } else {
      out.push(line)
      line = ch
    }
  }
  if (line !== '') out.push(line)
  return out
}

// LINE_HEIGHT_RATIO は段階2-D3 案B で高さ判定 lineExtentPx の係数として実使用済み（行送りは LINE_GAP_MULT）。
