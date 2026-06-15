/**
 * FieldBboxDetector — ラスタ画像から罫線（黒線）を検出して枠（field_bbox）を復元する。
 *
 * 核心:
 *   ① 背景色で判断しない。判定は罫線 + written_bbox + role のみ。
 *   ② 外周罫線でエリアB 大枠を立てる。内部罫線が無くても外周 4 本で 1 矩形成立。
 *      罫線 vs 記入文字行を区別するため「最長連続ラン比率」を併用。
 *
 * アルゴリズム:
 *   1. PNG → @napi-rs/canvas でデコード → getImageData()（RGBA）
 *   2. 1 パス統合: グレースケール（整数 luma）+ 二値化 + 水平/垂直投影 + 最長ラン集計を
 *      行優先 1 ループで同時に行う（列優先キャッシュミス排除・ダウンサンプル）。
 *   3. 罫線判定 = 総数比率(LINE_FILL_RATIO) AND 最長ラン比率(LINE_RUN_RATIO)。
 *   4. エリアA = 隣接罫線ペアのセル群 / エリアB = 外周 4 本で立てた大矩形。
 *   5. px → pt 変換（pagePtSize / pixel スケール）。
 *
 * 座標: 出力 FieldBox.bbox は pt 単位・左上原点。area で 'A'/'B' を区別する。
 * 閾値は下記 const に集中定義。背景色（グレー/色帯/薄背景）を一切参照しない。
 */

import type { PdfBox } from './pdf-types'
import type { RasterizedPage } from './pdf-page-rasterizer'

// =============================================================================
// 閾値（const 集中定義・実機チューニング前提）
// =============================================================================

/**
 * 二値化閾値（0-255 輝度）。これ以下の輝度を「暗ピクセル（罫線/文字）」とみなす。
 * 白地スキャン議事録を前提に固定閾値。背景色判定ではなく「黒線が存在するか」を見る。
 */
export const BINARIZE_LUMA_THRESHOLD = 160

/**
 * ダウンサンプル走査。1=フル, 2=1/2 間引き（px 1/4 で約 4 倍速）。
 * 罫線は太さ数 px なので 1/2 でも幅判定は保持。座標は step 倍で元解像度に復元する。
 */
export const DETECT_DOWNSAMPLE = 2

/**
 * inset（pt）。全塗り矩形を各辺この値だけ内側に縮める → 外周・セル境界の罫線を残す。
 */
export const INSET_PT = 2.0

/**
 * ラベル列幅閾値。行内最左セルの幅が「ページ幅 * この比率」以下なら位置ベースで
 * ラベル列とみなす（OCR text 非依存。whiteout-pipeline 側で使用）。
 */
export const LEFT_LABEL_COL_MAX_W_RATIO = 0.22

/**
 * 罫線判定の総数比率。行/列の暗ピクセル総数 ≥ 幅(高) * この比率 が罫線候補の第 1 条件。
 */
export const LINE_FILL_RATIO = 0.5

/**
 * 罫線判定の最長連続ラン比率（横罫線専用）。
 * 行の暗ピクセルの最長連続ラン ≥ 幅 * この比率 が横罫線の第 2 条件。
 * 縦罫線への適用は廃止（ページ全高基準では内部縦罫線が全落ちするため）。
 * 縦罫線は帯ローカル基準（VLINE_BAND_RUN_RATIO）に置き換え済。
 */
export const LINE_RUN_RATIO = 0.6

/**
 * 帯ローカル縦罫線。横罫線で区切られた各帯について、列の暗ピクセルの帯内最長連続ラン ≥
 * 帯高(steps) * この比率 を縦罫線の第 1 条件とする。
 * 真の縦罫線は帯高をほぼ貫く（ラン長 ≈ 帯高）ので通過。縦並び文字は帯高の一部しか占めず
 * 文字間で途切れるので落ちる（横罫線の連続性原理を縦・帯ローカルに適用）。
 */
export const VLINE_BAND_RUN_RATIO = 0.7

