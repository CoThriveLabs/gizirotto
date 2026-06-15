/**
 * bbox エディタ用データ取得ヘルパ（G2-1 設計書 v0.2 §4-1）。
 *
 * background PDF をラスタライズして「背景 PNG signedUrl ＋ pageSizes」を返す軽量経路。
 * OCR/Claude/Tesseract は呼ばない（コスト・latency $0、§7）。
 * GET route（取得）と保存 Server Action（範囲チェック用 pageSizes）の両方から使う。
 *
 * 認証・RLS は呼び出し側（route / action）が済ませた supabase client を受け取る前提。
 */
import type { createSupabaseServerClient } from '@/lib/supabase/server'
import { renderPdfPagesToPng, type RasterizedPage } from '@/lib/parsers/pdf/pdf-page-rasterizer'
import {
  detectFieldBboxes,
  type FieldBox,
  type RasterPagePixels,
} from '@/lib/parsers/pdf/field-bbox-detector'
import { compositeWhiteoutOnPng } from '@/lib/parsers/pdf/whiteout-composite'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'
import type { PageMeta } from './bbox-coords'

type ServerSupabase = Awaited<ReturnType<typeof createSupabaseServerClient>>

const SIGNED_URL_TTL = 3600

export interface BboxEditorPages {
  pageSizes: PageMeta[]
  /** 1 始まりページ順の背景 PNG signed URL（null=失敗）。 */
  previewImageUrls: (string | null)[]
  /**
   * ②動的プレビュー（§2-2 / §6-3）: 白塗りモード用の **raw 背景 PNG** signed URL（合成なし）。
   * compositePolicy='both' のときのみ非 null 配列。白塗りモードの BboxPane が canvas に
   * drawImage し、編集中 whiteoutFields をクライアント合成する（記入欄/固定テキストは
   * previewImageUrls の焼込済 <img> をそのまま使う＝無改修）。raw を出せない経路では undefined。
   */
  rawPreviewImageUrls?: (string | null)[]
  /**
   * グループX（罫線スナップ）: page → 罫線検出セル（FieldBox[]）。
   * 既存 rasterized を再利用して detectFieldBboxes（読むだけ）で得る。追加 PDF レンダなし＝$0。
   * 検出失敗ページは空配列（snap 側で AI bbox 維持にフォールバック）。
   */
  ruledCellsByPage: Map<number, FieldBox[]>
  /**
   * グループX（P1.6a 配線 / P1.6b 本丸）: page → デコード済みラスタ画素（RGBA）。
   * detectFieldBboxes が既に返している pixels を捨てず格納するだけ（追加レンダ/デコード 0＝$0）。
   * snap 側の右端拡張（真の外枠まで）/ area B 帯分割（画素横罫線で）に使う（塗り/preview 無影響）。
   * 検出失敗ページは未格納（snap 側は pixels 無しで従来挙動＝退行なし）。
   */
  pixelsByPage: Map<number, RasterPagePixels>
}

/** loadBboxEditorPages のオプション。 */
export interface LoadBboxEditorPagesOptions {
  /**
   * 白塗り座標（templates.whiteout_boxes）。
   * 1 件以上ある場合は raw 背景に PNG 再合成する（A500 を踏む _blank.pdf を使わない）。
   * null / 空配列なら従来の _blank.pdf（backgroundPdfPath）経路にフォールバック（旧データ後方互換）。
   */
  whiteoutBoxes?: WhiteoutBox[] | null
  /**
   * raw PDF のパス（templates.source_path・templates_raw バケット）。
   * whiteoutBoxes ありの再合成経路でのみ使う。null なら _blank.pdf 経路へフォールバック。
   */
  sourcePath?: string | null
  /**
   * 白塗り合成の責務出し分け。
   *   - 'server'（既定）: 従来どおりサーバで compositeWhiteoutOnPng を焼き込んだ PNG のみ返す。
   *                       記入欄／固定テキストのみのエディタ、raw を渡せない場合はこちら。
   *   - 'both': previewImageUrls（焼込済・記入欄/固定テキストの <img> 用）に加え、
   *             rawPreviewImageUrls（raw・白塗りモードの canvas 用）も**同一ラスタライズ**から返す。
   *             白塗りモードはクライアントが whiteoutFields を Canvas2D で都度合成し、削除した
   *             瞬間に元の文字が透ける（②本命 UX）。raw 固定なので焼込済 PNG のキャッシュ固着も消滅。
   *
   * 🚨 漏洩リスク受け皿（§4-3）: 'both' の raw（白塗り前の元画像）配信は、自家族・自テンプレ
   *   原本の所有者本人の編集に限る前提で許容。将来の公開 PF 化時は「閲覧者が原本所有者本人か」で
   *   'server'（焼込のみ）を強制する分岐をここで足す（本フラグが受け皿）。
   */
  compositePolicy?: 'server' | 'both'
  /**
   * raw 背景 PNG キャッシュの版数（任意・§7 軽微）。templates.updated_at 等を渡すと
   * signedUrl 取得対象のキャッシュキーに付与し、raw を再アップロードした際の固着を予防する。
   * compositePolicy='both' のときのみ意味を持つ。
   */
  cacheVersion?: string | null
}

