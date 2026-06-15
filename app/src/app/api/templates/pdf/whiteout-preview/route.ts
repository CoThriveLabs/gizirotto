/**
 * POST /api/templates/pdf/whiteout-preview
 * 設計書 v1.4.2 §6-3 / §3-6-b（パス B 白塗りプレビュー API）。
 *
 * 入力:
 *   - templateId（必須）: アップロード済テンプレ ID
 *
 * 処理:
 *   1. templates_raw から raw PDF を取得
 *   2. ScanPdfExtractor で OCR（Mistral OCR + Tesseract.js）
 *   3. suggestWhiteoutCandidates で「手書き候補」WhiteoutBox[] 生成
 *   4. renderPdfPagesToPng で各ページをラスタライズ → image_cache へ署名付きアップロード
 *
 * 出力:
 *   - boxes: WhiteoutBox[]（auto_suggestion ラベル付き、UI 主操作はユーザードラッグ）
 *   - previewImageUrls: 各ページ PNG の署名付き URL（1 始まりページ順）
 *   - pageSizes: PDF pt 単位ページサイズ + 画像 px サイズ（座標変換用）
 *
 * Runtime: Node.js（pdfjs + Tesseract.js + @napi-rs/canvas ネイティブ依存、§6-6）
 */
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import {
  checkAiUsage,
  aiLimitExceededBody,
  logAiUsage,
} from '@/lib/ai-usage-guard'
import { extractScanPdfLayout } from '@/lib/parsers/pdf/scan-extractor'
import {
  suggestWhiteoutCandidatesByField,
  type FieldSuggestDiag,
} from '@/lib/parsers/pdf/whiteout-pipeline'
import { renderPdfPagesToPng } from '@/lib/parsers/pdf/pdf-page-rasterizer'
import { buildLayoutCluster } from '@/lib/parsers/pdf/layout-cluster'
import {
  detectFieldBboxes,
  type FieldBox,
  type RasterPagePixels,
} from '@/lib/parsers/pdf/field-bbox-detector'
import { errorResponse } from '@/lib/api/error-response'

export const runtime = 'nodejs'
export const maxDuration = 60

// 白塗り v0.7.1（2026-06-02）: role-classify（Claude API）を preview パスから外したため、
// role 用の動的残予算（PREVIEW_MAX_DURATION_MS / SAFETY_MARGIN / ROLE_BUDGET_MIN_MS）は不要。
// classifyCellRoles / prefilterCells の import も削除（ファイル本体は無改変、ここで呼ばないだけ）。

interface RequestBody {
  templateId?: string
}

