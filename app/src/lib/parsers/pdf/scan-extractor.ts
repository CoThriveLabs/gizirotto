/**
 * ScanPdfExtractor（スキャン PDF 用、Mistral OCR + Tesseract.js ハイブリッド）。
 *
 * フロー:
 *   1. Mistral OCR API 呼び出し（markdown / tables HTML / dimensions / wordConfidenceScores）
 *   2. Tesseract.js（PSM=SINGLE_BLOCK 固定）で word + bbox 取得（座標源）
 *   3. 1 と 2 を並列実行（Promise.all）
 *   4. ページごとに merge:
 *      a. 座標系正規化（Tesseract.js px → PDF pt）
 *      b. text 一致 + bbox 紐付け
 *      c. 手書き想定マーカー付与（Tesseract.js confidence < 0.70 → handwriting 候補）
 *      d. テーブルセル統合（Mistral tables HTML 由来）
 *   5. ScanOcrResult として返却
 *
 * Mistral OCR 呼出経路は `document_url + base64 data URI` を採用。SDK v2.2 の
 * OCRRequest.document は FileChunk | DocumentURLChunk | ImageURLChunk のみで、
 * document_buffer 型は存在しない。
 */

import { Mistral } from '@mistralai/mistralai'
import type { PdfPageSize } from './pdf-types'
import type { RasterizedPage } from './pdf-page-rasterizer'

/**
 * 一時診断ヘルパー（PDFJS_WORKER_DEBUG=1 ガード）。
 * PDF 内容には触れず、構造情報のみ出力。`ArrayBuffer.detached`（ES2024 / Node 22+）を
 * 判定に含めて transferred 状態を検知する。
 */
function debugByteState(scope: string, label: string, bytes: Uint8Array | undefined): void {
  if (process.env.PDFJS_WORKER_DEBUG !== '1') return
  const buf = bytes?.buffer as ArrayBuffer | undefined
  // detached プロパティは Node 22+ のみ。未対応環境では undefined
  const detached =
    buf && 'detached' in buf
      ? (buf as ArrayBuffer & { detached: boolean }).detached
      : 'n/a'
  // eslint-disable-next-line no-console
  console.error(
    `[${scope}] ${label}: dataType=${bytes?.constructor?.name ?? typeof bytes} dataLen=${bytes?.byteLength ?? 'n/a'} bufferByteLen=${buf?.byteLength ?? 'n/a'} byteOffset=${bytes?.byteOffset ?? 'n/a'} detached=${detached}`,
  )
}

// =============================================================================
// 公開型
// =============================================================================

export type ScanElementType = 'printed_text' | 'handwriting' | 'table_cell'

export interface ScanElement {
  type: ScanElementType
  text: string
  /** PDF pt 単位 bbox（左上原点、アプリ内部表現） */
  bbox: { x: number; y: number; w: number; h: number }
  /** 0-1 の信頼度（Tesseract 0-100 / Mistral 0-1 をここでは 0-1 統一） */
  confidence: number
  /** merge 由来 */
  source: 'mistral+tesseract' | 'tesseract_only'
  /** type='table_cell' のとき、Mistral OCR tables[].content (HTML) */
  tableHtml?: string
}

export interface ScanOcrResultPage {
  /** 0 始まり（Mistral API 仕様に揃える） */
  pageIndex: number
  /** PDF pt 単位のページサイズ */
  pageSize: { widthPt: number; heightPt: number }
  /** Mistral OCR の markdown（FieldSemanticExtractor 入力用） */
  sourceMarkdown: string
  /** word / table_cell merge 後の要素群 */
  elements: ScanElement[]
}

export interface ScanOcrResult {
  pages: ScanOcrResultPage[]
}

// =============================================================================
// 入力オプション
// =============================================================================

