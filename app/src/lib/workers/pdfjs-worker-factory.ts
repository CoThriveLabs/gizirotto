/**
 * pdfjs-dist worker_threads 共通ファクトリ（設計書 v1.4.7 §6-7-d / 付録 F）。
 *
 * 目的:
 *   pdfjs-dist 5.x の「同一プロセス内 2 回目 getDocument」DataCloneError / TypeError を
 *   回避するため、1 リクエスト = 1 worker spawn で隔離する。
 *
 * 2 用途対応:
 *   - kind = 'render'    : 議事録 PDF → PNG 出力（API 経路、§6-7 render-image API）
 *   - kind = 'rasterize' : Scan PDF → PNG ラスタライズ（OCR 前処理、§3-5 scan-extractor）
 *
 * B-3 対応 (2026-05-28): worker entry を別 .ts ファイル参照する従来方式は
 * Next.js 15 + Vercel bundle で resolve 不可だったため、**inline 文字列 + Worker(code, eval:true)** に
 * 切替。bundling 設定への依存を完全排除。pdfjs / @napi-rs/canvas は factory トップレベルで
 * dummy import を持ち、Next.js の static trace に node_modules を含めさせる。
 */
import { Worker } from 'node:worker_threads'
import pLimit from 'p-limit'

// Next.js static trace 用 dummy import (B-3 inline 化対応)。
// worker コードは文字列 eval で実行されるため、bundler はこの依存を静的解析できない。
// factory トップレベルで参照することで `pdfjs-dist` / `@napi-rs/canvas` の node_modules を
// Vercel Function bundle に含めさせる。実 import なので副作用なし（typeof 参照のみで未使用警告抑制）。
import 'pdfjs-dist/legacy/build/pdf.mjs'
import '@napi-rs/canvas'

export type WorkerKind = 'render' | 'rasterize'

function resolveConcurrency(): number {
  const raw = process.env.WORKER_POOL_CONCURRENCY
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 1 && n <= 100) return n
  }
  return 5
}

const WORKER_POOL_CONCURRENCY = resolveConcurrency()
const workerLimit = pLimit(WORKER_POOL_CONCURRENCY)

export function getWorkerPoolConcurrency(): number {
  return WORKER_POOL_CONCURRENCY
}

export function getWorkerPoolStats(): { concurrency: number; pending: number; activeCount: number } {
  return {
    concurrency: WORKER_POOL_CONCURRENCY,
    pending: workerLimit.pendingCount,
    activeCount: workerLimit.activeCount,
  }
}

/**
 * Render worker のコード本体（pdfjs-render-worker.ts と等価ロジックの inline 文字列）。
 *
 * 元ファイル pdfjs-render-worker.ts と同期保守必須。pdfjs / @napi-rs/canvas を
 * 動的 import し、`workerData.mode` で render or numPages を分岐。
 *
 * 注意:
 * - `parentPort` / `workerData` は worker_threads 標準モジュールから取得
 * - エラーは `{ __workerError: msg }` で postMessage（factory 側で reject に変換）
 * - standardFontDataUrl は posix path 強制（Windows 開発機 + Linux 本番の整合）
 */
const RENDER_WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');

function clampJpegQuality(q) {
  if (typeof q !== 'number' || !Number.isFinite(q)) return 0.85;
  return Math.max(0, Math.min(1, q));
}

