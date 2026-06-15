/**
 * Tesseract.js word 抽出ラッパー（設計書 v1.4.2 §3-5-b / §3-5-c）。
 *
 * 役割: PNG 画像を Tesseract.js（jpn.traineddata + PSM=SINGLE_BLOCK）に投入し、
 *       word 単位の text + bbox + confidence を取得する。
 *
 * 検証結果:
 *   - PSM=SINGLE_BLOCK で日本語精度 100% 達成（PSM=AUTO は 38.9% に低下、絶対使用禁止）
 *   - 処理時間 約 307ms / ページ
 *   - lines / words / blocks の階層 bbox 取得可能
 *
 * `PSM.AUTO` 絶対禁止（精度 38.9% 地雷、議事録テンプレでページ上半分欠落）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createWorker, PSM, type Worker as TesseractWorker } from 'tesseract.js'

// N-13b 真因対策 (2026-05-29): webpack が bundle 時に
// `createRequire(import.meta.url).resolve(...)` を **数値 module ID (99924)** に置換し、
// require.resolve が string でなく number を返す → tesseract.js 内部の path.dirname(99924) /
// new Worker(99924) で `path argument must be string, received number 99924` 即死。
// 診断ログのスタックトレースで確定 (resolveTesseractCorePath の path.dirname で落ちていた)。
// → require.resolve / createRequire を完全に廃止し、process.cwd() を基準に node_modules の
// 絶対パスを path.join で直接構築する。webpack の static 変換を一切受けないため根本回避。
// node_modules は next.config.mjs の outputFileTracingIncludes で /var/task に同梱済。

/**
 * tesseract.js / tesseract.js-core の node_modules を含む基準ディレクトリを解決する。
 * Vercel の Root Directory 設定や cwd の解釈ブレで node_modules の展開先が
 * `/var/task`（Root=app/）か `/var/task/app`（Root=repo root）か不確実なため、
 * 候補を順番に fs.existsSync で実在チェックし、最初に見つかったディレクトリを採用する。
 */
function resolveBaseDir(): string {
  const cwd = process.cwd()
  const candidates = [
    cwd, // /var/task (Root=app/) or local app/
    path.join(cwd, 'app'), // /var/task/app (Root=repo root)
    // ローカル dev (cwd がリポジトリ root のとき) のための保険
    path.join(cwd, 'projects', 'apps', 'minutes-app', 'app'),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'node_modules', 'tesseract.js-core'))) {
      return dir
    }
  }
  return cwd
}

function resolveTesseractWorkerPath(): string {
  return path.join(
    resolveBaseDir(),
    'node_modules',
    'tesseract.js',
    'src',
    'worker-script',
    'node',
    'index.js',
  )
}

function resolveTesseractCorePath(): string {
  // wasm バリアント (simd/relaxed/lstm) は runtime で CPU 機能検出して選択するため、
  // パッケージのルート (= tesseract-core.js が居るディレクトリ) を渡す。
  return path.join(resolveBaseDir(), 'node_modules', 'tesseract.js-core')
}

function resolveLangPath(): string {
  // Vercel の Root Directory 設定や cwd の解釈ブレで jpn.traineddata の展開先が
  // ① `/var/task/jpn.traineddata` (Root=app/) または ② `/var/task/app/jpn.traineddata`
  // (Root=repo root) のどちらに来るか不確実なため、候補を順番に fs.existsSync で
  // 実在チェックし、最初に見つかったディレクトリを langPath として採用する。
  // N-13b (2026-05-29): tesseract.js worker-script/index.js:151 は local file 経路で
  // `${langPath}/${lang}.traineddata` と自前で `/` を付与する。langPath 末尾に `/` を
  // 付けると `/var/task/app//jpn.traineddata.gz` のダブルスラッシュになるため末尾 `/` は付けない。
  const cwd = process.cwd()
  const candidates = [
    cwd,                                  // /var/task (Root=app/) or local app/
    path.join(cwd, 'app'),                // /var/task/app (Root=repo root)
    // ローカル dev (cwd がリポジトリ root のとき) のための保険
    path.join(cwd, 'projects', 'apps', 'minutes-app', 'app'),
  ]
  for (const dir of candidates) {
    const full = path.join(dir, 'jpn.traineddata')
    const exists = fs.existsSync(full)
    // N-13b 診断 (2026-05-29): traineddata が各候補で実在するか確定する。
    console.log(`[N-13 langPath] candidate=${full} exists=${exists}`)
    if (exists) {
      console.log(`[N-13 langPath] adopted=${dir}`)
      return dir
    }
  }
  // どれも見つからなければ cwd を返して失敗時のエラーメッセージで気付けるようにする
  // (静かなる劣化を避ける)
  console.log(`[N-13 langPath] NOT FOUND in any candidate, fallback=${cwd}`)
  return cwd
}

