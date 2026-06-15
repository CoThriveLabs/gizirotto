/**
 * 画像出力 API 用 worker entry（設計書 v1.4.7 §6-7-d / §6-7 render-image API / 付録 F）。
 *
 * 役割:
 *   議事録 PDF を任意の 1 ページ + 任意 dpi で PNG 化して返す。
 *   render-image API（§6-7 NEW）から ファクトリ経由で spawn される想定。
 *   Phase 3 第 2 週で API route 側実装予定（本ファイルは worker 単体として先行配備）。
 *
 * Day 2 検証 `scripts/verify-image-render-speed-worker.ts` の安全パターンを踏襲。
 */
import { parentPort, workerData } from 'node:worker_threads'
import path from 'node:path'

/**
 * pdfjs standard_fonts ディレクトリ解決（設計書 v1.4.10 §6-7-b / §11-4 V-13 / 付録 E #40）。
 *
 * 末尾 `/` 必須（pdfjs 仕様）。設定漏れると Helvetica 等の Warning + フォント幅計算失敗
 * → bbox 検出ズレで差別化コア「±4px」DoD 直撃リスク。
 *
 * Vercel Function: outputFileTracingIncludes で
 * `./node_modules/pdfjs-dist/standard_fonts/**` を含めるため process.cwd() 基準で解決する。
 */
/**
 * JPEG 品質を 0.0-1.0 に clamp。省略時 0.85（仕様書 §1-6 標準）。
 * @napi-rs/canvas の toBuffer('image/jpeg', quality) は 0-1 の number を受ける。
 */
function clampJpegQuality(q: number | undefined): number {
  if (typeof q !== 'number' || !Number.isFinite(q)) return 0.85
  return Math.max(0, Math.min(1, q))
}

function resolveStandardFontDataUrl(): string {
  // **Windows 注意**（v1.4.10 修正、V-12 50/50 失敗の真因 / 2 度目の片側修正漏れ回避）:
  // pdfjs-dist は `standardFontDataUrl` を URL として解釈するため、Windows の `\`
  // セパレータは trailing slash と認識されず "must include trailing slash" エラーになる。
  // `path.posix.join` で `/` 区切りを強制し、cwd の `\` も `/` に変換する。
  // Linux/Vercel 本番は path.sep='/' で偶然動くが、開発機の整合のため統一。
  // pdfjs-rasterize-worker.ts と同一実装（共通バグ、grep で両ファイル網羅確認必須）。
  const cwdPosix = process.cwd().replace(/\\/g, '/')
  return (
    path.posix.join(cwdPosix, 'node_modules', 'pdfjs-dist', 'standard_fonts') +
    '/'
  )
}

export interface RenderWorkerInput {
  pdfBuffer: Uint8Array
  /**
   * 'render': 指定 page を画像化（page / dpi 必須）
   * 'numPages': ページ数のみ取得（page / dpi 不要、page=0 / dpi=0 を渡す）
   *  - dpi 自動降格 (§3-10-d) の見積前に呼び、レンダリング前にページ数確定に使う
   */
  mode?: 'render' | 'numPages'
  /** 1 始まりページ番号（mode='render' のみ） */
  page: number
  /** 出力解像度（72/150/300 想定、§3-10-d dpi 自動降格対象）*/
  dpi: number
  /**
   * 出力フォーマット。
   * 省略時は 'png'（既存挙動互換）。
   * 'jpeg' 時は @napi-rs/canvas の toBuffer('image/jpeg', { quality }) を使用。
   */
  format?: 'png' | 'jpeg'
  /** JPEG 品質 (0.0-1.0、省略時 0.85)。'png' 時は無視 */
  jpegQuality?: number
}

export type RenderWorkerOutput =
  | {
      kind: 'render'
      page: number
      dpi: number
      /** 互換性のため名称は pngBytes 維持。実体は format に応じた PNG または JPEG バイト列 */
      pngBytes: Uint8Array
      /** 実際の出力フォーマット */
      format: 'png' | 'jpeg'
      pixelWidth: number
      pixelHeight: number
    }
  | {
      kind: 'numPages'
      numPages: number
    }

if (parentPort) {
  const port = parentPort
  ;(async () => {
    try {
      const input = workerData as RenderWorkerInput
      const { createCanvas } = await import('@napi-rs/canvas')
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

      const pdf = await pdfjs.getDocument({
        data: input.pdfBuffer,
        disableFontFace: true,
        useSystemFonts: false,
        standardFontDataUrl: resolveStandardFontDataUrl(),
      }).promise

      // numPages モード: ページ数のみ返却して終了
      if (input.mode === 'numPages') {
        port.postMessage({
          kind: 'numPages',
          numPages: pdf.numPages,
        } satisfies RenderWorkerOutput)
        return
      }

      if (input.page < 1 || input.page > pdf.numPages) {
        throw new Error(`page out of range: ${input.page} / numPages=${pdf.numPages}`)
      }
      const page = await pdf.getPage(input.page)
      const scale = input.dpi / 72
      const viewport = page.getViewport({ scale })
      const widthPx = Math.ceil(viewport.width)
      const heightPx = Math.ceil(viewport.height)
      const canvas = createCanvas(widthPx, heightPx)
      const ctx = canvas.getContext('2d')

      await page.render({
        // @ts-expect-error: pdfjs Context と @napi-rs/canvas Context は API 互換だが型が異なる
        canvasContext: ctx,
        viewport,
      }).promise

      const format: 'png' | 'jpeg' = input.format === 'jpeg' ? 'jpeg' : 'png'
      const imageBuffer =
        format === 'jpeg'
          ? canvas.toBuffer('image/jpeg', clampJpegQuality(input.jpegQuality))
          : canvas.toBuffer('image/png')

      port.postMessage({
        kind: 'render',
        page: input.page,
        dpi: input.dpi,
        pngBytes: new Uint8Array(imageBuffer),
        format,
        pixelWidth: widthPx,
        pixelHeight: heightPx,
      } satisfies RenderWorkerOutput)
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      port.postMessage({ __workerError: msg })
    }
  })()
}