/**
 * 帯ローカル縦罫線の総数比率（補助条件）。帯内の列暗ピクセル総数 ≥ 帯高(steps) * この比率 を
 * 第 2 条件とする。最長ランと併用し、かすれ罫線の取りこぼしと文字の誤検出の双方を抑える。
 */
export const VLINE_BAND_FILL_RATIO = 0.5

/**
 * 記入有無フィルタの最小文字数（whiteout-pipeline 側で使用、ここでは const 集中のため定義）。
 */
export const WRITTEN_MIN_CHARS = 1

/**
 * 記入有無フィルタの最小 confidence（当面 0.0 で無効、実機調整）。
 */
export const WRITTEN_MIN_CONF = 0.0

/**
 * 罫線クラスタ統合: 罫線候補の行/列が「このピクセル数以内」で隣接していたら
 * 同一の太い罫線とみなし 1 本に束ねる（線が複数画素幅を持つため）。
 */
export const LINE_MERGE_GAP_PX = 4

/**
 * セル最小サイズ（px）。隣接罫線間がこれ未満の矩形は罫線二重検出由来ノイズとして捨てる。
 */
export const MIN_CELL_SIZE_PX = 8

/**
 * エリアB 大枠とみなす最小幅/高（px）。これ以上の広い矩形を「大記述エリア」候補とする。
 * 小さいセル（エリアA）と区別するための下限。
 */
export const AREA_B_MIN_SIZE_PX = 60

// -----------------------------------------------------------------------------
// 判定側 whiteout-pipeline 用 const（検出ロジックは無改変、const 集中の置き場）。
// -----------------------------------------------------------------------------

/**
 * field がラベルセル面積の何倍までなら「field 自体がラベル」とみなすか。
 * field がこの倍率以内ならラベルセル ≒ field（ラベル列の細セル）として除外。
 * 大枠（議事内容）はラベルセルの数十倍面積なので超えて残る。
 */
export const LABEL_FIELD_AREA_MAX_RATIO = 2.5

/**
 * 全幅薄帯ラベル判定。field 幅がページ幅のこの比率以上 ＋ 高さが 1 行分以下なら
 * 面積比に関わらずラベル除外を維持する（全幅 1 行ラベル帯を残しつつ背の高い大枠は解除）。
 */
export const FULLWIDTH_BAND_RATIO = 0.9

/**
 * written_bbox のうち field に重なる面積比がこの値以上で「記入あり」とみなす。
 * 中心包含（点判定）の脆さを面積重なりに置換。文字がセル境界をまたいでも拾える。
 */
export const WRITTEN_OVERLAP_MIN_RATIO = 0.3

/**
 * 帯グルーピング。field の y(top) がこの pt 以内なら同一帯とみなし、
 * 帯内のエリアA 細セルを束ね対象としてまとめる。
 */
export const BAND_GROUP_GAP_PT = 2.0

/**
 * 左辺 inset（pt）。罫線被りは別レイヤの座標補正（LINE_OVERLAP_FIX_PX）で吸収する
 * （inset を増やして両立を崩さない方針）。実機調整 2.5〜3.5。
 */
export const INSET_LEFT_PT = 3.0

/**
 * 帯内最左 field の幅がページ幅のこの比率以下なら位置ラベル列（OCR 非依存）。
 * cluster 経由ラベル除外が OCR で読めなかったラベルを罫線 field box の幾何だけで弾く。
 * 既存 LEFT_LABEL_COL_MAX_W_RATIO と同値起点（実機調整 0.18〜0.28）。
 */
export const POS_LABEL_MAX_W_RATIO = 0.22

/**
 * written のうち field に重なる絶対割合の下限（min 基準の誤爆ガード）。
 * written の WRITTEN_MIN_FRAC 未満しか重ならない = かすめただけ は記入とみなさない。
 * 空欄に隣欄の文字端がはみ出すケースを弾く（実機調整 0.1〜0.3）。
 */
export const WRITTEN_MIN_FRAC = 0.1

/** 右辺 inset（pt）。左辺と同値。 */
export const INSET_RIGHT_PT = 3.0

