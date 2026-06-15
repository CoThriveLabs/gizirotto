/**
 * LayoutCluster（白塗り v0.4、設計書 n6_layout_structure_draft_v0.4 §2 / handoff §設計v0.4）。
 *
 * 目的:
 *   スキャン PDF はベクター矩形/罫線を持たない（PoC で全 sample が paintImageXObject のみと確定）。
 *   そのため OCR の word bbox（実測座標）から「行・列のグリッド構造」を座標統計で復元し、
 *   Claude 意味判定に「平坦な word リスト」でなく「行列マトリクス」を渡せるようにする。
 *
 * なぜ必要か（急所）:
 *   field-semantic / 旧 whiteout は word を平坦に Claude へ渡していたため、
 *   「どの語が項目名ラベルで、どの語が記入値か」をレイアウト構造から判断できず、
 *   confidence<70 という脆い代理指標に頼って誤検出（ラベル白塗り / 本文漏れ）していた。
 *   行・列・最左カラム・空白性を構造として与えれば Claude が役割判定できる。
 *
 * アルゴリズム（罫線なし前提、座標統計のみ）:
 *   1. 行クラスタ: 各要素の y 中心が近接（行高の ROW_GAP_RATIO 倍以内）なら同一行に束ねる
 *   2. 各行を x 昇順ソート
 *   3. 列分割: 行内の隣接要素間 x ギャップが「全ギャップ中央値 * COL_GAP_MULTIPLIER」を
 *      超えたら列の境目とみなす（罫線がないので空白幅で列を推定）
 *   4. cells を {cellId, rowIndex, colIndex, ...} に整形
 *
 * 閾値はすべて定数化。実機チューニング前提（議事録レイアウトのばらつきで要調整）。
 *
 * これは白塗り専用の別レイヤー。scan-extractor（座標源）は無改変（別レイヤー併存方針）。
 */

import type { ScanElement, ScanOcrResult } from './scan-extractor'

// =============================================================================
// 閾値（実機チューニング前提。議事録 PDF のレイアウト差で要調整）
// =============================================================================

/** 同一行判定: y 中心差が「行高 * この倍率」以内なら同じ行に束ねる。 */
export const ROW_GAP_RATIO = 0.5
/** 列分割判定: 隣接 x ギャップが「ギャップ中央値 * この倍率」超で列境界とみなす。 */
export const COL_GAP_MULTIPLIER = 1.5
/**
 * 列分割の絶対ギャップ閾値（pt）。これ以上のギャップは中央値統計に関わらず列境界とみなす。
 * 行内要素が少ない（中央値 = 自分自身になり倍率判定が破綻する）ケースの保険。
 * 議事録のラベル↔記入欄の間は通常これより広く空く。実機チューニング前提。
 */
export const ABS_COL_GAP_PT = 24
/** 列分割の最小ギャップ下限（pt）。中央値が極端に小さいときの誤分割を防ぐ。 */
export const MIN_COL_GAP_PT = 8
/** 空白セル判定: text を trim した文字数がこれ以下なら looksEmpty。 */
export const EMPTY_TEXT_MAX_LEN = 0

// =============================================================================
// ラベル語彙（項目名ラベルらしさのヒント。Claude 判定の補助で、確定はしない）
// =============================================================================

/**
 * 議事録テンプレでよく項目名ラベルに使われる語。完全一致でなく「含む」で判定。
 * これは Claude へのヒント（labelLexiconHit）であって、これ単独で role を決めない。
 */
export const LABEL_LEXICON = [
  '日時',
  '日付',
  '場所',
  '会場',
  '出席',
  '出席者',
  '参加者',
  '欠席',
  '氏名',
  '名前',
  '部署',
  '所属',
  '議題',
  '議事',
  '議事内容',
  '決定',
  '決定事項',
  '次回',
  '予定',
  '添付',
  '資料',
  '作成者',
  '記録',
  '承認',
  '件名',
  '会議名',
  'タイトル',
]

// =============================================================================
// 公開型
// =============================================================================

export interface LayoutCell {
  /** 一意 ID。`p{page}-r{row}-c{col}` 形式。Claude classifications と突合する。 */
  cellId: string
  /** 1 始まりページ番号 */
  page: number
  /** 0 始まり行インデックス（上から） */
  rowIndex: number
  /** 0 始まり列インデックス（左から） */
  colIndex: number
  /** セルテキスト（同セル内 word を x 順に連結） */
  text: string
  /** セル全体の bbox（束ねた word の外接矩形、pt 単位・左上原点） */
  bbox: { x: number; y: number; w: number; h: number }
  /** 行内で最も左の列か（ラベル列の手掛かり） */
  isLeftmostInRow: boolean
  /** 空白セルらしいか（記入枠の手掛かり） */
  looksEmpty: boolean
  /** ラベル語彙にヒットしたか（項目名ラベルの手掛かり、確定でない） */
  labelLexiconHit: boolean
  /** セル内 word の平均 confidence（0-1） */
  avgConfidence: number
}

export interface LayoutClusterPage {
  page: number
  cells: LayoutCell[]
}

export interface LayoutCluster {
  pages: LayoutClusterPage[]
}

// =============================================================================
// 公開 API
// =============================================================================

/**
 * ScanOcrResult から LayoutCluster（行列マトリクス）を復元する。
 * scan-extractor の出力をそのまま入力に取り、座標は無改変で束ねるだけ。
 */
