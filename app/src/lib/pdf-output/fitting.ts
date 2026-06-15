/**
 * fitTextInBox（仕様書 v1.6.1 §0-3.5 要件 2 / 設計書 v1.4.2 §8）。
 *
 * フィッティング 3 段フォールバック（順序厳守）:
 *   ① フォントサイズ 2 分探索（既定値から縮小、最小 8pt）
 *   ② 改行挿入（multiline=true の項目のみ）
 *   ③ 末尾省略（"…" でトリム、上限到達時のみ）
 *
 * 3 段すべて適用しても枠を超える場合は warning='overflow' を返す
 * （UI 警告 + 手動編集画面誘導の入口、§8-4）。
 *
 * 純粋関数: pdf-lib への副作用を持たず、外部から font を受け取る。
 * これにより unit test では fake font で論理を検証可能。
 *
 */
import type { PdfField } from '../ai/schemas/pdf-field-schema'

/**
 * pdf-lib の PDFFont 型を直接 import せず、必要メソッドだけ構造的に受ける。
 * これにより Edge Runtime バンドル分離 + テスト時 fake 注入が容易。
 */
export interface FittableFont {
  widthOfTextAtSize(text: string, size: number): number
  heightAtSize(size: number): number
}

export interface FitTextPadding {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * 記入欄の「高さに収まるか」判定・baseline 計算で使う高さ係数 R（pt あたりの占有高 em 比）。
 *
 * 漢字 em 基準（R=1.0）に固定することで、漢字が usable 高さの約 90% を占め、bbox 高さ
 * いっぱいに近づく（descender 余白だけ残る）。`font.heightAtSize(1) ≈ 1.448`（フォント
 * 全体高）で割ると 62% しか入らず半分に見える。
 *
 * この係数は uniform-size.ts の `LINE_HEIGHT_RATIO` と一致させること（uniform 算出と
 * fit 高さ判定が同係数でないと、uniform を上げても fit が縮め返す）。
 *
 * ⚠️ 後方互換: `fitTextInBox` / `fitMultiline` に `heightRatio` を **渡さない**経路
 *   （固定テキスト C-2 / 既存呼出）は従来どおり `font.heightAtSize(size)` を使う。
 *   記入欄経路（overlay-generator / image-renderer の uniform 対象）だけが
 *   `FIT_HEIGHT_RATIO` を明示注入して高さ判定・行送りを揃える。
 */
export const FIT_HEIGHT_RATIO = 1.0

/**
 * size と heightRatio から「枠収まり判定／行送りに使う 1 行の占有高（pt）」を返す内部ヘルパ。
 * heightRatio 未指定（undefined）なら従来どおり font.heightAtSize(size)（メトリクス真値）。
 * 指定時は size * heightRatio（漢字 em 基準など、呼出側が選んだ係数）。
 */
function lineExtent(font: FittableFont, size: number, heightRatio?: number): number {
  return heightRatio === undefined ? font.heightAtSize(size) : size * heightRatio
}

/**
 * fitTextInBox の任意オプション（後方互換のため全 optional）。
 *
 * pad 不一致対策（uniform 対象 field 限定・`lockSize=true`）:
 *   uniform 算出は uniform 専用 pad（UNIFORM_PAD_TOP/BOTTOM=0）を使うのに対し、fitTextInBox は
 *   field.padding（実機で上下計 8pt）で maxH を計算していた。pad が食い違うと小欄では高さ
 *   判定の Step2 が必ず縮め返し全項目が揃わない。`lockSize=true` のとき高さ起因の縮小を一切
 *   行わず uniform を最終サイズに固定する。幅オーバーは multiline=true なら wrap で吸収、
 *   非 multiline なら末尾省略で吸収する（いずれも縮小しない）。
 *
 * ⚠️ lockSize は uniform 対象（heightRatio 注入経路）だけに渡す。固定テキスト等の
 *   非 uniform 経路は lockSize 未指定＝従来どおり高さ縮小が効く（回帰なし・経路別）。
 */
export interface FitTextOptions {
  /** uniform 対象 field のサイズ固定フラグ。true で高さ起因の縮小を行わず uniform を維持する。 */
  lockSize?: boolean
}

export type FitWarning = 'none' | 'shrunk' | 'wrapped' | 'truncated' | 'overflow'

export interface FitResult {
  /** 最終的に採用したフォントサイズ（pt 単位） */
  fontSize: number
  /** 改行を入れた後の行群 */
  lines: string[]
  /** 末尾省略が発生したか（"…" 付与） */
  truncated: boolean
  /** UI 表示時の警告レベル（§8-4） */
  warning: FitWarning
}

/**
 * テキストを field 枠内に収めるフィッティング 3 段を適用する。
 *
 * @param text             配置したいテキスト
 * @param field            PdfField（bbox / max_chars / font / multiline 等）
 * @param font             pdf-lib の PDFFont 互換オブジェクト
 * @param userStylePadding 個人スタイル padding（あれば field.padding を上書き）
 * @param heightRatio      高さ判定/行送りの占有高係数（記入欄＝FIT_HEIGHT_RATIO）。
 *                         未指定なら従来どおり font.heightAtSize（固定テキスト・後方互換）。
 * @param options          任意オプション。`lockSize=true`（uniform 対象）で高さ起因の縮小を
 *                         抑止し uniform を最終サイズに固定する（FitTextOptions 参照）。
 */
export function fitTextInBox(
  text: string,
  field: PdfField,
  font: FittableFont,
  userStylePadding?: FitTextPadding,
  heightRatio?: number,
  options?: FitTextOptions,
): FitResult {
  const lockSize = options?.lockSize ?? false
  // 個人スタイル padding 優先（Phase 4 連動）
  const padding = userStylePadding ?? field.padding
  const maxW = field.bbox.w - padding.left - padding.right
  // lockSize=true（uniform 対象）は高さ起因の縮小を行わないため、高さ判定を無効化
  // （maxH=∞）。これにより uniform を注入したサイズが Step1/Step2 で高さで縮め返されず固定
  // される。幅は従来どおり判定する（幅は wrap/省略で吸収・縮小しない）。
  const maxH = lockSize
    ? Number.POSITIVE_INFINITY
    : field.bbox.h - padding.top - padding.bottom

  // 枠サイズが負/ゼロなら overflow 確定（lockSize 時は maxH=∞ なので幅のみで判定）
  if (maxW <= 0 || maxH <= 0) {
    return {
      fontSize: field.font_size_min,
      lines: [text],
      truncated: false,
      warning: 'overflow',
    }
  }

  // 空文字列は何もせず返す
  if (text.length === 0) {
    return { fontSize: field.font.size, lines: [''], truncated: false, warning: 'none' }
  }

  // === 明示改行（\n）対応 ===
  // textarea は \n を改行表示するが、従来は \n 込み全文を 1 行幅で測り 1 行ベタ描きしていた
  // （PDF/画像で改行が反映されない不具合）。\n を段落区切りとして尊重し、段落ごとに
  // 既存 wrap ロジックで折返して全行を lines に連結する（fitting.ts 一箇所で overlay/画像
  // 両経路に効く）。\n を含まないテキストは split('\n') が 1 要素になり従来挙動と完全一致。
  if (text.includes('\n')) {
    return fitMultiline(text, field, font, maxW, maxH, heightRatio, lockSize)
  }

  // === lockSize（uniform 対象）専用: サイズは uniform 固定で高さ縮小しない ===
  // 🔴 三次 FB: uniform=14pt を Step2 が縮め返す問題の本丸。lockSize 時は uniform を最終
  //   サイズに固定し、幅オーバーは multiline=true なら wrap（uniform サイズのまま折返し）、
  //   非 multiline なら末尾省略で吸収する（いずれも縮小しない）。高さは maxH=∞ のため不問。
  if (lockSize) {
    const size = field.font.size // uniform 注入済みサイズ（呼出側が font.size に差替え済み）
    if (font.widthOfTextAtSize(text, size) <= maxW) {
      return { fontSize: size, lines: [text], truncated: false, warning: 'none' }
    }
    if (field.multiline) {
      // uniform サイズのまま幅で wrap（行数は maxH=∞ なので無制限・縮小も省略もしない）。
      const lines = wrapText(text, maxW, font, size)
      return { fontSize: size, lines, truncated: false, warning: 'wrapped' }
    }
    // 非 multiline は 1 行維持のため uniform サイズで末尾省略（サイズは縮めない）。
    const ellipsized = truncateWithEllipsis(text, maxW, font, size)
    return { fontSize: size, lines: [ellipsized], truncated: true, warning: 'truncated' }
  }

  // === Step 1: 既定フォントサイズで 1 行に収まるか ===
  const defaultSize = field.font.size
  const widthDefault = font.widthOfTextAtSize(text, defaultSize)
  const heightDefault = lineExtent(font, defaultSize, heightRatio)
  if (widthDefault <= maxW && heightDefault <= maxH) {
    return { fontSize: defaultSize, lines: [text], truncated: false, warning: 'none' }
  }

  // === Step 2: フォントサイズ 2 分探索（最小 font_size_min）===
  let lo = field.font_size_min
  let hi = defaultSize
  // 0.1pt 精度まで縮める
  while (hi - lo > 0.1) {
    const mid = (lo + hi) / 2
    const wMid = font.widthOfTextAtSize(text, mid)
    const hMid = lineExtent(font, mid, heightRatio)
    if (wMid <= maxW && hMid <= maxH) {
      lo = mid
    } else {
      hi = mid
    }
  }
  if (
    font.widthOfTextAtSize(text, lo) <= maxW
    && lineExtent(font, lo, heightRatio) <= maxH
  ) {
    return { fontSize: lo, lines: [text], truncated: false, warning: 'shrunk' }
  }

  // === Step 3: 改行挿入（multiline=true のみ）===
  if (field.multiline) {
    const lines = wrapText(text, maxW, font, field.font_size_min)
    const lineHeight = lineExtent(font, field.font_size_min, heightRatio) * 1.2  // 行間 1.2 倍
    const totalH = lines.length * lineHeight
    if (totalH <= maxH) {
      return {
        fontSize: field.font_size_min,
        lines,
        truncated: false,
        warning: 'wrapped',
      }
    }

    // 改行しても入りきらない → 末尾省略へ
    const maxLines = Math.max(1, Math.floor(maxH / lineHeight))
    const truncatedLines = lines.slice(0, maxLines)
    // 最終行を ellipsis でトリム（truncated=true 時は必ず "…" を付与）。
    // 切り詰められて後続行が存在することをユーザーに視覚的に示すため、
    // forceEllipsis=true で最終行が既に収まっていても末尾に "…" を付ける。
    truncatedLines[maxLines - 1] = truncateWithEllipsis(
      truncatedLines[maxLines - 1] ?? '',
      maxW,
      font,
      field.font_size_min,
      { forceEllipsis: true },
    )
    return {
      fontSize: field.font_size_min,
      lines: truncatedLines,
      truncated: true,
      warning: 'truncated',
    }
  }

  // === Step 4: 末尾省略（multiline=false、1 行のみ）===
  const ellipsizedText = truncateWithEllipsis(text, maxW, font, field.font_size_min)
  if (font.widthOfTextAtSize(ellipsizedText, field.font_size_min) <= maxW) {
    return {
      fontSize: field.font_size_min,
      lines: [ellipsizedText],
      truncated: true,
      warning: 'truncated',
    }
  }

  // === Step 5: それでも入らない → UI 警告へ ===
  return {
    fontSize: field.font_size_min,
    lines: [ellipsizedText],
    truncated: true,
    warning: 'overflow',
  }
}

/**
 * 明示改行（\n）を含むテキストを段落ごとに折返して field 枠に収める。
 *
 * アルゴリズム（C-2 fixedtext-composite.ts の value.split('\n') パターンを fitTextInBox に統合）:
 *   1. text.split('\n') で段落分割（空段落＝連続 \n は空行 1 つとして保持）。
 *   2. 既定サイズ→font_size_min の 2 候補で「全段落の最大幅 <= maxW」となるサイズを選ぶ。
 *      multiline=true は幅オーバー段落を wrapText で折返し、multiline=false は段落=1 行のまま
 *      （非 multiline でも改行自体は尊重）。
 *   3. 連結した全行の総高さ（行数 * lineHeight）が maxH に収まれば採用。
 *      収まらなければ maxLines に切り詰め最終行を ellipsis（truncated）。
 *
 * 1 段落のみ（\n 無し）では呼ばれない（fitTextInBox 冒頭で includes('\n') 分岐済み）。
 */
function fitMultiline(
  text: string,
  field: PdfField,
  font: FittableFont,
  maxW: number,
  maxH: number,
  heightRatio?: number,
  lockSize = false,
): FitResult {
  const paragraphs = text.split('\n')
  const defaultSize = field.font.size
  const minSize = field.font_size_min

  // 指定サイズで段落群を行へ展開する。multiline は幅 wrap、非 multiline は段落=1 行。
  const layout = (size: number): { lines: string[]; wrapped: boolean } => {
    const out: string[] = []
    let wrapped = false
    for (const para of paragraphs) {
      if (para.length === 0) {
        out.push('') // 空行を保持（高さ送りのみ）
        continue
      }
      if (field.multiline) {
        const wls = wrapText(para, maxW, font, size)
        if (wls.length > 1) wrapped = true
        out.push(...wls)
      } else {
        out.push(para)
      }
    }
    return { lines: out, wrapped }
  }

  // 全行が maxW に収まるか。
  const fitsWidth = (lines: string[], size: number): boolean =>
    lines.every((l) => font.widthOfTextAtSize(l, size) <= maxW)

  // 🔴 三次 FB: lockSize（uniform 対象）はサイズを uniform（defaultSize=注入済み）に固定し、
  //   minSize へ落とさない。幅は multiline=true なら wrap で吸収（layout が段落ごとに折返す）、
  //   非 multiline は段落=1 行のまま（幅超過は描画はみ出しを許容・縮小しない）。高さは
  //   maxH=∞ なので下の totalH<=maxH が常に真＝truncate されず uniform を維持する。
  let size = defaultSize
  let { lines, wrapped } = layout(defaultSize)
  if (!lockSize && !fitsWidth(lines, defaultSize)) {
    size = minSize
    ;({ lines, wrapped } = layout(minSize))
  }

  const lineHeight = lineExtent(font, size, heightRatio) * 1.2 // 行間 1.2 倍（overlay/画像と同一）
  const totalH = lines.length * lineHeight

  // 高さに収まる → そのまま採用。
  if (totalH <= maxH) {
    // 既定サイズ＆折返しなし＆改行で複数行＝意図どおりなので warning は wrapped 扱い
    // （複数行になっている時点で 1 行ベタ描きではない＝UI と一致を示す）。
    const warning: FitWarning =
      size < defaultSize ? 'shrunk' : wrapped || lines.length > 1 ? 'wrapped' : 'none'
    return { fontSize: size, lines, truncated: false, warning }
  }

  // 高さオーバー → maxLines に切り詰め、最終行を ellipsis（後続省略の視覚警告）。
  const maxLines = Math.max(1, Math.floor(maxH / lineHeight))
  const truncatedLines = lines.slice(0, maxLines)
  truncatedLines[maxLines - 1] = truncateWithEllipsis(
    truncatedLines[maxLines - 1] ?? '',
    maxW,
    font,
    size,
    { forceEllipsis: true },
  )
  return { fontSize: size, lines: truncatedLines, truncated: true, warning: 'truncated' }
}

/**
 * 行頭禁則文字セット（JIS X 4051 標準サブセット + 小書き仮名拗音促音）。
 *
 * 標準サブセット + 小書き仮名を含む。
 *
 * 用途: `wrapText` の改行判定時、行頭に来る文字がこの Set に含まれていれば
 * 改行せず前行末にぶら下げる（はみ出し方式・追い出しではない）。bbox 右端を句読点 1 文字
 * ぶん超える見た目は許容。
 *
 * ⚠️ この Set は 3 経路（PDF overlay / 画像 / canvas プレビュー）共通の `wrapText` 1 箇所で
 *    参照される。ドリフトの原因にならないよう、追加・削除は本ファイルの定義のみで完結させること。
 */
export const LINE_HEAD_KINSOKU: ReadonlySet<string> = new Set([
  // 句読点・約物（半角・全角混在を含む標準サブセット）
  '。', '、', '，', '．', '・', '：', '；', '！', '？',
  // 閉じ括弧
  ')', '）', ']', '］', '}', '｝', '」', '』', '】', '〕', '〉', '》', '’', '”',
  // 長音・三点リーダ等
  'ー', '…', '‼', '⁇', '゛', '゜', 'ヽ', 'ヾ', 'ゝ', 'ゞ', '々',
  // 小書き仮名（ひらがな拗音・促音）
  'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'っ', 'ゃ', 'ゅ', 'ょ', 'ゎ',
  // 小書き仮名（カタカナ拗音・促音）
  'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ッ', 'ャ', 'ュ', 'ョ',
])

/**
 * 日本語は文字単位、ラテン語は単語単位で改行する。
 * シンプルに文字単位（CJK 想定）で実装。
 *
 * 行頭禁則ぶら下げ:
 *   `candidate = current + ch` が maxWidth 超過時、ch が LINE_HEAD_KINSOKU に
 *   含まれる場合は改行せず current に貼り付けたまま継続する（前行末ぶら下げ＝
 *   bbox 右端を 1 文字ぶんはみ出すことを許容）。連続禁則（例: 「）。」）も
 *   全部前行ぶら下げ（candidate に積み上げる方式で自然に while 継続される）。
 *
 *   非禁則文字は従来どおり current を push して ch を次行へ。1 行目先頭が禁則
 *   （current.length===0）の場合はぶら下げ先がないため、そのまま先頭に置く
 *   フォールバック（既存条件 `current.length > 0` がそのまま機能）。
 *
 * ⚠️ 禁則文字を含まないテキストでは従来と完全同一の出力を保つ（回帰ゼロ）。
 */
export function wrapText(
  text: string,
  maxWidth: number,
  font: FittableFont,
  fontSize: number,
): string[] {
  const lines: string[] = []
  let current = ''
  for (const ch of text) {
    const candidate = current + ch
    if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth && current.length > 0) {
      // 行頭禁則ぶら下げ: ch が禁則文字なら改行せず current に積み上げる
      // （current.length > 0 ガードにより、1 行目先頭が禁則の場合はぶら下げ先が
      //  なく current='', ch を current にセットするフォールバックへ落ちる）
      if (LINE_HEAD_KINSOKU.has(ch)) {
        current = candidate
      } else {
        lines.push(current)
        current = ch
      }
    } else {
      current = candidate
    }
  }
  if (current.length > 0) lines.push(current)
  // すべて空なら 1 行返す（fitTextInBox の Step 3 直後の lines.length チェックを単純化）
  if (lines.length === 0) lines.push('')
  return lines
}