/** 上辺 inset（pt）。議事内容/決定事項の上かぶり対策（実機調整）。 */
export const INSET_TOP_PT = 3.0

/** 下辺 inset（pt）。議事内容/決定事項の下かぶり対策（実機調整）。 */
export const INSET_BOTTOM_PT = 3.0

// -----------------------------------------------------------------------------
// 判定側 whiteout-pipeline 用 const（背景色非依存・インク判定）。
//
// 🚨 これらは「セル内の局所背景より相対的に濃い前景ピクセル（記入インク）」の有無を測る
// ための閾値であり、地色の絶対値（白≈255 / グレー≈210）で塗る塗らないを決めるものではない。
// GRAY 固定色しきい・background-color 依存は禁止。
// -----------------------------------------------------------------------------

/**
 * インク判定: セル内最頻 luma（局所背景）から「これ以上濃い」画素をインクとみなす差分。
 * 相対基準（地色非依存）。実機調整 40〜90（薄い鉛筆で拾えねば下げ / 地色ムラを拾えば上げ）。
 */
export const INK_LUMA_DELTA = 60

/**
 * インク判定: 走査領域に占めるインク画素比の下限（点ノイズ・かすれ罫線残りを弾く）。
 * 実機調整 0.004〜0.02（空欄を塗れば上げ / 薄記入を落とせば下げ）。
 */
export const INK_MIN_DENSITY = 0.008

/**
 * インク判定: セル内側へのマージン px（罫線=黒線を走査領域から外しインクと誤らない）。
 * 実機調整 3〜6（罫線残りを拾えば上げ）。
 */
export const INK_BORDER_MARGIN_PX = 4

/**
 * インク判定: 走査の間引き px（速度。1=フル / 2 で約 4 倍速）。実機調整 1〜3。
 */
export const INK_SCAN_STEP = 2

/**
 * インク判定: 走査領域がこれ未満の極細セルはインク判定せず塗らない（潰れ安全弁）。
 */
export const MIN_INK_SCAN_PX = 6

// -----------------------------------------------------------------------------
// 判定側 whiteout-pipeline 用 const（横並び分割・罫線被り補正）。
// 背景色非依存: 横並び分割は x 座標ギャップ、罫線被り補正は罫線/field 座標の幾何のみで判定。
// -----------------------------------------------------------------------------

/**
 * レンジ束ねの際、インクありセル間の空白がこの pt を超えたら「横並び項目の境界」と
 * みなし別レンジに分割する（部署｜氏名 を 1 枠に繋がない）。同一記入欄内の文字間空白より
 * 十分大きく、横並び項目間（数十pt）より小さい値。
 */
export const BAND_RANGE_SPLIT_GAP_PT = 28

/**
 * 罫線被り補正マージン（pt）。検出 field bbox の辺が罫線際にあるとき、塗り矩形の該当辺を
 * 罫線内側へこの分だけクランプする（inset の一律内側量とは別レイヤ）。
 */
export const LINE_OVERLAP_FIX_PX = 2

// -----------------------------------------------------------------------------
// 判定側 whiteout-pipeline 用 const（列分散度・縦罫線残り除去・散在ノイズ）。
// 背景色非依存: いずれも前景インク画素の空間分布の幾何のみで判定する。
// -----------------------------------------------------------------------------

/**
 * 記入欄左セル vs ラベルの区別軸。インク列分布（8 分割 colHist）でゼロ列がこれ以上なら
 * 「片側に偏在＝項目名ラベル印字」とみなし除外、ゼロ列がこれ未満なら「全列に分散＝記入文字」として残す。
 * colHist は前景インク画素の列分布（地色不使用）。
 */
export const LABEL_COLHIST_ZERO_MAX = 3

/**
 * 端列（最左 col0 / 最右 col最終）の縦連続ランが走査高のこの比率以上なら「縦罫線残り」と
 * みなし、その端列のインク画素を density 評価から控除する（部署空欄の左右縦罫線が落ちる）。
 * 記入文字は縦に数 px で途切れるので残る。
 */