export interface ExtractScanPdfOptions {
  /** Mistral OCR Batch API 切替（現状はリアルタイム API 固定） */
  useBatch?: boolean
  /** カスタム Mistral クライアント（テスト用注入） */
  mistralClient?: Mistral
  /** Tesseract worker を呼び出し側で渡せるようにする（worker 再利用最適化）。
   *  指定なしの場合は内部で createJpnWorker() を呼び、終了時に terminate */
  tesseractWorkerFactory?: () => Promise<import('tesseract.js').Worker>
  /** 504 timeout 対策: 呼び出し側で既に rasterize 済の場合、その結果を渡すと
   *  内部での重複 renderPdfPagesToPng（worker_threads spawn + pdfjs init）をスキップする。
   *  whiteout-preview route のように同一 PDF を別目的（preview PNG）でも rasterize する
   *  ケースで使用。指定なしの場合は従来通り内部 rasterize（後方互換）。 */
  rasterizedPages?: RasterizedPage[]
}

// =============================================================================
// 公開 API
// =============================================================================

/**
 * スキャン PDF (and パス B 経路) から座標付き構造を抽出する。
 *
 * @param pdfBytes PDF バイト列（Uint8Array）
 * @param options  カスタム client / worker 注入オプション
 * @returns ScanOcrResult: ページごとの elements[] + markdown + pageSize
 */
export async function extractScanPdfLayout(
  pdfBytes: Uint8Array,
  options: ExtractScanPdfOptions = {},
): Promise<ScanOcrResult> {
  const apiKey = process.env.MISTRAL_API_KEY
  if (!apiKey && !options.mistralClient) {
    throw new Error('MISTRAL_API_KEY not set in environment')
  }
  const mistral = options.mistralClient ?? new Mistral({ apiKey: apiKey! })
  const model = process.env.MISTRAL_OCR_MODEL ?? 'mistral-ocr-2512'

  // 一時診断ログ（PDFJS_WORKER_DEBUG=1 ガード・構造情報のみ・PDF 内容不含）
  debugByteState('scan-extractor', 'entry', pdfBytes)

  // Mistral と Tesseract の各到着時刻を実測し、Promise.all の遅い方（支配項）を特定。
  const tParallelStart = Date.now()
  const mistralTimedPromise = callMistralOcr(mistral, model, pdfBytes).then(r => {
    console.log(`[N-13 timing] mistral-ocr=${Date.now() - tParallelStart}ms pdfBytes=${pdfBytes.byteLength}`)
    return r
  })
  const tesseractTimedPromise = runTesseractAllPages(pdfBytes, options).then(r => {
    console.log(`[N-13 timing] tesseract-all=${Date.now() - tParallelStart}ms pages=${r.length}`)
    return r
  })

  // 1 + 2: 並列実行（Mistral OCR + Tesseract.js 全ページ）
  const [mistralResp, tesseractPages] = await Promise.all([
    mistralTimedPromise,
    tesseractTimedPromise,
  ])
  console.log(`[N-13 timing] scan-extractor-parallel-total=${Date.now() - tParallelStart}ms`)

  debugByteState('scan-extractor', 'after-Promise.all', pdfBytes)

  // 3: ページごとに merge
  const pages: ScanOcrResultPage[] = mistralResp.pages.map((mPage, i) => {
    const tPage = tesseractPages[i]
    if (!tPage) {
      // Tesseract 側で該当ページが取れていない場合は markdown のみ返す（防御）
      return {
        pageIndex: mPage.index,
        pageSize: {
          widthPt: mPage.dimensions?.width ?? 0,
          heightPt: mPage.dimensions?.height ?? 0,
        },
        sourceMarkdown: mPage.markdown ?? '',
        elements: [],
      }
    }
    return mergePageData(mPage, tPage)
  })

  return { pages }
}

// =============================================================================
// 内部: Mistral OCR 呼出
// =============================================================================

interface MistralPageLike {
  index: number
  markdown: string
  dimensions: { dpi: number; width: number; height: number } | null
  tables?: Array<{ id: string; content: string; format: string }>
  confidenceScores?: {
    wordConfidenceScores?: Array<{ text: string; confidence: number; startIndex: number }>
  } | null
}

interface MistralResponseLike {
  pages: MistralPageLike[]
}