export async function POST(request: NextRequest) {
  // N-13 計測 (2026-05-29): リクエスト全体の所要時間を Vercel logs で追跡。
  // Mistral / Tesseract / rasterize / storage upload の各段階に [N-13 timing] ラベル付ログを散布。
  const tReqStart = Date.now()
  const body = (await request.json().catch(() => ({}))) as RequestBody
  const templateId = body.templateId
  if (!templateId) {
    return NextResponse.json({ error: 'MISSING_TEMPLATE_ID' }, { status: 400 })
  }

  const supabase = await createSupabaseServerClient()

  // ガード ①: JWT 認証
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }

  // ガード ②: templates RLS（family_id 不一致は 0 件 → 404 隠蔽）
  const { data: template, error: tplErr } = await supabase
    .from('templates')
    .select('id, family_id, source_path, source_format, input_path_type')
    .eq('id', templateId)
    .maybeSingle()
  if (tplErr) {
    return NextResponse.json({ error: 'DB_ERROR' }, { status: 500 })
  }
  if (!template) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }
  if (template.source_format !== 'pdf' || !template.source_path) {
    return NextResponse.json(
      { error: 'NOT_A_PDF_TEMPLATE' },
      { status: 400 },
    )
  }

  const familyId = template.family_id as string

  // 3 階層 atomic check
  // (template の RLS 通過後・重い OCR / rasterize の前に check する = 「安いチェックを先・高いチェックを後」)
  const usageCheck = await checkAiUsage({ familyId, userId: user.id })
  if (usageCheck.exceeded) {
    return NextResponse.json(aiLimitExceededBody(usageCheck), { status: 429 })
  }

  // raw PDF 取得（templates_raw バケット）
  const tDl = Date.now()
  const { data: pdfBlob, error: dlErr } = await supabase.storage
    .from('templates_raw')
    .download(template.source_path as string)
  if (dlErr || !pdfBlob) {
    return NextResponse.json({ error: 'PDF_DOWNLOAD_FAILED' }, { status: 500 })
  }
  const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer())
  console.log(
    `[N-13 timing] pdf-download=${Date.now() - tDl}ms bytes=${pdfBytes.byteLength} templateId=${templateId}`,
  )

  // N-13 (504 timeout) 対策: rasterize を 1 回だけ実行し、OCR と preview PNG の両方で共有する。
  // 旧実装は extractScanPdfLayout 内部と route 本体で 2 回 renderPdfPagesToPng を呼んでいた
  // （worker_threads spawn + pdfjs init を 2 回 → Hobby 30s/Fluid 60s 上限超過）。
  let rasterized
  const tRaster = Date.now()
  try {
    const rasterCopy = new Uint8Array(pdfBytes.byteLength)
    rasterCopy.set(pdfBytes)
    rasterized = await renderPdfPagesToPng(rasterCopy, { scale: 2.0 })
    console.log(
      `[N-13 timing] rasterize=${Date.now() - tRaster}ms pages=${rasterized.length}`,
    )
  } catch (err) {
    return errorResponse('WHITEOUT_RASTERIZE_FAILED', 500, err)
  }

  // 白塗り v0.6 (2026-06-02): field_bbox 罫線検出を rasterized から並列キック。
  // 罫線検出はローカル画像処理（Claude / Mistral 非依存）なので、OCR + role 判定と
  // 並列に走らせて latency を隠蔽する（設計 §2-2 案 1 / §11 並列化）。
  // ここでは Promise を起動するだけ。await は role 判定後（suggestByField 直前）で行う。
  // v0.8 §12-3: detectFieldBboxes が返す共有画素（pixels）をインク判定へ渡す（再デコード回避）。
  const tLineDetect = Date.now()
  const fieldDetectPromise: Promise<{ boxes: FieldBox[]; pixels: RasterPagePixels[] }> =
    (async () => {
      const perPage = await Promise.all(rasterized.map(p => detectFieldBboxes(p)))
      return {
        boxes: perPage.flatMap(r => r.boxes),
        pixels: perPage.map(r => r.pixels),
      }
    })()

  // OCR + サジェスト（パス B 経路として scan extractor を通す）。
  //
  // 白塗り v0.4 (2026-05-29): 旧実装は confidence<70 を機械的に handwriting 判定し白塗り対象に
  // していたため、印刷ラベルにも青四角が付く / 本文が漏れる誤検出が出ていた。
  // 新実装は scanResult → layout-cluster（行列復元）→ Claude role 判定（label/value_or_entry/
  // printed_static/noise）→ role==='value_or_entry' のみ白塗り、に転換する。
  // scan-extractor（座標源）は無改変（別レイヤー併存方針）。
  // Claude role 判定が失敗した場合は旧 handwriting サジェストにフォールバックして preview は壊さない。
  // 白塗り v0.6: suggestions（白塗り = field 由来）は role 判定後に field_bbox から組む。
  // cluster は 3 重ラベル判定（§5-2 位置 + 語彙）に使うため上位スコープに保持する。
  // 白塗り v0.7.1: role-classify を preview パスから外したため classifications は常に []。
  // ラベル除外は位置 + 語彙（labelLexiconHit）で成立、エリアB は外周罫線 + written_bbox（§5-3）。
  let suggestions
  let scanResult
  let cluster: ReturnType<typeof buildLayoutCluster> = { pages: [] }
  const classifications: import('@/lib/parsers/pdf/whiteout-role-classifier').CellClassification[] = []
  const tOcr = Date.now()
  try {
    // scan-extractor は引数を transferable で transferred する可能性あるため copy
    const ocrCopy = new Uint8Array(pdfBytes.byteLength)
    ocrCopy.set(pdfBytes)
    scanResult = await extractScanPdfLayout(ocrCopy, { rasterizedPages: rasterized })
    console.log(`[N-13 timing] ocr=${Date.now() - tOcr}ms`)
    // [whiteout-diag-timing] OCR（scan 全体）の ms とページ数（依頼1）。
    // raster-line-detect ログより手前で出るので「ここで 60s 食って timeout」を直接特定できる。
    const ocrElemTotal = scanResult.pages.reduce((n, p) => n + p.elements.length, 0)
    console.log(
      `[whiteout-diag-timing] ocr-scan=${Date.now() - tOcr}ms pages=${scanResult.pages.length} ocrElems=${ocrElemTotal}`,
    )

    const tCluster = Date.now()
    cluster = buildLayoutCluster(scanResult)
    const cellCount = cluster.pages.reduce((n, p) => n + p.cells.length, 0)
    console.log(
      `[whiteout-v0.4 timing] cluster=${Date.now() - tCluster}ms cells=${cellCount}`,
    )

    // role-classify（Claude API）を preview パスから外す。
    // 診断ログで role-classify=60s timeout が真因と確定（罫線 70ms + OCR 4s に対し Claude だけが
    // budget を食い尽くし全体を落としていた）。v0.7.1 は role が補助で無くても成立する設計（§5-3）:
    //   - エリアB（議事内容大枠）= 外周罫線 + written_bbox → role 不要
    //   - エリアA ラベル除外 = 3 重判定の「左カラム位置 + 語彙(labelLexiconHit)」で role 無しでも動く
    //     （unit ケース10 で classifications=[] 時の位置 + 語彙ラベル除外を確認済）
    // → classifications=[] 固定（上位スコープで const 宣言）。Claude 呼び出し（classifyCellRoles）と
    //   role 入力用 prefilter を呼ばない。両ファイル本体は無改変（ここで呼ばないだけ）。
    console.log(
      '[whiteout-diag-timing] role-classify=skipped (dropped from preview path, role-free §5-3)',
    )

    // 白塗り v0.7.1: 並列キックした罫線検出を回収し、field_bbox 由来の白塗り候補を組む（§3 / §4 / §5）。
    // (1) 3 重ラベル判定で除外 → (2) 記入有無フィルタ（written_bbox / ScanOcrResult）で空欄除外 →
    // (3) inset 塗り。role 判定済なら補助に使い、未判定でも位置 + 語彙 + 外周罫線 + written で成立。
    // [whiteout-diag-timing] 並列キックした罫線検出 Promise の await 待ち（依頼1）。
    // OCR/role と並列なので通常は隠蔽されるが、ここで長時間ブロックするなら罫線検出が支配項。
    const tFieldAwait = Date.now()
    const { boxes: fieldBoxes, pixels: pagePixels } = await fieldDetectPromise
    console.log(
      `[whiteout-v0.7.2 timing] raster-line-detect=${Date.now() - tLineDetect}ms`,
    )
    // v0.7.2: field_bbox の area 別内訳（A=帯ローカルセル / B=外周大枠）。vLines 実値は
    // detectLines の [whiteout-diag-timing] detectLines(p?)=...vLines=... で per-page 出力済
    // （真因 vLines=2 が帯ローカル縦罫線で増えたかを確認する一次指標）。
    const fieldA = fieldBoxes.filter(b => b.area === 'A').length
    const fieldB = fieldBoxes.filter(b => b.area === 'B').length
    console.log(
      `[whiteout-diag-timing] field-await-block=${Date.now() - tFieldAwait}ms raster-line-detect-total=${Date.now() - tLineDetect}ms fields=${fieldBoxes.length} areaA=${fieldA} areaB=${fieldB}`,
    )
    const fieldDiag: FieldSuggestDiag = {
      areaA: 0,
      areaB: 0,
      labelExcluded: 0,
      posLabelExcluded: 0,
      inkFiltered: 0,
      merged: 0,
      painted: 0,
    }
    // v0.8: 記入有無は OCR written → セル内インク（前景ピクセル）で判定。pagePixels（共有画素）を渡す。
    // v0.8.1: 横並び分割 / range 最左ラベル除外 / 罫線被り補正 / ink-dist 診断は pipeline 内で実施（配線無改変）。
    // v0.8.2: 分割閾値28 / 列分散度ラベル除外（②難所A）/ 端列縦罫線除去＋maxComponent（③-B-1）/ ink-name 診断
    //   （③-B-2 観測専用）も pipeline 内で実施（配線無改変・背景色非依存 §0-A）。
    // scanResult は pageWidthPt 源としてのみ残置（塗り判定には不使用・OCR は §6 で温存）。
    suggestions = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      cluster,
      classifications,
      scanResult,
      fieldDiag,
      pagePixels,
    )
    console.log(
      `[whiteout-field v0.8.2] areaA=${fieldDiag.areaA} areaB=${fieldDiag.areaB} ` +
        `labelExcluded=${fieldDiag.labelExcluded} posLabelExcluded=${fieldDiag.posLabelExcluded} ` +
        `inkFiltered=${fieldDiag.inkFiltered} ` +
        `merged=${fieldDiag.merged} painted=${fieldDiag.painted}`,
    )

    console.log(
      `[N-13 timing] ocr-suggest-total=${Date.now() - tOcr}ms suggestions=${suggestions.length}`,
    )
  } catch (err) {
    // N-13b 診断 (2026-05-29): 99924 エラーの発生箇所 (file:line) を Vercel logs で確定する。
    console.error('[N-13 stack]', err instanceof Error ? err.stack : String(err))
    return errorResponse('WHITEOUT_OCR_FAILED', 500, err)
  }

  // 白塗り v0.7.1 §4: written_bbox（記入文字）を青四角用に別レイヤーで返す。
  // 白塗り対象（boxes = field_bbox 由来）とは分離。記入位置の可視化 + Phase 4 padding 学習用に保持
  // （本書 N-6 は保持と分離のみ、差分計算は Phase 4 スコープ）。scan-extractor 出力をそのまま流用。
  const writtenBoxes = scanResult.pages.flatMap(p =>
    p.elements
      .filter(el => el.text.trim().length > 0)
      .map(el => ({ page: p.pageIndex + 1, bbox: el.bbox })),
  )
  console.log(`[whiteout-field v0.8.2] writtenBoxes=${writtenBoxes.length}`)

  // image_cache に PNG をアップロード（temp プレフィックスで識別）。
  // N-13 副次最適化: 全頁を Promise.all で並列 upload + signed URL 発行（旧実装は逐次）。
  const pageSizes: Array<{
    page: number
    widthPt: number
    heightPt: number
    pixelWidth: number
    pixelHeight: number
  }> = rasterized.map(page => ({
    page: page.page,
    widthPt: page.pagePtSize.width,
    heightPt: page.pagePtSize.height,
    pixelWidth: page.pixelWidth,
    pixelHeight: page.pixelHeight,
  }))

  const tUpload = Date.now()
  const previewImageUrls: (string | null)[] = await Promise.all(
    rasterized.map(async page => {
      const cacheKey = `${familyId}/templates/${templateId}_whiteout_preview_p${page.page}.png`
      await supabase.storage
        .from('image_cache')
        .upload(cacheKey, page.pngBuffer as unknown as Blob, {
          contentType: 'image/png',
          upsert: true,
        })
      const { data: signed } = await supabase.storage
        .from('image_cache')
        .createSignedUrl(cacheKey, 3600)
      return signed?.signedUrl ?? null
    }),
  )
  console.log(
    `[N-13 timing] storage-upload=${Date.now() - tUpload}ms pages=${rasterized.length}`,
  )
  console.log(
    `[N-13 timing] request-total=${Date.now() - tReqStart}ms templateId=${templateId}`,
  )

  // ai_usage_log INSERT (best-effort)
  // whiteout-preview は Mistral OCR がメインコスト。Mistral OCR は無料枠 (~$0) として
  // cost_usd_estimate=0 を計上 (回数カウントのみ family/user 上限に効かせる)。
  void logAiUsage({
    familyId,
    userId: user.id,
    endpoint: 'whiteout-preview',
    costUsdEstimate: 0,
  })

  return NextResponse.json(
    {
      boxes: suggestions, // 白塗り v0.7.1: 記入有無フィルタ通過 + inset 済（記入スペース）
      writtenBoxes, // 白塗り v0.7.1 §4: written_bbox（青四角 = 記入位置把握 / Phase 4 学習）
      previewImageUrls,
      pageSizes,
    },
    { status: 200 },
  )
}