export const VLINE_RESIDUE_RUN_RATIO = 0.8

/**
 * インク最大連結成分（4 近傍）の下限。これ未満なら「散在ノイズ」とみなし記入なし扱い
 * （density を満たしても塗らない）。罫線残り（大成分）は端列縦ラン控除で、散在ノイズは
 * この maxComponent で落とす二経路。
 */
export const INK_MIN_COMPONENT = 10

// =============================================================================
// 公開型
// =============================================================================

/** field_bbox のエリア種別（§6）。A = 罫線テーブルセル / B = 外周罫線大枠。 */
export type FieldArea = 'A' | 'B'

export interface FieldBox {
  /** 1 始まりページ番号（RasterizedPage.page と整合） */
  page: number
  /** フィールド枠の矩形（pt 単位・左上原点、PdfBox 共通 = 白塗り対象） */
  bbox: PdfBox
  /** エリア種別（§6。A=罫線セル / B=外周罫線大枠）。デフォルト 'A' */
  area: FieldArea
}

/** 検出された罫線（px、デバッグ / テスト用に内部公開） */
interface DetectedLines {
  /** 横罫線の y 位置（px、クラスタ統合後の中心、元解像度復元済） */
  hLines: number[]
  /**
   * 代表 縦罫線の x 位置（px、元解像度復元済）。
   * v0.7.2: 「全帯ローカル縦罫線の和集合を x 方向クラスタしたもの」に再定義（§3-5）。
   * 外周 2 本 + 各帯の内部縦罫線が統合されるため、診断 vLines は 2 → セル数に応じて増える。
   */
  vLines: number[]
  /**
   * v0.7.2 §3-2: 帯ローカル縦罫線。bandVLines[r] = 帯 r（hLines[r]..hLines[r+1]）の
   * 内部縦罫線 x（元解像度 px、外周 leftMost/rightMost は含まない）。
   * 帯ごとに異なる縦区切りを保持し、エリアA セル生成（§3-4）で帯 × ローカル縦罫線に使う。
   */
  bandVLines: number[][]
}

// =============================================================================
// 公開 API
// =============================================================================

/**
 * v0.8 §6/§10: インク判定用にデコード済みラスタ画素を field bbox と一緒に返す軽量コンテナ。
 * detectFieldBboxes が内部で getImageData した RGBA を捨てずに共有し、判定側（whiteout-pipeline
 * の hasInkInCell）が再デコードなしでセルの画素を走査できるようにする（§12-3 配線・コスト最小）。
 */
export interface RasterPagePixels {
  /** 1 始まりページ番号（FieldBox.page / RasterizedPage.page と整合）。 */
  page: number
  /** RGBA バイト列（length = pixelWidth * pixelHeight * 4）。 */
  data: Uint8ClampedArray
  pixelWidth: number
  pixelHeight: number
  /** PDF ページ pt サイズ（px↔pt 逆算用）。 */
  pageWidthPt: number
  pageHeightPt: number
}

/** detectFieldBboxes の戻り（field bbox ＋ インク判定用に共有する画素）。 */
export interface DetectFieldBboxesResult {
  boxes: FieldBox[]
  /** v0.8: インク判定で再利用するデコード済み画素（再 getImageData 回避）。 */
  pixels: RasterPagePixels
}

/**
 * ラスタ画像から罫線検出でフィールド枠 bbox を検出する（エリアA + エリアB）。
 *
 * v0.8 §12-3: デコードした ImageData を捨てず pixels として返し、インク判定（hasInkInCell）が
 * 再デコードなしで共有できるようにする（コスト最小化・新規依存0）。
 *
 * @param page  RasterizedPage（pngBuffer + pixelWidth/Height + pagePtSize）
 * @returns { boxes: FieldBox[]（pt・左上原点）, pixels: 共有 RGBA 画素 }
 */
