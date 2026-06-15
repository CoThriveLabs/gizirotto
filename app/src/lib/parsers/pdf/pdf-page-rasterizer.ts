import type { PdfPageSize } from './pdf-types'
import { runPdfjsWorker } from '../../workers/pdfjs-worker-factory'
import type {
  RasterizeWorkerInput,
  RasterizeWorkerOutput,
} from '../../workers/pdfjs-rasterize-worker'

/**
 * PDF → ページ画像化ユーティリティ（設計書 v1.4.7 §3-5 / §6-7-d / 付録 F）。
 *
 * スキャン PDF を Tesseract.js に投入するための前処理として、各ページを
 * PNG にラスタライズする。
 *
 * 実装方針（v1.4.7 リファクタ、Day 3 T-1 BLOCKED 解消）:
 *   従来 unpdf.renderPageAsImage 経由 → pdfjs-dist 5.x の「同一プロセス内
 *   2 回目 getDocument」DataCloneError / TypeError に直撃していた
 *   （Day 3 T-1 で scan-extractor.ts:194 → pdf-page-rasterizer.ts:78 で実証）。
 *
 *   本リファクタで内部実装を worker_threads 隔離方式（β 案、Day 2 検証で
 *   5/5 ok / DataCloneError 0 件 実測済）に差し替える。1 リクエスト = 1 worker
 *   spawn により pdfjs ライフサイクルをプロセスごと分離する。
 *
 * 外部 API シグネチャ:
 *   - `renderPdfPagesToPng(data, options) → Promise<RasterizedPage[]>` は不変。
 *   - 呼び出し側（scan-extractor.ts:194 等）の修正は不要。
 *
 * Runtime: Node.js（Edge Runtime 不可、worker_threads は Node 標準）。
 */

export interface RasterizedPage {
  /** 1 始まりのページ番号（PDF アプリ標準と整合） */
  page: number
  /** PNG バイナリ */
  pngBuffer: Uint8Array
  /** 出力画像のピクセル幅 / 高さ（Tesseract.js bbox とのスケール合わせに使用） */
  pixelWidth: number
  pixelHeight: number
  /** ラスタライズ元 PDF ページの pt 単位サイズ（pdfjs viewport 由来） */
  pagePtSize: PdfPageSize
  /** ラスタライズ scale（pt → px の倍率）。Tesseract.js bbox を pt に戻す際に使用 */
  scale: number
}

export interface RasterizeOptions {
  /** scale=2 = 144 dpi 相当（pdfjs viewport は scale 1.0 で 72 dpi）。
   *  Tesseract 推奨 300 dpi 以上に揃えるなら scale>=4 推奨だが、
   *  メモリ + 処理時間とのトレードオフ。デフォルト 2.0 */
  scale?: number
}

const DEFAULT_SCALE = 2.0

/**
 * Buffer から各ページを PNG ラスタライズして返す。
 *
 * 内部は worker_threads で隔離 spawn し、pdfjs getDocument + page.render + canvas.toBuffer を
 * worker 内で完結させる。worker は終了時に terminate され、pdfjs リソースもプロセスごと回収される。
 */
export async function renderPdfPagesToPng(
  data: Uint8Array,
  options: RasterizeOptions = {},
): Promise<RasterizedPage[]> {
  const scale = options.scale ?? DEFAULT_SCALE

  // 一時診断ログ（PDF 内容を含まない構造情報のみ。原因特定後に削除予定）
  if (process.env.PDFJS_WORKER_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.error(
      `[rasterizer] entry: dataType=${data?.constructor?.name ?? typeof data} dataLen=${data?.byteLength ?? 'n/a'} scale=${scale}`,
    )
  }

  // worker への構造化複製で破壊されないよう slice() でコピーを渡す
  let pdfBufferCopy: Uint8Array
  try {
    pdfBufferCopy = data.slice()
  } catch (sliceErr) {
    const msg =
      sliceErr instanceof Error
        ? `${sliceErr.name}: ${sliceErr.message}`
        : String(sliceErr)
    throw new Error(
      `[rasterizer] data.slice() failed (dataType=${data?.constructor?.name ?? typeof data} dataLen=${data?.byteLength ?? 'n/a'}): ${msg}`,
    )
  }
  const input: RasterizeWorkerInput = {
    pdfBuffer: pdfBufferCopy,
    scale,
  }

  let out: RasterizeWorkerOutput
  try {
    out = await runPdfjsWorker<RasterizeWorkerInput, RasterizeWorkerOutput>(
      'rasterize',
      input,
    )
  } catch (workerErr) {
    const msg =
      workerErr instanceof Error
        ? `${workerErr.name}: ${workerErr.message}`
        : String(workerErr)
    throw new Error(`[rasterizer] runPdfjsWorker failed: ${msg}`)
  }

  if (process.env.PDFJS_WORKER_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.error(
      `[rasterizer] worker returned: outType=${out?.constructor?.name ?? typeof out} pagesType=${Array.isArray(out?.pages) ? 'Array' : typeof out?.pages} pagesLen=${out?.pages?.length ?? 'n/a'}`,
    )
  }

  return out.pages.map(p => ({
    page: p.page,
    pngBuffer: p.pngBytes,
    pixelWidth: p.pixelWidth,
    pixelHeight: p.pixelHeight,
    pagePtSize: { page: p.page, width: p.widthPt, height: p.heightPt },
    scale: p.scale,
  }))
}