export interface TesseractWord {
  /** 検出テキスト */
  text: string
  /** 画像 px 単位の bbox（後段で PDF pt に正規化する） */
  bbox: { x0: number; y0: number; x1: number; y1: number }
  /** 0-100 の信頼度（Tesseract.js v7 仕様） */
  confidence: number
}

export interface TesseractLine {
  text: string
  bbox: { x0: number; y0: number; x1: number; y1: number }
  words: TesseractWord[]
}

export interface TesseractImageResult {
  /** ページ全体テキスト（改行 / 空白込み） */
  text: string
  /** ページ全体の信頼度（0-100） */
  confidence: number
  /** ライン階層 + word 階層の bbox */
  lines: TesseractLine[]
  /** word の総数（フラット） */
  words: TesseractWord[]
}

/**
 * worker を 1 つ用意してくれる helper。
 * 議事録テンプレ用途では PSM.SINGLE_BLOCK 固定（Day 2 検証結果）。
 */
export async function createJpnWorker(): Promise<TesseractWorker> {
  // N-13: OEM は第2引数 undefined で default 維持（設計書未規定、変更スコープ外）。
  // workerPath / corePath / langPath のみ Vercel bundle 経路に合わせて明示。
  //
  // N-13b (2026-05-29): cacheMethod='none' で tesseract.js 内部の cache read/write を全停止。
  // Vercel `/var/task` は read-only のため fs.writeFile 経路（worker-script/index.js:181）で
  // 内部例外 → recognize 連鎖失敗の疑い。warm worker キャッシュ機構は別レイヤで持つので
  // tesseract.js cache 機構自体は不要。worker-script L103/L179/L272 全ガード通過確認済。
  const tCreate = Date.now()
  // N-13b 診断 (2026-05-29): createWorker 直前に各 path を確定出力。
  // 99924 が recognize 到達前 (worker 生成 / traineddata ロード段階) で出ているか切り分ける。
  const dbgWorkerPath = resolveTesseractWorkerPath()
  const dbgCorePath = resolveTesseractCorePath()
  const dbgLangPath = resolveLangPath()
  // N-13b 診断 (2026-05-29): cwd ベース直接構築した各 path が /var/task で実在するか検証。
  console.log(
    `[N-13] resolved workerPath=${dbgWorkerPath} exists=${fs.existsSync(dbgWorkerPath)}`,
  )
  console.log(
    `[N-13] resolved corePath=${dbgCorePath} exists=${fs.existsSync(dbgCorePath)}`,
  )
  console.log(
    `[N-13] before createWorker workerPath=${dbgWorkerPath} corePath=${dbgCorePath} langPath=${dbgLangPath}`,
  )
  // N-13b 真因対策 (2026-05-29): gzip: false で非圧縮 `jpn.traineddata` を直接読ませる。
  // デフォルト gzip: true だと worker-script/index.js:151 が `${lang}.traineddata.gz` を
  // 探し ENOENT → worker crash → hang → 60s timeout。同梱しているのは非圧縮版なので false。
  // なお worker-script:162 で gzip magic number を自動検出し gunzip もするため、
  // 万一圧縮版でも壊れない安全側の設定。
  const worker = await createWorker('jpn', undefined, {
    workerPath: dbgWorkerPath,
    corePath: dbgCorePath,
    langPath: dbgLangPath,
    cacheMethod: 'none',
    gzip: false,
  })
  console.log(`[N-13 timing] createJpnWorker.createWorker=${Date.now() - tCreate}ms`)
  const tParams = Date.now()
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK })
  console.log(`[N-13 timing] createJpnWorker.setParameters=${Date.now() - tParams}ms`)
  return worker
}