export async function detectFieldBboxes(page: RasterizedPage): Promise<DetectFieldBboxesResult> {
  const { loadImage, createCanvas } = await import('@napi-rs/canvas')

  // [whiteout-diag-timing] PNG デコード（loadImage + drawImage + getImageData）の ms。
  // 律速特定が最優先（依頼1）。ここ単独で重い場合は @napi-rs/canvas のデコード/転送が容疑。
  const tDecode = Date.now()
  const img = await loadImage(page.pngBuffer)
  const w = page.pixelWidth
  const h = page.pixelHeight
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, w, h)
  const imageData = ctx.getImageData(0, 0, w, h)
  console.log(
    `[whiteout-diag-timing] png-decode+getImageData(p${page.page})=${Date.now() - tDecode}ms px=${w}x${h}`,
  )

  const boxes = detectFieldBboxesFromImageData(
    imageData.data,
    w,
    h,
    page.page,
    page.pagePtSize.width,
    page.pagePtSize.height,
  )

  return {
    boxes,
    pixels: {
      page: page.page,
      data: imageData.data,
      pixelWidth: w,
      pixelHeight: h,
      pageWidthPt: page.pagePtSize.width,
      pageHeightPt: page.pagePtSize.height,
    },
  }
}

/**
 * ImageData（RGBA Uint8ClampedArray）から直接 field_bbox を検出する純関数。
 * @napi-rs/canvas のデコードを切り離し、合成 ImageData での unit test を可能にする。
 *
 * @param data         RGBA バイト列（length = pixelWidth * pixelHeight * 4）
 * @param pixelWidth   画像幅 px
 * @param pixelHeight  画像高 px
 * @param page         1 始まりページ番号
 * @param pageWidthPt  PDF ページ幅 pt
 * @param pageHeightPt PDF ページ高 pt
 */
export function detectFieldBboxesFromImageData(
  data: Uint8ClampedArray | Uint8Array,
  pixelWidth: number,
  pixelHeight: number,
  page: number,
  pageWidthPt: number,
  pageHeightPt: number,
): FieldBox[] {
  // [whiteout-diag-timing] detectLines（v0.7.2: 2 ステージ = 横罫線確定 + 帯ローカル縦集計）の ms（依頼1）。
  const tLines = Date.now()
  const { hLines, vLines, bandVLines } = detectLines(data, pixelWidth, pixelHeight)
  // v0.7.2: vLines は「全帯ローカル縦罫線の和集合クラスタ」= 代表縦罫線（§3-5）。
  // bandVLines の総内部縦罫線数も出し、帯ローカルで縦罫線が増えたか（真因 vLines=2 の根治）を確認する。
  const bandInnerVTotal = bandVLines.reduce((n, bv) => n + bv.length, 0)
  console.log(
    `[whiteout-diag-timing] detectLines(p${page})=${Date.now() - tLines}ms hLines=${hLines.length} vLines=${vLines.length} bandInnerV=${bandInnerVTotal} bands=${bandVLines.length}`,
  )

  // 横罫線 2 本・縦罫線 2 本以上ないと閉じた枠は構成できない（外周 2 本は最低限必要）
  if (hLines.length < 2 || vLines.length < 2) return []

  // px → pt 変換（scan-extractor の sx/sy と同一手法）
  const sx = pageWidthPt / pixelWidth
  const sy = pageHeightPt / pixelHeight

  // 外周縦罫線 = 全帯共通の左右外周 2 本。代表 vLines の両端（全高を通す = 旧来 vLines=2 で取れる 2 本）
  // を流用して確定する（§13 注）。内部縦罫線だけを帯ローカル（bandVLines）で補う。
  const leftMost = vLines[0]
  const rightMost = vLines[vLines.length - 1]

  const boxes: FieldBox[] = []

  // -------------------------------------------------------------------------
  // v0.7.2 §3-4 / §3-7: 帯ごとに「その帯のローカル縦罫線（bandVLines[r]）の有無」で
  // エリアA / エリアB を振り分ける（v0.7.1 のグローバル vLines 判定を帯ローカル化）。
  //   - 帯内に内部縦罫線あり → エリアA（帯 × 帯ローカル縦罫線でセル分割。上段2/下段3 等を表現）
  //   - 帯内に内部縦罫線なし → エリアB（外周 4 本で大枠 1 矩形。v0.7.1 §4-3 のロジックを維持）
  // 1 ループで両者を判定する（dedup: 同一帯がエリアA とエリアB に二重生成されない）。
  // -------------------------------------------------------------------------
  const tBands = Date.now()
  let areaACount = 0
  let areaBCount = 0
  const bandWpx = rightMost - leftMost
  for (let r = 0; r < hLines.length - 1; r++) {
    const top = hLines[r]
    const bottom = hLines[r + 1]
    const bandHpx = bottom - top
    if (bandHpx < MIN_CELL_SIZE_PX) continue

    // §3-4: 帯ローカルの内部縦罫線（外周 leftMost/rightMost の内側のみ採用）。
    const inner = bandVLines[r].filter(v => v > leftMost && v < rightMost)

    if (inner.length === 0) {
      // §3-7: 内部縦罫線なし帯 = 大記述エリア → エリアB（外周 4 本で 1 矩形）。
      if (bandHpx < AREA_B_MIN_SIZE_PX || bandWpx < AREA_B_MIN_SIZE_PX) continue
      boxes.push({
        page,
        area: 'B',
        bbox: { x: leftMost * sx, y: top * sy, w: bandWpx * sx, h: bandHpx * sy },
      })
      areaBCount++
      continue
    }

    // §3-4: エリアA = 帯 × その帯のローカル縦罫線。外周 2 本を両端に必ず含めてセル列を作る。
    const localV = mergeSortedPx([leftMost, ...inner, rightMost], LINE_MERGE_GAP_PX)
    for (let c = 0; c < localV.length - 1; c++) {
      const left = localV[c]
      const right = localV[c + 1]
      const cellWpx = right - left
      if (cellWpx < MIN_CELL_SIZE_PX) continue
      boxes.push({
        page,
        area: 'A',
        bbox: { x: left * sx, y: top * sy, w: cellWpx * sx, h: bandHpx * sy },
      })
      areaACount++
    }
  }
  console.log(
    `[whiteout-diag-timing] bands-areaAB(p${page})=${Date.now() - tBands}ms ` +
      `areaA=${areaACount} areaB=${areaBCount} fieldTotal=${boxes.length}`,
  )

  return boxes
}