export interface TruncateOptions {
  /** true なら text が maxWidth に収まっていても末尾に "…" を強制付与
   *  （後続行が省略されたことを示す用途）。デフォルト false */
  forceEllipsis?: boolean
}

/**
 * 末尾を ellipsis で trim する（"…" 付与）。
 * maxWidth に収まる範囲で text の prefix + "…" を返す。
 * "…" すら入らない場合は 1 文字 + "…" を返す（最低保証）。
 *
 * forceEllipsis=true のときは text が maxWidth に収まっていても末尾に "…" を付ける
 * （multiline 改行で後続行が省略された場合のユーザー視覚警告用、fitTextInBox の Step 3 末尾省略）。
 */
export function truncateWithEllipsis(
  text: string,
  maxWidth: number,
  font: FittableFont,
  fontSize: number,
  options: TruncateOptions = {},
): string {
  if (text.length === 0) return options.forceEllipsis ? '…' : ''

  // forceEllipsis=false: text 自体が収まれば trim 不要
  if (!options.forceEllipsis && font.widthOfTextAtSize(text, fontSize) <= maxWidth) {
    return text
  }

  // forceEllipsis=true でも、text + '…' が収まればそのまま返す
  if (options.forceEllipsis && font.widthOfTextAtSize(text + '…', fontSize) <= maxWidth) {
    return text + '…'
  }

  let s = text
  while (s.length > 0 && font.widthOfTextAtSize(s + '…', fontSize) > maxWidth) {
    s = s.slice(0, -1)
  }
  // s.length === 0 になっても最低 1 文字 + "…" を返す（読みやすさ優先）
  return s.length === 0 ? text.slice(0, 1) + '…' : s + '…'
}