async function callMistralOcr(
  mistral: Mistral,
  model: string,
  pdfBytes: Uint8Array,
): Promise<MistralResponseLike> {
  // document_url + base64 data URI 経路（SDK v2.2 で実機検証済）。
  debugByteState('scan-extractor', 'callMistralOcr-before-Buffer.from', pdfBytes)
  const base64 = Buffer.from(pdfBytes).toString('base64')
  debugByteState('scan-extractor', 'callMistralOcr-after-Buffer.from', pdfBytes)
  const dataUri = `data:application/pdf;base64,${base64}`

  const response = await mistral.ocr.process({
    model,
    document: {
      type: 'document_url',
      documentUrl: dataUri,
    },
    tableFormat: 'html', // colspan/rowspan 保持
    includeImageBase64: false,
    confidenceScoresGranularity: 'word', // word + startIndex + confidence
  })

  // Mistral SDK は型安全だが、当ファイルでは構造的に必要な subset のみ取り扱う
  return response as unknown as MistralResponseLike
}

// =============================================================================
// 内部: Tesseract.js 全ページ実行
// =============================================================================

interface TesseractPageData {
  pageIndex0: number
  pixelWidth: number
  pixelHeight: number
  pagePtSize: PdfPageSize
  words: Array<{
    text: string
    bbox: { x0: number; y0: number; x1: number; y1: number }
    confidence: number
  }>
}

async function runTesseractAllPages(
  pdfBytes: Uint8Array,
  options: ExtractScanPdfOptions,
): Promise<TesseractPageData[]> {
  const { getCachedJpnWorker, runTesseractOnImage } = await import('./tesseract-runner')

  debugByteState('scan-extractor', 'runTesseractAllPages-before-rasterize', pdfBytes)
  // option で rasterize 済データを渡された場合はそれを使う（重複 spawn 回避）
  let rasterized: RasterizedPage[]
  if (options.rasterizedPages && options.rasterizedPages.length > 0) {
    rasterized = options.rasterizedPages
  } else {
    const tRaster = Date.now()
    const { renderPdfPagesToPng } = await import('./pdf-page-rasterizer')
    rasterized = await renderPdfPagesToPng(pdfBytes)
    console.log(
      `[N-13 timing] tesseract-internal-rasterize=${Date.now() - tRaster}ms pages=${rasterized.length}`,
    )
  }

  // warm worker キャッシュを利用。呼び出し側で tesseractWorkerFactory を指定された場合は
  // 従来通りそちらを使う（own = terminate する）。
  let worker: import('tesseract.js').Worker
  let ownsWorker: boolean
  if (options.tesseractWorkerFactory) {
    worker = await options.tesseractWorkerFactory()
    ownsWorker = true
  } else {
    const tWorkerInit = Date.now()
    const cached = await getCachedJpnWorker()
    console.log(
      `[N-13 timing] tesseract-worker-init=${Date.now() - tWorkerInit}ms cached=${cached.wasCached}`,
    )
    worker = cached.worker
    ownsWorker = false
  }

  try {
    const results: TesseractPageData[] = []
    const tPagesStart = Date.now()
    for (const r of rasterized) {
      const tPage = Date.now()
      const ocr = await runTesseractOnImage(worker, r.pngBuffer)
      console.log(
        `[N-13 timing] tesseract-page p${r.page}=${Date.now() - tPage}ms px=${r.pixelWidth}x${r.pixelHeight}`,
      )
      results.push({
        pageIndex0: r.page - 1, // Mistral 互換のため 0-based
        pixelWidth: r.pixelWidth,
        pixelHeight: r.pixelHeight,
        pagePtSize: r.pagePtSize,
        words: ocr.words,
      })
    }
    console.log(
      `[N-13 timing] tesseract-pages-total=${Date.now() - tPagesStart}ms pages=${rasterized.length}`,
    )
    return results
  } catch (e) {
    // warm worker が壊れた状態で cache に居座らないよう除去。次の getCachedJpnWorker() で
    // 新 worker を生成する。terminate は呼ばない（壊れている前提）。
    if (!ownsWorker) {
      const { invalidateCachedJpnWorker } = await import('./tesseract-runner')
      invalidateCachedJpnWorker()
    }
    throw e
  } finally {
    // warm worker は terminate せずプロセスに残す（次リクエストで再利用）
    if (ownsWorker) {
      await worker.terminate()
    }
  }
}