/**
 * 背景 PNG を image_cache に置換アップロードし、signedUrl を返す（段階1 安定化・実機FB・#18）。
 *
 * 🚨 キャッシュ固着バグ対策（#18）: image_cache バケットは INSERT / SELECT / DELETE policy のみで
 * **UPDATE policy が無い**ため `upsert: true` は 2 回目以降 RLS で弾かれて失敗する。旧実装は
 * upsert:true ＋ 失敗握り潰しだったため、白塗り削除→保存しても焼込済 PNG が更新されず古い背景
 * （削除前の白塗りが残ったもの）が image_cache に固着し、記入欄モード/再入場で「削除したはずの
 * 白塗りが残り元の文字が見えない」事象になっていた。
 *
 * 対策: サムネ側（template-thumbnail.ts）と同じく **remove() → upload(upsert:false)** に分割し、
 * DELETE policy + INSERT policy のみで毎回最新に置換する（remove は対象不在でもエラーにならない）。
 *   1. remove([cacheKey]) で旧 PNG を消す（初回は no-op）。
 *   2. upload(upsert:false) で最新 pngBytes を書く（白塗りやり直し後の鮮度を保つ）。
 *   3. competing 競合等で upErr が出ても即 null 化せず握り、createSignedUrl を試す
 *      （並行する別リクエストが同 cacheKey を上げ切っていれば URL は取れる＝背景が消えない）。
 *   4. URL が取れれば返す。取れなければ null（失敗時 null 維持＝個人情報死守は不変）。
 *
 * 素 raw を出すことは一切ない（pngBytes は呼び出し側で白塗り済 or raw 配信が許可された経路のみ）。
 */
