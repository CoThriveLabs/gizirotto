/**
 * WhiteoutPrefilter（白塗り v0.5.1、設計書 n6_layout_structure_draft_v0.5.1 §2 / §4）。
 *
 * 目的:
 *   classifyCellRoles に投げる cells をローカルルール R1〜R5 で事前に絞り込み、
 *   判別困難な cell のみ Claude に送る。これにより 60s budget overflow と
 *   Claude 入出力 token 増大を抑える（v0.5 で発生した cell.text 長文化の副作用緩和）。
 *
 * 副作用方向（設計 §5 §11 遵守）:
 *   ローカル誤判定は「白塗りされる cell が減る = 情報残存」に寄せる。
 *   N-6 差別化コア要件「項目名は残し、記入値のみ塗る」と整合し、情報過剰削除には傾かない。
 *
 * SRP（v0.5 教訓 §0 / §2）:
 *   pre-filter ロジックは role-classifier から分離し、本ファイルに集約。R1〜R5 const と
 *   設計とを 1:1 対応させ、後日の設計実装齟齬を防ぐ。
 */

import type { LayoutCell } from './layout-cluster'
import type { CellClassification } from './whiteout-role-classifier'

/**
 * Claude プロンプトに渡す cell.text の先頭 truncate 長（設計 §2 / §13-2）。
 * role 判定は冒頭で十分つくため、長文 cell の入力 token 膨張を抑える。
 * 元 cell.text 自体は破壊せず、Claude 入力時のみ短縮する用途で使う定数。
 * 実機で誤判定が出たら 80 → 120 字に段階的に緩める（§10 撤退条件）。
 */
export const PREFILTER_TEXT_TRUNCATE_LEN = 50

/**
 * R5 用の固定パターン辞書（設計 §2 表 R5 / §13-1）。
 * Wondershare / PDFelement は OCR が拾うウォーターマーク、`^\d+\s*\/\s*\d+$` はページ番号。
 * 実機ログから追加していく。string は「含む」、RegExp は `test()` で評価する。
 */
export const PRINTED_STATIC_PATTERNS: ReadonlyArray<string | RegExp> = [
  'Wondershare',
  'PDFelement',
  /^\d+\s*\/\s*\d+$/,
]

/**
 * prefilter の結果。confirmed はローカル確定済、remaining は Claude へ送る対象。
 * confirmed と remaining の cellId 集合は元 cells の cellId 集合と一致する（取りこぼし不可、§7 Unit 9）。
 */
export interface PrefilterResult {
  confirmed: CellClassification[]
  remaining: LayoutCell[]
}

/**
 * 設計 §2 表 R1〜R5 の順次評価。最初にヒットしたルールでローカル確定。
 * どのルールにもヒットしなければ remaining（Claude 送り）に積む。
 */
export function prefilterCells(cells: LayoutCell[]): PrefilterResult {
  const confirmed: CellClassification[] = []
  const remaining: LayoutCell[] = []

  // R4 用に「ページ最上部 (rowIndex===0) で colIndex===0 のみの単独 cell」を判定するため、
  // 各ページの rowIndex===0 行に何個 cell があるかを事前集計する。
  // （cells は全ページ flat の前提だが、page 別に rowIndex===0 行内 cell 数を数える）
  const topRowCountByPage = new Map<number, number>()
  for (const c of cells) {
    if (c.rowIndex === 0) {
      topRowCountByPage.set(c.page, (topRowCountByPage.get(c.page) ?? 0) + 1)
    }
  }

  for (const cell of cells) {
    const normalizedLen = cell.text.replace(/\s/g, '').length

    // R1 noise-empty: 空白のみ
    if (normalizedLen === 0) {
      confirmed.push({ cellId: cell.cellId, role: 'noise' })
      continue
    }

    // R2 noise-tiny: 1 文字 かつ labelLexiconHit=false
    if (normalizedLen === 1 && cell.labelLexiconHit === false) {
      confirmed.push({ cellId: cell.cellId, role: 'noise' })
      continue
    }

    // R3 label-lexicon-leftmost: 行頭 + ラベル語彙ヒット
    if (cell.labelLexiconHit === true && cell.isLeftmostInRow === true) {
      confirmed.push({ cellId: cell.cellId, role: 'label' })
      continue
    }

    // R4 printed-static-header:
    //   ページ最上部 rowIndex===0 / 全行で唯一の cell (colIndex===0 のみ) /
    //   text.length >= 4 / labelLexiconHit === false
    if (
      cell.rowIndex === 0 &&
      cell.colIndex === 0 &&
      (topRowCountByPage.get(cell.page) ?? 0) === 1 &&
      cell.text.length >= 4 &&
      cell.labelLexiconHit === false
    ) {
      confirmed.push({ cellId: cell.cellId, role: 'printed_static' })
      continue
    }

    // R5 printed-static-wordlist: 辞書パターン一致 or 含有
    if (matchesPrintedStaticPattern(cell.text)) {
      confirmed.push({ cellId: cell.cellId, role: 'printed_static' })
      continue
    }

    remaining.push(cell)
  }

  return { confirmed, remaining }
}

function matchesPrintedStaticPattern(text: string): boolean {
  for (const pattern of PRINTED_STATIC_PATTERNS) {
    if (typeof pattern === 'string') {
      if (text.includes(pattern)) return true
    } else {
      if (pattern.test(text)) return true
    }
  }
  return false
}