// =============================================================================
// 内部: merge ロジック
// =============================================================================

const HANDWRITING_CONFIDENCE_THRESHOLD = 70 // Tesseract.js は 0-100 スケール

function mergePageData(
  mPage: MistralPageLike,
  tPage: TesseractPageData,
): ScanOcrResultPage {
  const pageSize = {
    widthPt: tPage.pagePtSize.width,
    heightPt: tPage.pagePtSize.height,
  }
  // Tesseract bbox は ラスタライズ画像 px 単位。
  // PDF pt 単位に戻すには pagePtSize / pixel(W|H) の比率でスケールする
  const sx = pageSize.widthPt / tPage.pixelWidth
  const sy = pageSize.heightPt / tPage.pixelHeight

  // Mistral 由来の word を text → confidence マップに（merge 時の参照用）
  // word 文字列が複数回出現する可能性があるため Map<string, number[]>
  const mistralConfidenceByWord = new Map<string, number[]>()
  for (const w of mPage.confidenceScores?.wordConfidenceScores ?? []) {
    const arr = mistralConfidenceByWord.get(w.text) ?? []
    arr.push(w.confidence)
    mistralConfidenceByWord.set(w.text, arr)
  }
  // Map から「次の利用可能な confidence」を pop するためのインデックス管理
  const mistralIndexByWord = new Map<string, number>()

  // 1. Tesseract words[] を ScanElement[] に変換、Mistral と text 一致で confidence merge
  const elements: ScanElement[] = []
  for (const tw of tPage.words) {
    const ptBbox = {
      x: tw.bbox.x0 * sx,
      y: tw.bbox.y0 * sy,
      w: (tw.bbox.x1 - tw.bbox.x0) * sx,
      h: (tw.bbox.y1 - tw.bbox.y0) * sy,
    }
    // Tesseract confidence は 0-100、0-1 に正規化
    const tConfidence = tw.confidence / 100

    // text 一致で Mistral confidence を消費
    const mistralPool = mistralConfidenceByWord.get(tw.text)
    let mergedConfidence = tConfidence
    let source: ScanElement['source'] = 'tesseract_only'
    if (mistralPool && mistralPool.length > 0) {
      const idx = mistralIndexByWord.get(tw.text) ?? 0
      if (idx < mistralPool.length) {
        const mConf = mistralPool[idx]
        // 完全一致 word: Tesseract bbox + Mistral confidence を採用
        mergedConfidence = mConf
        source = 'mistral+tesseract'
        mistralIndexByWord.set(tw.text, idx + 1)
      }
    }

    // 手書き想定マーカー: Tesseract confidence < 70 (0.70) を handwriting 候補
    // ※ 厳密な手書き判定ではない
    const elementType: ScanElementType =
      tw.confidence < HANDWRITING_CONFIDENCE_THRESHOLD ? 'handwriting' : 'printed_text'

    elements.push({
      type: elementType,
      text: tw.text,
      bbox: ptBbox,
      confidence: mergedConfidence,
      source,
    })
  }

  // 2. テーブルセル統合（Mistral pages[].tables[] HTML 由来）。
  //   1) セル文字列が単一 word と完全一致 → 該当 word を table_cell 化
  //   2) セル文字列が Tesseract 連続 word の連結（読み順）で取れる → 全該当 word を table_cell 化
  //      （例: セル「2026年5月24日」が Tesseract で ["2026", "年", "5", "月", "24", "日"] に分割）
  for (const table of mPage.tables ?? []) {
    const cellTexts = extractCellTextsFromHtml(table.content)
    if (cellTexts.length === 0) continue

    // 完全一致セット（高速 lookup）
    const exactSet = new Set(cellTexts)
    const matchedIndices = new Set<number>()
    // matched range に対応する Mistral cell text を保持し、確定後に該当 element の text を
    // Mistral 由来へ上書きする。「先頭要素に text 集約 + 後続要素を空文字化」方式。
    // 理由: layout-cluster.ts の makeCell() は word を x 順に join するだけなので、
    // 先頭集約 + 後続空文字 にしておけば join 結果がそのまま Mistral cell text になる
    // （layout-cluster.ts に変更を加えずに済む）。
    const cellTextByIndex = new Map<number, string>() // index → 上書きする text（先頭のみ非空）

    // 2-1. 完全一致 pass
    for (let i = 0; i < elements.length; i++) {
      if (exactSet.has(elements[i].text)) {
        matchedIndices.add(i)
        // 完全一致は range が 1 要素のみなので、その element 自身を上書き値とする
        // （実質 no-op だが、partial match と扱いを統一して decode 後 entity 等を反映）
        cellTextByIndex.set(i, elements[i].text)
      }
    }

    // 2-2. partial match pass（連続 word の連結）
    // 各セルについて、要素配列内で連続 N 個を連結した文字列がセルテキストに一致する範囲を探す
    for (const cellText of cellTexts) {
      // 1 文字以下のセルは partial match の対象外（誤マッチ防止）
      if (cellText.length <= 1) continue
      for (let start = 0; start < elements.length; start++) {
        if (matchedIndices.has(start)) continue
        let joined = ''
        const range: number[] = []
        for (let k = start; k < elements.length && joined.length < cellText.length + 4; k++) {
          if (matchedIndices.has(k)) break
          joined += elements[k].text
          range.push(k)
          if (joined === cellText) {
            // 完全に連結一致 → 全 word を table_cell 化
            for (const idx of range) matchedIndices.add(idx)
            // 先頭要素に Mistral cell text 集約、後続は空文字
            cellTextByIndex.set(range[0], cellText)
            for (let r = 1; r < range.length; r++) {
              cellTextByIndex.set(range[r], '')
            }
            break
          }
          if (!cellText.startsWith(joined)) {
            // 接頭辞すら一致しないなら start を前進
            break
          }
        }
      }
    }

    // 確定した index 群を table_cell に格上げ + text 上書き
    for (const idx of matchedIndices) {
      elements[idx].type = 'table_cell'
      elements[idx].tableHtml = table.content
      const overrideText = cellTextByIndex.get(idx)
      if (overrideText !== undefined) {
        elements[idx].text = overrideText
      }
    }
  }

  return {
    pageIndex: mPage.index,
    pageSize,
    sourceMarkdown: mPage.markdown,
    elements,
  }
}