// =============================================================================
// 内部: §7 1 パス統合の罫線検出（背景色非依存・最長ラン集計相乗り）
// =============================================================================

/**
 * v0.7.2 §3 / §6: 罫線検出を 2 ステージ化する。
 *   ① 横罫線確定パス（v0.7.1 流用・縦の全高 colMaxRun 集計は廃止）:
 *      グレースケール（整数 luma）+ 二値化 + 水平投影 + 行ごと最長ラン を行優先 1 ループで集計。
 *      §4-2 横罫線判定 = 総数比率(LINE_FILL_RATIO) AND 最長ラン比率(LINE_RUN_RATIO)。横は全幅通しで正常。
 *   ② 帯ローカル縦集計パス（§3-3）: ①で確定した hLines で区切られた各帯について、帯内の列
 *      暗ピクセル総数 colBandDark と帯内縦最長ラン colBandMaxRun を集計し、
 *      帯高基準（VLINE_BAND_RUN_RATIO / VLINE_BAND_FILL_RATIO）で帯ローカル縦罫線を判定する。
 *      → ページ全高を通さない短い内部縦罫線（行高分）が帯ローカルで拾える（真因 vLines=2 の根治）。
 *
 * メモリ（§3-2 / §6-1）: 帯ローカル集計は `colBandDark/Run/MaxRun` の **W 長 1 次元バッファ 1 本ずつ**を
 * 帯ごとに fill(0) リセットして再利用する（band×W の二次元は作らない）。帯は y 方向に重ならない
 * （hLines で分割）ため全帯合計の走査面積 ≈ W*H で、②も実質 1 パス相当（合計 ≈ 2 パス）。
 *
 * 背景色は一切参照しない（暗ピクセル = 黒線/文字の二値のみ。GRAY 系不在・指示①厳守）。
 */