function resolveStandardFontDataUrl() {
  const cwdPosix = process.cwd().replace(/\\\\/g, '/');
  return path.posix.join(cwdPosix, 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/';
}

(async () => {
  const port = parentPort;
  if (!port) return;
  try {
    const input = workerData;
    const { createCanvas } = await import('@napi-rs/canvas');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    const pdf = await pdfjs.getDocument({
      data: input.pdfBuffer,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: resolveStandardFontDataUrl(),
    }).promise;

    if (input.mode === 'numPages') {
      port.postMessage({ kind: 'numPages', numPages: pdf.numPages });
      return;
    }

    if (input.page < 1 || input.page > pdf.numPages) {
      throw new Error('page out of range: ' + input.page + ' / numPages=' + pdf.numPages);
    }
    const page = await pdf.getPage(input.page);
    const scale = input.dpi / 72;
    const viewport = page.getViewport({ scale });
    const widthPx = Math.ceil(viewport.width);
    const heightPx = Math.ceil(viewport.height);
    const canvas = createCanvas(widthPx, heightPx);
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport }).promise;

    const format = input.format === 'jpeg' ? 'jpeg' : 'png';
    const imageBuffer = format === 'jpeg'
      ? canvas.toBuffer('image/jpeg', clampJpegQuality(input.jpegQuality))
      : canvas.toBuffer('image/png');

    port.postMessage({
      kind: 'render',
      page: input.page,
      dpi: input.dpi,
      pngBytes: new Uint8Array(imageBuffer),
      format,
      pixelWidth: widthPx,
      pixelHeight: heightPx,
    });
  } catch (err) {
    const msg = err instanceof Error ? (err.name + ': ' + err.message) : String(err);
    port.postMessage({ __workerError: msg });
  }
})();
`

/**
 * Rasterize worker のコード本体（pdfjs-rasterize-worker.ts と等価ロジックの inline 文字列）。
 * 全ページを scale で PNG 化して pages[] で返す。
 */
const RASTERIZE_WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');

function resolveStandardFontDataUrl() {
  const cwdPosix = process.cwd().replace(/\\\\/g, '/');
  return path.posix.join(cwdPosix, 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/';
}

(async () => {
  const port = parentPort;
  if (!port) return;
  try {
    const input = workerData;
    const { createCanvas } = await import('@napi-rs/canvas');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    const pdf = await pdfjs.getDocument({
      data: input.pdfBuffer,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: resolveStandardFontDataUrl(),
    }).promise;

    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: input.scale });
      const widthPx = Math.ceil(viewport.width);
      const heightPx = Math.ceil(viewport.height);
      const canvas = createCanvas(widthPx, heightPx);
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport }).promise;

      const pngBuffer = canvas.toBuffer('image/png');
      const widthPt = viewport.width / input.scale;
      const heightPt = viewport.height / input.scale;

      pages.push({
        page: p,
        pngBytes: new Uint8Array(pngBuffer),
        pixelWidth: widthPx,
        pixelHeight: heightPx,
        widthPt,
        heightPt,
        scale: input.scale,
      });
    }

    port.postMessage({ pages });
  } catch (err) {
    const msg = err instanceof Error ? (err.name + ': ' + err.message) : String(err);
    port.postMessage({ __workerError: msg });
  }
})();
`

export async function runPdfjsWorker<TInput, TOutput>(
  kind: WorkerKind,
  workerData: TInput,
): Promise<TOutput> {
  const code = kind === 'render' ? RENDER_WORKER_CODE : RASTERIZE_WORKER_CODE

  if (process.env.PDFJS_WORKER_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.error(
      `[pdfjs-worker-factory] kind=${kind} mode=inline-eval poolConcurrency=${WORKER_POOL_CONCURRENCY} pending=${workerLimit.pendingCount} active=${workerLimit.activeCount}`,
    )
  }

  return workerLimit(() => spawnWorker<TInput, TOutput>(code, workerData, kind))
}

function spawnWorker<TInput, TOutput>(
  code: string,
  workerData: TInput,
  kind: WorkerKind,
): Promise<TOutput> {
  return new Promise<TOutput>((resolve, reject) => {
    let settled = false
    let worker: Worker
    try {
      // eval:true で文字列 code を worker 起動。ファイル resolve 不要のため
      // Next.js bundling / outputFileTracingIncludes 設定に依存しない。
      worker = new Worker(code, { eval: true, workerData })
    } catch (spawnErr) {
      const msg =
        spawnErr instanceof Error
          ? `${spawnErr.name}: ${spawnErr.message}`
          : String(spawnErr)
      reject(new Error(`pdfjs worker spawn failed (${kind}): ${msg}`))
      return
    }

    const cleanup = () => {
      worker.removeAllListeners()
      worker.terminate().catch(() => {})
    }

    worker.once('message', (result: TOutput | { __workerError: string }) => {
      if (settled) return
      settled = true
      if (
        result &&
        typeof result === 'object' &&
        '__workerError' in (result as Record<string, unknown>)
      ) {
        const err = (result as { __workerError: string }).__workerError
        cleanup()
        reject(new Error(err))
        return
      }
      cleanup()
      resolve(result as TOutput)
    })

    worker.once('error', err => {
      if (settled) return
      settled = true
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    })

    worker.once('exit', code => {
      if (settled) return
      settled = true
      if (code !== 0) {
        reject(new Error(`pdfjs worker (${kind}) exited with code ${code}`))
      } else {
        reject(new Error(`pdfjs worker (${kind}) exited without postMessage`))
      }
    })
  })
}