/**
 * Mistral OCR の table content (HTML) からセル文字列を抽出する parser。
 * <td>...</td> / <th>...</th> 内のテキストを返す。
 * 主要 HTML entity（&amp; &lt; &gt; &quot; &#39; 数値参照）を decode する。
 */
function extractCellTextsFromHtml(html: string): string[] {
  const out: string[] = []
  const re = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    // 内部の HTML タグを除去 → entity decode → 前後 trim
    const stripped = m[1].replace(/<[^>]+>/g, '')
    const decoded = decodeHtmlEntities(stripped).trim()
    if (decoded.length > 0) out.push(decoded)
  }
  return out
}

/**
 * 主要 HTML entity を decode する。
 * Mistral OCR の tables[].content は HTML format で colspan/rowspan 含むため
 * 「&amp;」「&lt;」「&gt;」「&quot;」「&#39;」「&#xNN;」「&#NN;」を実体化する。
 *
 * 完全な HTML entity リストは扱わない（議事録テンプレに登場する文字種に絞り、
 * 名前付き entity は基本 5 種類 + 数値参照のみ対応）。
 */
function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // &amp; は最後に変換（早く変換すると &amp;lt; → <lt; のような誤変換になる）
    .replace(/&amp;/g, '&')
}

// =============================================================================
// テスト / ベンチ用 internal export
//
// 本 export はテストとベンチ計測用途のみ。プロダクトコードから直接参照しないこと。
// 公開 API として安定化する意図はない（実装変更時に併せて更新する想定）。
// =============================================================================

export const __internal_scan_extractor = {
  mergePageData,
  extractCellTextsFromHtml,
  decodeHtmlEntities,
}

export type __Internal_MistralPageLike = MistralPageLike
export type __Internal_TesseractPageData = TesseractPageData
