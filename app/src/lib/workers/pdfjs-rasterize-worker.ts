/**
 * Scan PDF ラスタライズ用 worker entry（設計書 v1.4.7 §6-7-d / 付録 F）。
 *
 * 役割:
 *   pdfjs-dist + @napi-rs/canvas で PDF 全ページを PNG 化し、
 *   { page, pngBytes, pixelWidth, pixelHeight, widthPt, heightPt, scale } を返す。
 *
 * 親 (`pdf-page-rasterizer.ts.renderPdfPagesToPng`) はファクトリ経由で本ファイルを spawn し、
 * 戻り値を RasterizedPage[] に整形する。
 *
 * Day 2 検証 (`scripts/verify-image-render-speed-worker.ts`) と同一の安全パターンを採用:
 *   - getDocument は worker 内で 1 回だけ呼ぶ（プロセス分離で DataCloneError 回避）
 *   - disableFontFace: true / useSystemFonts: false で Node 環境のフォント解決を抑止
 *   - pdf.destroy は明示呼び出しせず、worker terminate で回収する
 */
import { parentPort, workerData } from 'node:worker_threads'
import path from 'node:path'

/**
 * pdfjs standard_fonts ディレクトリ解決（設計書 v1.4.10 §6-7-b / §11-4 V-13 / 付録 E #40）。
 * 末尾 `/` 必須。pdfjs-render-worker と同一の解決ロジック。
 *
 * **Windows 注意**（v1.4.10 修正、V-12 50/50 失敗の真因）:
 * pdfjs-dist は `standardFontDataUrl` を URL として解釈するため、Windows の `\`
 * セパレータは trailing slash と認識されず "must include trailing slash" エラーになる。
 * `path.posix.join` で `/` 区切りを強制し、cwd の `\` も `/` に変換する。
 * Linux/Vercel 本番は path.sep='/' で偶然動くが、開発機の整合のため統一。
 */
function resolveStandardFontDataUrl(): string {
  const cwdPosix = process.cwd().replace(/\\/g, '/')
  return (
    path.posix.join(cwdPosix, 'node_modules', 'pdfjs-dist', 'standard_fonts') +
    '/'
  )
}

export interface RasterizeWorkerInput {
  /** PDF バイナリ。構造化複製でメインスレッドからコピーされる */
  pdfBuffer: Uint8Array
  /** pdfjs viewport scale（1.0 = 72dpi 相当） */
  scale: number
}

export interface RasterizedPageOutput {
  page: number
  pngBytes: Uint8Array
  pixelWidth: number
  pixelHeight: number
  widthPt: number
  heightPt: number
  scale: number
}

export interface RasterizeWorkerOutput {
  pages: RasterizedPageOutput[]
}

if (parentPort) {
  const port = parentPort
  ;(async () => {
    try {
      const input = workerData as RasterizeWorkerInput
      const { createCanvas } = await import('@napi-rs/canvas')
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

      const pdf = await pdfjs.getDocument({
        data: input.pdfBuffer,
        disableFontFace: true,
        useSystemFonts: false,
        standardFontDataUrl: resolveStandardFontDataUrl(),
      }).promise

      const pages: RasterizedPageOutput[] = []
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p)
        const viewport = page.getViewport({ scale: input.scale })
        const widthPx = Math.ceil(viewport.width)
        const heightPx = Math.ceil(viewport.height)
        const canvas = createCanvas(widthPx, heightPx)
        const ctx = canvas.getContext('2d')

        await page.render({
          // @ts-expect-error: pdfjs Context と @napi-rs/canvas Context は API 互換だが型が異なる
          canvasContext: ctx,
          viewport,
        }).promise

        const pngBuffer = canvas.toBuffer('image/png')
        const widthPt = viewport.width / input.scale
        const heightPt = viewport.height / input.scale

        pages.push({
          page: p,
          pngBytes: new Uint8Array(pngBuffer),
          pixelWidth: widthPx,
          pixelHeight: heightPx,
          widthPt,
          heightPt,
          scale: input.scale,
        })
      }

      port.postMessage({ pages } satisfies RasterizeWorkerOutput)
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      port.postMessage({ __workerError: msg })
    }
  })()
}