async function uploadAndSign(
  supabase: ServerSupabase,
  cacheKey: string,
  pngBytes: Uint8Array,
  cacheVersion?: string | null,
): Promise<string | null> {
  // ① 常に最新を書く（やり直し後の鮮度死守）。
  //    🚨 #18: image_cache バケットは INSERT / SELECT / DELETE policy のみで **UPDATE policy が無い**ため、
  //    `upsert: true` は 2 回目以降 RLS で弾かれて失敗する（= 白塗り削除→保存しても古い焼込済 PNG が
  //    image_cache に残留し、記入欄モード/再入場で「削除したはずの白塗りが残り元の文字が見えない」固着の真因）。
  //    サムネ側（template-thumbnail.ts）と同じく remove() → upload(upsert:false) に分割し、
  //    DELETE policy + INSERT policy のみで毎回最新に置換する（remove は対象不在でもエラーにならない＝初回も安全）。
  //    competing upload 等で upErr が出ても即 null にせず握り、② の signedUrl にかける
  //    （並行する別リクエストが同 cacheKey を上げ切っていれば URL は取れる＝背景が消えない）。
  await supabase.storage.from('image_cache').remove([cacheKey])
  await supabase.storage
    .from('image_cache')
    .upload(cacheKey, pngBytes as unknown as Blob, {
      contentType: 'image/png',
      upsert: false,
    })

  // ② upload 成功でも競合握り後でも signedUrl を取得（並行先行が上げた最新を拾える）。
  //    URL が取れなければ真の失敗＝null（失敗時 null 維持＝個人情報死守は不変）。
  const signed = await supabase.storage
    .from('image_cache')
    .createSignedUrl(cacheKey, SIGNED_URL_TTL)
  const url = signed.data?.signedUrl ?? null
  if (!url) return null
  // ②動的プレビュー §7（軽微）: raw 再アップロード時のブラウザ <img>/fetch 固着予防に版数を付与。
  // signedUrl は既にクエリ（token 等）を含むので & で連結する。
  if (cacheVersion) {
    return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(cacheVersion)}`
  }
  return url
}

/**
 * background PDF（templates_processed バケット）をラスタライズし、
 * pageSizes と背景 PNG signedUrl を返す。PNG は image_cache にキャッシュ（TTL 1h）。
 *
 * whiteout 経路:
 *   whiteoutBoxes が 1 件以上 & sourcePath あり → templates_raw の **raw PDF** をラスタライズし、
 *   各ページに compositeWhiteoutOnPng で白塗りを再合成してから背景 PNG とする
 *   （焼き込み済 _blank.pdf をラスタライズすると A500 で落ちるのを構造的に回避）。
 *   再合成が例外で失敗したページは previewImageUrls を **null** にし、素の raw PNG は
 *   絶対に upload/表示しない（漏洩より表示不能を選ぶ＝個人情報死守）。
 *   whiteoutBoxes なし（旧データ）→ 従来どおり _blank.pdf（backgroundPdfPath）をそのまま使う。
 *
 * @param supabase   認証済 server client（RLS で自家族のみ可視）
 * @param familyId   キャッシュキー用
 * @param templateId キャッシュキー用
 * @param backgroundPdfPath templates_processed 内のパス（_blank.pdf・旧データ用フォールバック背景）
 * @param options    段階1 C-2 の whiteoutBoxes / sourcePath（省略時は従来挙動＝非破壊）
 */
export async function loadBboxEditorPages(
  supabase: ServerSupabase,
  familyId: string,
  templateId: string,
  backgroundPdfPath: string,
  options: LoadBboxEditorPagesOptions = {},
): Promise<BboxEditorPages> {
  const whiteoutBoxes = options.whiteoutBoxes ?? []

  // ②動的プレビュー（§2-2）: 白塗りモード用に raw 背景も併せて返すモード。raw パスが要る。
  // raw を別途配信するだけで、記入欄/固定テキスト用の焼込済 previewImageUrls は従来どおり出す。
  const useClientPreview =
    options.compositePolicy === 'both' && !!options.sourcePath

  // 再合成経路（サーバ焼込）の発動条件: 白塗りが 1 件以上 かつ raw パスがある（§4-2 / §3-2 後方互換）。
  //   ※ #15 で固定テキストも raw 経路に乗せたが、二重表示 + 再編集不可バグで #17 にて撤回。
  //      固定テキストは動的プレビュー（whiteout-composite-canvas と同パターン）でクライアント合成する。
  const useRawComposite =
    whiteoutBoxes.length > 0 && !!options.sourcePath

  // DL 元バケットとパスを経路で振り分ける。raw が要る経路（client 合成 / server 再合成）は
  // templates_raw、それ以外（旧データ / 白塗りなし）は従来どおり _blank.pdf（templates_processed）。
  const useRawPdf = useClientPreview || useRawComposite
  const bucket = useRawPdf ? 'templates_raw' : 'templates_processed'
  const path = useRawPdf ? (options.sourcePath as string) : backgroundPdfPath

  const { data: pdfBlob, error: dlErr } = await supabase.storage
    .from(bucket)
    .download(path)
  if (dlErr || !pdfBlob) {
    throw new Error('PDF_DOWNLOAD_FAILED')
  }
  const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer())

  // OCR は呼ばず、ラスタライズ + pageSizes 抽出のみ（preview route L261-273 と同型）。
  const rasterCopy = new Uint8Array(pdfBytes.byteLength)
  rasterCopy.set(pdfBytes)
  const rasterized = await renderPdfPagesToPng(rasterCopy, { scale: 2.0 })

  const pageSizes: PageMeta[] = rasterized.map((page) => ({
    page: page.page,
    widthPt: page.pagePtSize.width,
    heightPt: page.pagePtSize.height,
    pixelWidth: page.pixelWidth,
    pixelHeight: page.pixelHeight,
  }))

  // 記入欄/固定テキスト用の焼込済（or 旧 blank）背景。白塗りモードでも raw が出せないテンプレ
  // （sourcePath 無し等）のフォールバック背景として使う（従来挙動・無改修）。
  const previewImageUrls: (string | null)[] = await Promise.all(
    rasterized.map(async (page) => {
      // 再合成経路（サーバ焼込）では raw PNG に白塗りを焼き込んで upload する。
      // 失敗時は素 raw を出さず null（§5-2 個人情報死守）。
      // ※ #17: 固定テキスト焼き込みは撤回。固定テキストは bbox-pane の動的合成（canvas）に統一。
      let pngBytes: Uint8Array
      if (useRawComposite) {
        try {
          pngBytes = await compositeWhiteoutOnPng(page, whiteoutBoxes)
        } catch (compErr) {
          console.error(
            `[loadBboxEditorPages] whiteout composite failed templateId=${templateId} page=${page.page}:`,
            compErr instanceof Error ? compErr.message : String(compErr),
          )
          // 素の raw を絶対に表示しない。このページは表示不能（null）にする。
          return null
        }
      } else {
        pngBytes = page.pngBuffer
      }

      const cacheKey = `${familyId}/templates/${templateId}_bbox_editor_p${page.page}.png`
      return uploadAndSign(supabase, cacheKey, pngBytes)
    }),
  )

  // ②動的プレビュー（§2-2 / §6-3）: 白塗りモード用の raw 背景 PNG を**焼き込まず**別キーで配信。
  // 白塗りはブラウザが whiteoutFields を Canvas2D で都度合成する（削除で透ける＝本命 UX）。
  // raw は焼込済とは別キャッシュキー（_bbox_editor_raw_p{N}.png）で分離し取り違えを防ぐ。
  // 🚨 raw（白塗り前）の配信は compositePolicy='both'＝所有者本人編集のときのみ（§4-3）。
  // #17: 固定テキストは raw 背景に焼き込まず、クライアント canvas で動的合成する
  //   （bbox-pane.tsx の compositeFixedTextsOnCanvas）。raw 背景は素のままで OK。
  const rawPreviewImageUrls: (string | null)[] | undefined = useClientPreview
    ? await Promise.all(
        rasterized.map(async (page) => {
          const rawKey = `${familyId}/templates/${templateId}_bbox_editor_raw_p${page.page}.png`
          return uploadAndSign(supabase, rawKey, page.pngBuffer, options.cacheVersion)
        }),
      )
    : undefined

  // グループX: 既存 rasterized を再利用して罫線セルを検出（読むだけ・追加 PDF レンダなし＝$0）。
  // 検出器の検出/判定ロジックは無改変。失敗ページは空配列で snap 側が AI bbox 維持にフォールバック。
  const ruledCellsByPage = new Map<number, FieldBox[]>()
  const pixelsByPage = new Map<number, RasterPagePixels>()
  await Promise.all(
    rasterized.map(async (page) => {
      try {
        const { boxes, pixels } = await detectFieldBboxes(page)
        ruledCellsByPage.set(page.page, boxes)
        // P1.6a: 既に返ってくる pixels を捨てず格納するだけ（追加デコード 0＝$0）。
        pixelsByPage.set(page.page, pixels)
      } catch {
        ruledCellsByPage.set(page.page, [])
      }
    }),
  )

  return {
    pageSizes,
    previewImageUrls,
    rawPreviewImageUrls,
    ruledCellsByPage,
    pixelsByPage,
  }
}

/**
 * 範囲チェック用に pageSizes だけ取得する（PNG アップロードはしない）。
 * 保存 Server Action のバリデーション用（背景は不要）。
 */
export async function loadPageSizesOnly(
  supabase: ServerSupabase,
  backgroundPdfPath: string,
  options: LoadBboxEditorPagesOptions = {},
): Promise<PageMeta[]> {
  const whiteoutBoxes = options.whiteoutBoxes ?? []
  // #17: 固定テキストは raw 経路に乗せない（クライアント動的合成に統一）。
  //   whiteout のみが raw 再合成の判定条件。
  const useRawPdf = whiteoutBoxes.length > 0 && !!options.sourcePath
  const bucket = useRawPdf ? 'templates_raw' : 'templates_processed'
  const path = useRawPdf ? (options.sourcePath as string) : backgroundPdfPath

  const { data: pdfBlob, error: dlErr } = await supabase.storage
    .from(bucket)
    .download(path)
  if (dlErr || !pdfBlob) {
    throw new Error('PDF_DOWNLOAD_FAILED')
  }
  const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer())
  const rasterCopy = new Uint8Array(pdfBytes.byteLength)
  rasterCopy.set(pdfBytes)
  const rasterized = await renderPdfPagesToPng(rasterCopy, { scale: 2.0 })
  return rasterized.map((page) => ({
    page: page.page,
    widthPt: page.pagePtSize.width,
    heightPt: page.pagePtSize.height,
    pixelWidth: page.pixelWidth,
    pixelHeight: page.pixelHeight,
  }))
}