function detectLines(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): DetectedLines {
  const step = DETECT_DOWNSAMPLE > 0 ? DETECT_DOWNSAMPLE : 1
  const W = Math.ceil(width / step) // ダウンサンプル後の列数
  const H = Math.ceil(height / step) // ダウンサンプル後の行数

  // ① 横罫線確定パス（行優先 1 ループ）。横罫線（rowDark/rowMaxRun）に加え、外周縦罫線
  //    確定用の全高 colDark/colMaxRun も相乗り集計する（§13 注: 外周 2 本は全高通しで取れる）。
  //    内部縦罫線は帯ローカル（②）で別途取るため、ここの縦集計は外周判定のみに使う。
  //    → ①（横 + 外周縦）+ ②（帯ローカル内部縦）= 合計 2 パス（設計 §6 想定どおり）。
  const rowDark = new Int32Array(H) // §7-A 各行の暗ピクセル総数
  const rowMaxRun = new Int32Array(H) // §4-2 行ごと最長連続ラン
  const colDark = new Int32Array(W) // 全高 列暗ピクセル総数（外周縦罫線判定用）
  const colRun = new Int32Array(W) // 列ごと現在ラン長（行ループで更新）
  const colMaxRun = new Int32Array(W) // 全高 列最長連続ラン（外周縦罫線判定用）

  let yi = 0
  for (let y = 0; y < height; y += step, yi++) {
    let run = 0 // 行内の現在ラン長
    const base = y * width
    let xi = 0
    for (let x = 0; x < width; x += step, xi++) {
      const i = (base + x) * 4
      // §7-D RGBA → luma 整数近似（(R*77 + G*150 + B*29) >> 8 ≈ 0.299/0.587/0.114）
      const luma = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
      if (luma <= BINARIZE_LUMA_THRESHOLD) {
        rowDark[yi]++
        run++
        if (run > rowMaxRun[yi]) rowMaxRun[yi] = run
        colDark[xi]++
        colRun[xi]++
        if (colRun[xi] > colMaxRun[xi]) colMaxRun[xi] = colRun[xi]
      } else {
        run = 0
        colRun[xi] = 0
      }
    }
  }

  // §4-2 横罫線判定（総数比率 AND 最長ラン比率）。ダウンサンプル空間 W 基準で比率を取る。
  const hFillThr = W * LINE_FILL_RATIO
  const hRunThr = W * LINE_RUN_RATIO
  const hRowFlags = new Uint8Array(H)
  for (let r = 0; r < H; r++) {
    if (rowDark[r] >= hFillThr && rowMaxRun[r] >= hRunThr) hRowFlags[r] = 1
  }
  // クラスタ統合後、step 倍で元解像度座標に復元（§7-C）
  const hLines = clusterFlags(hRowFlags).map(v => v * step)

  // 外周縦罫線（全高通し 2 本想定）を従来基準（全高 colDark/colMaxRun）で確定（§13 注）。
  const vFillThr = H * LINE_FILL_RATIO
  const vRunThr = H * LINE_RUN_RATIO
  const vColFlags = new Uint8Array(W)
  for (let c = 0; c < W; c++) {
    if (colDark[c] >= vFillThr && colMaxRun[c] >= vRunThr) vColFlags[c] = 1
  }
  const outerVCols = clusterFlags(vColFlags) // ダウンサンプル空間 index

  // ② 帯ローカル縦集計パス（§3-3）。W 長 1 次元バッファを帯ごとにリセット再利用（§6-1）。
  const colBandDark = new Int32Array(W)
  const colBandRun = new Int32Array(W)
  const colBandMaxRun = new Int32Array(W)
  const bandVLines: number[][] = []

  for (let r = 0; r < hLines.length - 1; r++) {
    const top = hLines[r] // 元解像度 px
    const bottom = hLines[r + 1]
    colBandDark.fill(0)
    colBandRun.fill(0)
    colBandMaxRun.fill(0)
    // ダウンサンプル空間の帯高（縦ラン比率の基準）。最低 1。
    const bandSteps = Math.max(1, Math.floor((bottom - top) / step))

    for (let y = top; y < bottom; y += step) {
      const base = y * width
      let xi = 0
      for (let x = 0; x < width; x += step, xi++) {
        const i = (base + x) * 4
        const luma = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
        if (luma <= BINARIZE_LUMA_THRESHOLD) {
          colBandDark[xi]++
          colBandRun[xi]++
          if (colBandRun[xi] > colBandMaxRun[xi]) colBandMaxRun[xi] = colBandRun[xi]
        } else {
          colBandRun[xi] = 0
        }
      }
    }

    // §3-3 帯ローカル縦罫線判定 = 帯内総数比率 AND 帯内最長ラン比率（帯高基準）。
    const runThr = bandSteps * VLINE_BAND_RUN_RATIO
    const fillThr = bandSteps * VLINE_BAND_FILL_RATIO
    const vFlags = new Uint8Array(W)
    for (let c = 0; c < W; c++) {
      if (colBandDark[c] >= fillThr && colBandMaxRun[c] >= runThr) vFlags[c] = 1
    }
    // §3-5: clusterFlags で太線統合 → 帯ローカル縦罫線（元解像度 px、外周は呼び出し側で付与）。
    bandVLines.push(clusterFlags(vFlags).map(v => v * step))
  }

  // §3-5 代表 vLines = 外周縦罫線（全高通し）+ 全帯ローカル内部縦罫線の和集合を x 方向クラスタ。
  // 外周 2 本だけだった v0.7.1 の vLines に、帯ローカルで拾った内部縦罫線が加わり 2 → 増える
  // （DoD §7 / 真因 vLines=2 の根治を計測する診断指標）。
  const allV = new Uint8Array(W)
  for (const x of outerVCols) allV[Math.min(W - 1, x)] = 1
  for (const bv of bandVLines) {
    for (const x of bv) allV[Math.min(W - 1, Math.round(x / step))] = 1
  }
  const vLines = clusterFlags(allV).map(v => v * step)

  return { hLines, vLines, bandVLines }
}

