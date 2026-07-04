/**
 * PDF → 画像化レンダラー — 「画像出力 API」経路（worker 隔離必須）。
 *
 * factory 経由で 1 ページごとに pdfjs-render-worker を spawn し、
 * 複数ページ要求時は ZIP まとめて返す。
 * Direct pdfjs 呼出は禁止（DataCloneError リスク + scan-extractor と排他）。
 */
import JSZip from 'jszip'
import { runPdfjsWorker } from '../workers/pdfjs-worker-factory'
import type {
  RenderWorkerInput,
  RenderWorkerOutput,
} from '../workers/pdfjs-render-worker'
import { decideDpi } from './dpi-downgrade'
import type {
  RenderPdfToImagesInput,
  RenderPdfToImagesResult,
  ImageRenderWarning,
} from './image-renderer'

/**
 * PDF → 画像化（factory 経由で worker spawn）。
 *
 * 1 ページずつ render-worker spawn する直列実行。並列化は V-12 で別途検証。
 */
export async function renderPdfToImages(
  input: RenderPdfToImagesInput,
): Promise<RenderPdfToImagesResult> {
  const from = Math.max(1, input.pageRange?.from ?? 1)
  const to = Math.min(input.totalPages, input.pageRange?.to ?? input.totalPages)
  if (from > to) {
    throw new Error('IMAGE_RENDER_INVALID_RANGE')
  }
  const pageCount = to - from + 1

  // dpi 自動降格判定（§3-10-d）
  const dpiDecision = decideDpi(input.requestedDpi, pageCount, input.forceDpi)
  const warnings: ImageRenderWarning[] = []
  if (dpiDecision.downgraded) {
    warnings.push({
      type: 'dpi_auto_downgrade',
      message: '画質を下げて生成しました（処理時間制約）',
      details: {
        originalDpi: dpiDecision.originalDpi,
        actualDpi: dpiDecision.dpi,
        estimatedMs: dpiDecision.estimatedMs,
      },
    })
  }
  if (dpiDecision.estimatedMs > 8000) {
    warnings.push({
      type: 'over_threshold_min_dpi',
      message: '最低画質でも処理時間が長い見込みです',
      details: { estimatedMs: dpiDecision.estimatedMs, dpi: dpiDecision.dpi },
    })
  }

  interface RenderedPage {
    page: number
    imageBytes: Uint8Array
  }
  const rendered: RenderedPage[] = []
  for (let page = from; page <= to; page++) {
    // 各 worker spawn に独立コピーを渡す（structured clone は同じ ArrayBuffer を transfer
    // しないが、念のため。scan-extractor §11-1 #34 と同じ防御）
    const bufCopy = new Uint8Array(input.pdfBytes.byteLength)
    bufCopy.set(input.pdfBytes)
    const out = await runPdfjsWorker<RenderWorkerInput, RenderWorkerOutput>(
      'render',
      {
        pdfBuffer: bufCopy,
        mode: 'render',
        page,
        dpi: dpiDecision.dpi,
        format: input.format,
      },
    )
    if (out.kind !== 'render') {
      throw new Error('IMAGE_RENDER_UNEXPECTED_WORKER_OUTPUT')
    }
    rendered.push({ page: out.page, imageBytes: out.pngBytes })
  }

  // 出力フォーマット（v1.4.10: worker 側で PNG / JPEG 直接出力対応）
  const actualFormat: 'png' | 'jpeg' = input.format === 'jpeg' ? 'jpeg' : 'png'
  const actualExt = actualFormat === 'jpeg' ? 'jpg' : 'png'
  const actualMime = actualFormat === 'jpeg' ? 'image/jpeg' : 'image/png'

  if (input.asZip || rendered.length > 1) {
    const zip = new JSZip()
    for (const p of rendered) {
      const name = `page_${String(p.page).padStart(3, '0')}.${actualExt}`
      zip.file(name, p.imageBytes)
    }
    const zipBytes = await zip.generateAsync({ type: 'uint8array' })
    return {
      bytes: zipBytes,
      contentType: 'application/zip',
      ext: 'zip',
      dpiDecision,
      renderedPages: rendered.length,
      warnings,
    }
  }

  // 単一ページ
  const single = rendered[0]
  return {
    bytes: single.imageBytes,
    contentType: actualMime,
    ext: actualExt,
    dpiDecision,
    renderedPages: 1,
    warnings,
  }
}

/**
 * PDF バイトから総ページ数を取得する（factory 経由、render-worker の numPages mode）。
 * route handler が dpi 自動降格判定前に呼ぶ軽量関数。
 */
export async function getPdfNumPages(pdfBytes: Uint8Array): Promise<number> {
  const bufCopy = new Uint8Array(pdfBytes.byteLength)
  bufCopy.set(pdfBytes)
  const out = await runPdfjsWorker<RenderWorkerInput, RenderWorkerOutput>(
    'render',
    {
      pdfBuffer: bufCopy,
      mode: 'numPages',
      page: 0,
      dpi: 0,
    },
  )
  if (out.kind !== 'numPages') {
    throw new Error('IMAGE_RENDER_NUMPAGES_UNEXPECTED_OUTPUT')
  }
  return out.numPages
}