/**
 * N-13 対策 (2026-05-29): プロセス内で 1 個だけ jpn worker を保持し warm 再利用する。
 *
 * Vercel Fluid Compute では同一インスタンスが複数リクエストを処理するため、
 * 2 回目以降は jpn.traineddata (10MB+) DL + WASM init をスキップできる。
 * cold start でも初回のみコストを払えば以後 warm。
 *
 * 並行リクエストで初期化が走るのを防ぐため initPromise でシリアル化。
 * warm worker は terminate しない（プロセス終了時に OS 回収）。
 *
 * テスト互換: 既存の createJpnWorker() は残す（直接呼ぶテスト互換のため）。
 */
const WARM_WORKER_GLOBAL_KEY = '__minutesAppJpnWorker__'
type WarmWorkerSlot = {
  worker?: TesseractWorker
  initPromise?: Promise<TesseractWorker>
}

function getWarmWorkerSlot(): WarmWorkerSlot {
  const g = globalThis as unknown as Record<string, unknown>
  const existing = g[WARM_WORKER_GLOBAL_KEY] as WarmWorkerSlot | undefined
  if (existing) return existing
  const slot: WarmWorkerSlot = {}
  g[WARM_WORKER_GLOBAL_KEY] = slot
  return slot
}

export async function getCachedJpnWorker(): Promise<{
  worker: TesseractWorker
  wasCached: boolean
}> {
  const slot = getWarmWorkerSlot()
  if (slot.worker) return { worker: slot.worker, wasCached: true }
  if (slot.initPromise) {
    const worker = await slot.initPromise
    return { worker, wasCached: true }
  }
  slot.initPromise = (async () => {
    try {
      const w = await createJpnWorker()
      slot.worker = w
      return w
    } finally {
      slot.initPromise = undefined
    }
  })()
  const worker = await slot.initPromise
  return { worker, wasCached: false }
}

/**
 * 壊れた worker を cache から落とす。
 * recognize 失敗時に呼ぶと、次の getCachedJpnWorker() で新しい worker を再生成する。
 * 壊れている前提で terminate は行わない（Promise hang を避ける）。
 */
export function invalidateCachedJpnWorker(): void {
  const slot = getWarmWorkerSlot()
  slot.worker = undefined
}

/**
 * PNG 画像 1 枚に対して OCR を実行し、word + bbox を返す。
 * 呼び出し側は複数画像で同じ worker を使い回せる（worker は重い）。
 */
export async function runTesseractOnImage(
  worker: TesseractWorker,
  pngBuffer: Uint8Array,
): Promise<TesseractImageResult> {
  // N-13b (2026-05-29): tesseract.js v7 の ImageLike 型は `string | HTMLImageElement |
  // HTMLCanvasElement | HTMLVideoElement` のみで Buffer/Uint8Array は型定義に存在しない。
  // 実装上は受け付けるが特定経路で `path must be string, received number (99924)` エラーが
  // 出る (99924 = PNG buffer.byteLength bleed)。
  // → base64 data URI 化して **string 経路** に確定させ、loadImage.js の data: 分岐
  // (`Buffer.from(image.split(',')[1], 'base64')`) を必ず通すことで型曖昧さを根本回避。
  const b64 = Buffer.from(pngBuffer).toString('base64')
  const imgInput = `data:image/png;base64,${b64}`
  console.log(
    `[N-13 timing] runTesseractOnImage.pre-recognize pngLen=${pngBuffer.byteLength} b64Len=${b64.length} imgInputType=string`,
  )
  const tRecognize = Date.now()
  const { data } = await worker.recognize(imgInput, {}, { blocks: true })
  console.log(`[N-13 timing] runTesseractOnImage.recognize=${Date.now() - tRecognize}ms`)

  // blocks → paragraphs → lines → words を辿って lines[] を組み立てる
  // Tesseract.js v7 では blocks ?: Block[] が optional なので存在チェック
  const lines: TesseractLine[] = []
  const allWords: TesseractWord[] = []
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const lineWords: TesseractWord[] = []
        for (const word of line.words ?? []) {
          const w: TesseractWord = {
            text: word.text,
            bbox: {
              x0: word.bbox.x0,
              y0: word.bbox.y0,
              x1: word.bbox.x1,
              y1: word.bbox.y1,
            },
            confidence: word.confidence,
          }
          lineWords.push(w)
          allWords.push(w)
        }
        lines.push({
          text: line.text,
          bbox: {
            x0: line.bbox.x0,
            y0: line.bbox.y0,
            x1: line.bbox.x1,
            y1: line.bbox.y1,
          },
          words: lineWords,
        })
      }
    }
  }

  return {
    text: data.text,
    confidence: data.confidence,
    lines,
    words: allWords,
  }
}