/**
 * 昇順ソート済の x 座標列（元解像度 px）から、gapPx 以内に近接する値を 1 つに統合して返す。
 * エリアA セル生成で「外周 + 帯ローカル縦罫線」を併合する際、外周と内部罫線が近接して
 * 極小セルを作るのを防ぐ（§3-4 dedup/merge）。
 */
function mergeSortedPx(xs: number[], gapPx: number): number[] {
  const sorted = [...xs].sort((a, b) => a - b)
  const out: number[] = []
  for (const x of sorted) {
    if (out.length === 0 || x - out[out.length - 1] > gapPx) {
      out.push(x)
    }
  }
  return out
}

/**
 * 罫線候補フラグ列を走査し、LINE_MERGE_GAP_PX 以内で隣接する候補を 1 本に束ねて
 * その中心位置（ダウンサンプル空間 index）を返す。太い罫線の分裂を防ぐ。
 * 注: ギャップ閾値はダウンサンプル空間 index で評価する（step で割った余裕を持つ）。
 */
function clusterFlags(flags: Uint8Array): number[] {
  const gap = Math.max(1, Math.round(LINE_MERGE_GAP_PX / (DETECT_DOWNSAMPLE > 0 ? DETECT_DOWNSAMPLE : 1)))
  const centers: number[] = []
  let runStart = -1
  let lastFlagged = -1
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) {
      if (runStart < 0) {
        runStart = i
      } else if (i - lastFlagged > gap) {
        centers.push(Math.round((runStart + lastFlagged) / 2))
        runStart = i
      }
      lastFlagged = i
    }
  }
  if (runStart >= 0) {
    centers.push(Math.round((runStart + lastFlagged) / 2))
  }
  return centers
}

// =============================================================================
// テスト用 internal export
// =============================================================================

export const __internal_field_bbox_detector = {
  detectLines,
  clusterFlags,
}