export function buildLayoutCluster(ocr: ScanOcrResult): LayoutCluster {
  const pages: LayoutClusterPage[] = []
  for (const page of ocr.pages) {
    const page1 = page.pageIndex + 1
    const cells = buildCellsForPage(page.elements, page1)
    pages.push({ page: page1, cells })
  }
  return { pages }
}

// =============================================================================
// 内部: 1 ページのセル復元
// =============================================================================

function buildCellsForPage(elements: ScanElement[], page: number): LayoutCell[] {
  // table_cell も含め全要素を対象にする（白塗り対象判定は role で行うため、ここでは束ねるだけ）。
  const items = elements.filter(el => el.text.trim().length > 0 || isWhitespaceBox(el))
  if (items.length === 0) return []

  // 1. 行クラスタ（y 中心近接）
  const rows = clusterIntoRows(items)

  // 2-4. 各行を列分割して cells 化
  const cells: LayoutCell[] = []
  rows.forEach((rowItems, rowIndex) => {
    const sorted = [...rowItems].sort((a, b) => a.bbox.x - b.bbox.x)
    const colGroups = splitIntoColumns(sorted)
    colGroups.forEach((group, colIndex) => {
      cells.push(makeCell(group, page, rowIndex, colIndex, colIndex === 0))
    })
  })
  return cells
}

/** y 中心の近接で行に束ねる。上から順に貪欲クラスタリング。 */
function clusterIntoRows(items: ScanElement[]): ScanElement[][] {
  const sorted = [...items].sort((a, b) => yCenter(a) - yCenter(b))
  const rows: ScanElement[][] = []
  for (const it of sorted) {
    const itCenter = yCenter(it)
    const itHeight = it.bbox.h > 0 ? it.bbox.h : 1
    // 既存行の中で、行の代表 y 中心と近いものを探す
    let placed = false
    for (const row of rows) {
      const rowCenter = avg(row.map(yCenter))
      const rowHeight = avg(row.map(r => (r.bbox.h > 0 ? r.bbox.h : 1)))
      const tolerance = Math.max(itHeight, rowHeight) * ROW_GAP_RATIO
      if (Math.abs(itCenter - rowCenter) <= tolerance) {
        row.push(it)
        placed = true
        break
      }
    }
    if (!placed) rows.push([it])
  }
  // 行を y 昇順に整列
  rows.sort((a, b) => avg(a.map(yCenter)) - avg(b.map(yCenter)))
  return rows
}

/** x 昇順済みの行要素を、ギャップ統計で列グループに分割する。 */
function splitIntoColumns(sortedRow: ScanElement[]): ScanElement[][] {
  if (sortedRow.length <= 1) return [sortedRow]

  // 隣接要素間の x ギャップ（右端 → 次の左端）
  const gaps: number[] = []
  for (let i = 1; i < sortedRow.length; i++) {
    const prevRight = sortedRow[i - 1].bbox.x + sortedRow[i - 1].bbox.w
    const gap = sortedRow[i].bbox.x - prevRight
    gaps.push(gap)
  }
  const medianGap = median(gaps.filter(g => g > 0))
  const relThreshold = Math.max(medianGap * COL_GAP_MULTIPLIER, MIN_COL_GAP_PT)

  const groups: ScanElement[][] = [[sortedRow[0]]]
  for (let i = 1; i < sortedRow.length; i++) {
    const prevRight = sortedRow[i - 1].bbox.x + sortedRow[i - 1].bbox.w
    const gap = sortedRow[i].bbox.x - prevRight
    // 相対判定（中央値倍率）または絶対閾値のどちらかを超えたら列境界。
    // 絶対閾値は要素数が少なく中央値統計が破綻する行（中央値=唯一のギャップ）の保険。
    if (gap > relThreshold || gap >= ABS_COL_GAP_PT) {
      groups.push([sortedRow[i]]) // 新しい列
    } else {
      groups[groups.length - 1].push(sortedRow[i]) // 同じ列に連結
    }
  }
  return groups
}

/** セル化（外接矩形・連結テキスト・各種ヒントを計算）。 */
function makeCell(
  group: ScanElement[],
  page: number,
  rowIndex: number,
  colIndex: number,
  isLeftmostInRow: boolean,
): LayoutCell {
  const sorted = [...group].sort((a, b) => a.bbox.x - b.bbox.x)
  const text = sorted
    .map(g => g.text)
    .join('')
    .trim()
  const bbox = boundingBox(sorted)
  const avgConfidence = avg(sorted.map(g => g.confidence))
  return {
    cellId: `p${page}-r${rowIndex}-c${colIndex}`,
    page,
    rowIndex,
    colIndex,
    text,
    bbox,
    isLeftmostInRow,
    looksEmpty: text.replace(/\s/g, '').length <= EMPTY_TEXT_MAX_LEN,
    labelLexiconHit: LABEL_LEXICON.some(w => text.includes(w)),
    avgConfidence,
  }
}

// =============================================================================
// 幾何ヘルパ
// =============================================================================

function yCenter(el: ScanElement): number {
  return el.bbox.y + el.bbox.h / 2
}

function isWhitespaceBox(el: ScanElement): boolean {
  // 面積を持つが text が空 = 記入枠候補（OCR が枠だけ拾うケース）。
  return el.bbox.w > 0 && el.bbox.h > 0
}

function boundingBox(items: ScanElement[]): {
  x: number
  y: number
  w: number
  h: number
} {
  const x0 = Math.min(...items.map(i => i.bbox.x))
  const y0 = Math.min(...items.map(i => i.bbox.y))
  const x1 = Math.max(...items.map(i => i.bbox.x + i.bbox.w))
  const y1 = Math.max(...items.map(i => i.bbox.y + i.bbox.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}
