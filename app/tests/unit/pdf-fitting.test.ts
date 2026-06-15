/**
 * fitTextInBox unit test。
 *
 * 純粋関数 + fake font 注入でフィッティング 3 段の動作を検証:
 *   - Step 1: 既定フォントサイズで収まる → warning='none'
 *   - Step 2: 2 分探索で縮小 → warning='shrunk'
 *   - Step 3: multiline 改行 → warning='wrapped'
 *   - Step 4: 末尾省略 → warning='truncated'
 *   - Step 5: それでも入らない → warning='overflow'
 *
 * fake font は「1 文字 = fontSize * 0.5 pt の固定幅」と
 * 「heightAtSize = fontSize」のシンプルモデル。
 * これにより maxW / maxH の境界判定を決定論的に再現できる。
 */
import { describe, it, expect } from 'vitest'
import {
  fitTextInBox,
  wrapText,
  truncateWithEllipsis,
  FIT_HEIGHT_RATIO,
  LINE_HEAD_KINSOKU,
  type FittableFont,
} from '@/lib/pdf-output/fitting'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

const fixedFont: FittableFont = {
  widthOfTextAtSize: (text, size) => text.length * size * 0.5,
  heightAtSize: (size) => size,
}

/**
 * 実フォント相当: heightAtSize(size) = size * 1.448（ascent+descent＝フォント全体高）。
 * この係数のまま高さ判定すると漢字が usable の 62% にしか入らない。
 * fitTextInBox に heightRatio=FIT_HEIGHT_RATIO(1.0) を渡すと、高さ判定が size*1.0 になり
 * uniform を Step 1 で温存（縮め返さない）ことを検証する。
 */
const tallFont: FittableFont = {
  widthOfTextAtSize: (text, size) => text.length * size * 0.5,
  heightAtSize: (size) => size * 1.448,
}

function makeField(overrides: Partial<PdfField>): PdfField {
  return {
    name: 'sample',
    label: 'サンプル',
    type: 'text',
    bbox: { page: 1, x: 0, y: 0, w: 200, h: 30 },
    max_chars: 40,
    font: { family: 'Noto Sans JP', size: 12 },
    padding: { left: 4, top: 4, right: 4, bottom: 4 },
    multiline: false,
    align: 'left',
    vertical: 'top',
    writing_mode: 'horizontal',
    overflow_strategy: 'shrink_then_wrap',
    font_size_min: 8,
    ...overrides,
  }
}

describe('fitTextInBox - Step 1: 既定サイズで収まる (warning="none")', () => {
  it('短い text は既定 fontSize でそのまま返る', () => {
    const field = makeField({ bbox: { page: 1, x: 0, y: 0, w: 200, h: 30 } })
    // 'abc' = 3 * 12 * 0.5 = 18pt、bbox w=200, padding 4+4 = maxW=192 OK
    // heightAtSize(12) = 12pt、bbox h=30, padding 4+4 = maxH=22 OK
    const r = fitTextInBox('abc', field, fixedFont)
    expect(r.fontSize).toBe(12)
    expect(r.lines).toEqual(['abc'])
    expect(r.warning).toBe('none')
    expect(r.truncated).toBe(false)
  })

  it('空文字列は warning="none" でそのまま返る', () => {
    const field = makeField({})
    const r = fitTextInBox('', field, fixedFont)
    expect(r.lines).toEqual([''])
    expect(r.warning).toBe('none')
  })
})

describe('fitTextInBox - Step 2: 2 分探索で縮小 (warning="shrunk")', () => {
  it('既定 12pt では入らないが 10pt で入るケース', () => {
    // bbox w=60, padding 4+4 = maxW=52
    // 'ABCDEFGH' (8 文字) を 12pt: 8 * 12 * 0.5 = 48 pt 入る → Step 1 で OK
    // 'ABCDEFGHIJ' (10 文字) を 12pt: 60pt 超過、9.6pt あたりで 48pt 収まる
    const field = makeField({ bbox: { page: 1, x: 0, y: 0, w: 60, h: 30 } })
    const r = fitTextInBox('ABCDEFGHIJ', field, fixedFont)
    expect(r.warning).toBe('shrunk')
    expect(r.fontSize).toBeLessThan(12)
    expect(r.fontSize).toBeGreaterThanOrEqual(8)
    expect(r.lines).toEqual(['ABCDEFGHIJ'])
    expect(r.truncated).toBe(false)
  })

  it('font_size_min まで縮めても入らないと Step 3/4 に進む', () => {
    // 'A'.repeat(20) を 8pt: 20 * 8 * 0.5 = 80pt
    // bbox w=60 padding 4+4 = maxW=52 → 入らない
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 60, h: 30 },
      multiline: false,
    })
    const r = fitTextInBox('A'.repeat(20), field, fixedFont)
    // multiline=false なので Step 4 末尾省略 (truncated) になる
    expect(r.warning).toBe('truncated')
    expect(r.lines[0].endsWith('…')).toBe(true)
  })
})

describe('fitTextInBox - Step 3: 改行挿入 (warning="wrapped")', () => {
  it('multiline=true で複数行に分割される', () => {
    // bbox w=60 (maxW=52), h=100 (maxH=92)
    // 'ABCDEFGHIJKLMN' (14 文字) を 8pt: 14 * 8 * 0.5 = 56pt → 1 行で入らない
    // 1 文字 = 4pt、52pt 内には 13 文字入る。14 文字目で改行
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 60, h: 100 },
      multiline: true,
    })
    const r = fitTextInBox('ABCDEFGHIJKLMN', field, fixedFont)
    expect(r.warning).toBe('wrapped')
    expect(r.fontSize).toBe(8) // font_size_min で改行
    expect(r.lines.length).toBeGreaterThan(1)
    expect(r.lines.join('')).toBe('ABCDEFGHIJKLMN')
    expect(r.truncated).toBe(false)
  })

  it('改行しても入りきらない場合は warning="truncated"', () => {
    // bbox w=20 (maxW=12), h=12 (maxH=4)
    // h=4 < lineHeight (8 * 1.2 = 9.6) → 1 行も入らない
    // maxLines = floor(4 / 9.6) = 0、Math.max(1, 0) = 1 で 1 行に省略
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 20, h: 12 },
      multiline: true,
    })
    const r = fitTextInBox('ABCDEFGHIJKLMN', field, fixedFont)
    expect(r.warning).toBe('truncated')
    expect(r.truncated).toBe(true)
    expect(r.lines.length).toBeLessThanOrEqual(1)
    expect(r.lines[0]?.endsWith('…')).toBe(true)
  })
})

describe('fitTextInBox - Step 4: 末尾省略 (warning="truncated")', () => {
  it('multiline=false の長文は ellipsis 付きで返る', () => {
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 60, h: 30 },
      multiline: false,
    })
    const r = fitTextInBox('A'.repeat(50), field, fixedFont)
    expect(r.warning).toBe('truncated')
    expect(r.truncated).toBe(true)
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].endsWith('…')).toBe(true)
  })
})

describe('fitTextInBox - Step 5: それでも入らない (warning="overflow")', () => {
  it('maxW=0 (枠が padding に食われる) なら overflow', () => {
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 8, h: 30 }, // padding 4+4 = maxW=0
    })
    const r = fitTextInBox('abc', field, fixedFont)
    expect(r.warning).toBe('overflow')
  })

  it('maxH=0 でも overflow', () => {
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 200, h: 8 }, // padding 4+4 = maxH=0
    })
    const r = fitTextInBox('abc', field, fixedFont)
    expect(r.warning).toBe('overflow')
  })
})

describe('fitTextInBox - 個人スタイル padding 上書き', () => {
  it('userStylePadding が指定されると field.padding を上書き', () => {
    // bbox w=60, field.padding=4+4=maxW=52、userStylePadding=10+10=maxW=40
    // 'ABCDEFGHIJ' (10 文字) を 12pt: 60pt 超過 → 縮小
    const field = makeField({ bbox: { page: 1, x: 0, y: 0, w: 60, h: 30 } })
    const r = fitTextInBox('ABCDEFGHIJ', field, fixedFont, {
      left: 10,
      top: 10,
      right: 10,
      bottom: 10,
    })
    // userStylePadding 適用後 maxW=40 になりさらに縮小される
    expect(r.fontSize).toBeLessThan(12)
  })
})

describe('fitTextInBox - 明示改行（\\n）対応', () => {
  it('\\n 入りテキストは段落ごとに分かれて複数行 lines になる', () => {
    // 3 段落・各段落は短く幅に収まる。h は 3 行ぶん十分（既定 12pt 行高 14.4 * 3 = 43.2 < maxH）。
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 200, h: 80 },
      multiline: true,
    })
    const r = fitTextInBox('一行目\n二行目\n三行目', field, fixedFont)
    expect(r.lines).toEqual(['一行目', '二行目', '三行目'])
    expect(r.truncated).toBe(false)
    expect(r.warning).not.toBe('overflow')
  })

  it('箇条書き（・始まり）が行ごとに分かれて保持される', () => {
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 200, h: 80 },
      multiline: true,
    })
    const r = fitTextInBox('・項目A\n・項目B\n・項目C', field, fixedFont)
    expect(r.lines).toEqual(['・項目A', '・項目B', '・項目C'])
  })

  it('空行（連続 \\n）も 1 行として保持される', () => {
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 200, h: 80 },
      multiline: true,
    })
    const r = fitTextInBox('上\n\n下', field, fixedFont)
    expect(r.lines).toEqual(['上', '', '下'])
  })

  it('単一行（\\n 無し）は従来どおり 1 行（回帰なし）', () => {
    const field = makeField({ bbox: { page: 1, x: 0, y: 0, w: 200, h: 30 } })
    const r = fitTextInBox('abc', field, fixedFont)
    expect(r.lines).toEqual(['abc'])
    expect(r.warning).toBe('none')
  })

  it('multiline=false でも改行は尊重し、各段落は 1 行のまま', () => {
    // 非 multiline は段落内の自動 wrap を行わないが、明示改行 \n では行を分ける。
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 200, h: 80 },
      multiline: false,
    })
    const r = fitTextInBox('左\n右', field, fixedFont)
    expect(r.lines).toEqual(['左', '右'])
  })

  it('改行行数が多く高さオーバーなら truncated（最終行に "…"）', () => {
    // 行高 = 12 * 1.2 = 14.4。maxH = 30-8 = 22 → maxLines = floor(22/14.4)=1。
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 200, h: 30 },
      multiline: true,
    })
    const r = fitTextInBox('一\n二\n三\n四', field, fixedFont)
    expect(r.truncated).toBe(true)
    expect(r.warning).toBe('truncated')
    expect(r.lines[r.lines.length - 1].endsWith('…')).toBe(true)
  })

  it('長い段落は multiline=true で幅 wrap され改行も併用される', () => {
    // 段落1は幅オーバーで自動 wrap、段落2は短い。両方 lines に展開される。
    // bbox w=60 (maxW=52)。'ABCDEFGHIJKLMN' は 8pt で 56pt → wrap。
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 60, h: 200 },
      multiline: true,
    })
    const r = fitTextInBox('ABCDEFGHIJKLMN\nXY', field, fixedFont)
    // 段落1 が複数行に分かれ、末尾に 'XY' 段落が来る。
    expect(r.lines.length).toBeGreaterThanOrEqual(3)
    expect(r.lines[r.lines.length - 1]).toBe('XY')
    expect(r.lines.join('')).toBe('ABCDEFGHIJKLMNXY')
  })
})

describe('fitTextInBox - heightRatio 統一（uniform が縮め返されない）', () => {
  it('heightRatio 未指定は従来どおり font.heightAtSize で高さ判定（後方互換・固定テキスト経路）', () => {
    // tallFont: heightAtSize(size)=size*1.448。bbox h=20, pad 4+4 → maxH=12。
    // uniform 注入相当で font.size=10。heightAtSize(10)=14.48 > 12 → Step 1 で入らず縮む。
    // heightRatio 未指定 = 従来挙動。
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 400, h: 20 },
      font: { family: 'Noto Sans JP', size: 10 },
    })
    const r = fitTextInBox('短文', field, tallFont)
    expect(r.warning).toBe('shrunk')
    expect(r.fontSize).toBeLessThan(10)
  })

  it('heightRatio=FIT_HEIGHT_RATIO(1.0) なら同じ欄で uniform=10pt が Step 1 温存（縮め返さない）', () => {
    // 同じ tallFont・同じ欄（maxH=12）でも、高さ判定が size*1.0 になる。
    // 10pt * 1.0 = 10 <= maxH=12 → Step 1 で入る → warning='none'・fontSize=10 のまま。
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 400, h: 20 },
      font: { family: 'Noto Sans JP', size: 10 },
    })
    const r = fitTextInBox('短文', field, tallFont, undefined, FIT_HEIGHT_RATIO)
    expect(r.warning).toBe('none')
    expect(r.fontSize).toBe(10)
    expect(r.lines).toEqual(['短文'])
  })

  it('heightRatio 指定でも幅オーバーは従来どおり縮む（幅判定は heightRatio 非依存）', () => {
    // 幅で溢れるケースは heightRatio に関係なく縮む（高さ統一は幅判定を緩めない）。
    // bbox w=60 (maxW=52)、'ABCDEFGHIJ'(10字) を 12pt: 60pt > 52 → 縮む。
    const field = makeField({ bbox: { page: 1, x: 0, y: 0, w: 60, h: 200 } })
    const r = fitTextInBox('ABCDEFGHIJ', field, fixedFont, undefined, FIT_HEIGHT_RATIO)
    expect(r.warning).toBe('shrunk')
    expect(r.fontSize).toBeLessThan(12)
  })

  it('multiline 改行も heightRatio で高さ判定統一（行数が枠に収まる）', () => {
    // tallFont。h=40, pad 4+4 → maxH=32。font_size_min=8。
    // 旧 heightAtSize: lineHeight=8*1.448*1.2=13.9 → maxLines=floor(32/13.9)=2。
    // heightRatio=1.0: lineHeight=8*1.0*1.2=9.6 → maxLines=floor(32/9.6)=3（より多く収まる）。
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 60, h: 40 },
      multiline: true,
      font: { family: 'Noto Sans JP', size: 8 },
    })
    const r = fitTextInBox('一\n二\n三', field, tallFont, undefined, FIT_HEIGHT_RATIO)
    // 3 行が maxH=32 に収まる（lineHeight 9.6 * 3 = 28.8 <= 32）→ 切り詰めなし。
    expect(r.truncated).toBe(false)
    expect(r.lines).toEqual(['一', '二', '三'])
  })

  it('FIT_HEIGHT_RATIO は 1.0（漢字 em 基準・uniform-size と一致）', () => {
    expect(FIT_HEIGHT_RATIO).toBe(1.0)
  })
})

describe('fitTextInBox - lockSize（uniform 固定）', () => {
  // uniform 算出 pad と fit pad の不一致で、小欄は uniform を高さで縮め返す問題への対処。
  // lockSize=true は高さ縮小を抑止し uniform を最終サイズに固定する（幅は wrap/省略で吸収）。

  it('小欄（高さ不足）でも lockSize=true なら uniform=14pt が縮まず固定される', () => {
    // bbox h=16, pad 4+4 → maxH=8。uniform 注入で font.size=14。
    // lockSize 無し: heightAtSize(14)=14 > maxH=8 → Step2 が縮める。
    // lockSize=true: maxH=∞ で高さ判定無効 → 14pt 維持。幅は広い（w=400）ので 1 行 none。
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 400, h: 16 },
      font: { family: 'Noto Sans JP', size: 14 },
    })
    const r = fitTextInBox('日付テキスト', field, fixedFont, undefined, FIT_HEIGHT_RATIO, {
      lockSize: true,
    })
    expect(r.fontSize).toBe(14)
    expect(r.warning).toBe('none')
    expect(r.lines).toEqual(['日付テキスト'])
  })

  it('同じ小欄でも lockSize なし（従来）は高さで縮め返す（回帰対照）', () => {
    // lockSize を渡さない uniform 経路（heightRatio のみ）は maxH=8 で 14pt が入らず縮む。
    // lockSize 導入前の振る舞いを固定して非 lockSize 経路の回帰を守る。
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 400, h: 16 },
      font: { family: 'Noto Sans JP', size: 14 },
    })
    const r = fitTextInBox('日付テキスト', field, fixedFont, undefined, FIT_HEIGHT_RATIO)
    expect(r.fontSize).toBeLessThan(14)
    expect(r.warning).toBe('shrunk')
  })

  it('lockSize=true で幅オーバー & multiline は uniform サイズのまま wrap（縮小しない）', () => {
    // bbox w=60 (maxW=52), h=18（小欄）。font.size=14。'ABCDEFGHIJ'(10字) を 14pt: 70pt > 52。
    // lockSize: 縮めず 14pt のまま wrap（高さ∞で行数無制限・truncate しない）。
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 60, h: 18 },
      multiline: true,
      font: { family: 'Noto Sans JP', size: 14 },
    })
    const r = fitTextInBox('ABCDEFGHIJ', field, fixedFont, undefined, FIT_HEIGHT_RATIO, {
      lockSize: true,
    })
    expect(r.fontSize).toBe(14)
    expect(r.warning).toBe('wrapped')
    expect(r.lines.length).toBeGreaterThan(1)
    expect(r.lines.join('')).toBe('ABCDEFGHIJ')
    expect(r.truncated).toBe(false)
  })

  it('lockSize=true で幅オーバー & 非 multiline は uniform サイズで末尾省略（縮小しない）', () => {
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 60, h: 18 },
      multiline: false,
      font: { family: 'Noto Sans JP', size: 14 },
    })
    const r = fitTextInBox('A'.repeat(30), field, fixedFont, undefined, FIT_HEIGHT_RATIO, {
      lockSize: true,
    })
    expect(r.fontSize).toBe(14)
    expect(r.warning).toBe('truncated')
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].endsWith('…')).toBe(true)
  })

  it('lockSize=true で \\n 入り長文も uniform 固定で wrap・truncate されない（議事内容ケース）', () => {
    // 大欄想定 h=300。改行 + 長段落。lockSize で 14pt 維持・全行展開（minSize へ落とさない）。
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 200, h: 300 },
      multiline: true,
      font: { family: 'Noto Sans JP', size: 14 },
    })
    const r = fitTextInBox('一行目テキスト\n二行目テキスト', field, fixedFont, undefined, FIT_HEIGHT_RATIO, {
      lockSize: true,
    })
    expect(r.fontSize).toBe(14)
    expect(r.truncated).toBe(false)
    expect(r.lines[0]).toContain('一行目')
    expect(r.lines.join('')).toContain('二行目')
  })

  it('lockSize 未指定（固定テキスト経路）は従来どおり（後方互換・回帰最優先）', () => {
    // options を渡さない呼出は既存挙動と完全一致（固定テキスト C-2 / 既存呼出を守る）。
    const field = makeField({ bbox: { page: 1, x: 0, y: 0, w: 200, h: 30 } })
    const r = fitTextInBox('abc', field, fixedFont)
    expect(r.fontSize).toBe(12)
    expect(r.warning).toBe('none')
    expect(r.lines).toEqual(['abc'])
  })
})

describe('wrapText (helper)', () => {
  it('日本語文字単位で改行', () => {
    // maxW = 40, fontSize = 8 → 1 文字 = 4pt、10 文字で 40pt
    const lines = wrapText('あいうえおかきくけこさしすせそ', 40, fixedFont, 8)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines.join('')).toBe('あいうえおかきくけこさしすせそ')
  })

  it('空文字列は ["" ] を返す', () => {
    expect(wrapText('', 100, fixedFont, 12)).toEqual([''])
  })
})

/**
 * 行頭禁則ぶら下げ仕様（回帰防止の基準）:
 *   - `candidate = current + ch` が maxWidth 超過時、`ch` が LINE_HEAD_KINSOKU に
 *     含まれる場合は改行せず前行末にぶら下げる（はみ出し方式）。
 *   - 連続禁則（例: 「）。」）は while で全部ぶら下げ。
 *   - 1 行目先頭が禁則の場合はぶら下げ先が無いためそのまま先頭に置く（フォールバック）。
 *   - 禁則文字を含まないテキストでは従来挙動と完全同一（回帰ゼロ）。
 */
describe('wrapText - 行頭禁則ぶら下げ（改善③）', () => {
  it('LINE_HEAD_KINSOKU に標準サブセット + 小書き仮名が含まれる', () => {
    // 標準サブセット + 小書き仮名（拗音・促音）
    for (const ch of ['。', '、', '）', '」', '』', '！', '？', 'ー', '…', '‼', '⁇']) {
      expect(LINE_HEAD_KINSOKU.has(ch)).toBe(true)
    }
    // 小書き仮名（ひらがな）
    for (const ch of ['ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'っ', 'ゃ', 'ゅ', 'ょ', 'ゎ']) {
      expect(LINE_HEAD_KINSOKU.has(ch)).toBe(true)
    }
    // 小書き仮名（カタカナ）
    for (const ch of ['ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ッ', 'ャ', 'ュ', 'ョ']) {
      expect(LINE_HEAD_KINSOKU.has(ch)).toBe(true)
    }
    // 通常文字は含まれない
    for (const ch of ['あ', 'い', 'う', '読', '書', 'A', '1']) {
      expect(LINE_HEAD_KINSOKU.has(ch)).toBe(false)
    }
  })

  it('行頭が「。」になる場合は前行末にぶら下げる（はみ出し）', () => {
    // fixedFont: 1 文字 = fontSize * 0.5 pt。fontSize=10 → 1 文字 5pt。
    // maxW=20 → 通常なら 4 文字で改行。'あいうえ。' を入れて 4 文字目までで改行発生時、
    // 5 文字目「。」は禁則なのでぶら下げて 1 行目末に置く。
    const lines = wrapText('あいうえ。お', 20, fixedFont, 10)
    // 1 行目に「。」がぶら下がっている（'あいうえ。'）
    expect(lines[0]).toBe('あいうえ。')
    expect(lines[1]).toBe('お')
    expect(lines.join('')).toBe('あいうえ。お')
  })

  it('連続禁則（）。）は両方とも前行末にぶら下げる', () => {
    // 'あいうえ）。お' → 4 文字目で改行候補 → 5 文字目「）」禁則ぶら下げ →
    //                    6 文字目「。」も禁則ぶら下げ → 7 文字目「お」で改行
    const lines = wrapText('あいうえ）。お', 20, fixedFont, 10)
    expect(lines[0]).toBe('あいうえ）。')
    expect(lines[1]).toBe('お')
    expect(lines.join('')).toBe('あいうえ）。お')
  })

  it('禁則なし → 従来同一（回帰ゼロ）', () => {
    // 既存テスト「日本語文字単位で改行」と同パターンで挙動不変であることを確認
    const lines = wrapText('あいうえおかきくけこさしすせそ', 40, fixedFont, 8)
    // maxW=40 / fontSize=8 → 1 文字=4pt → 10 文字で 40pt
    // 11 文字目で改行 → 1 行目 'あいうえおかきくけこ'（10 文字）
    expect(lines[0]).toBe('あいうえおかきくけこ')
    expect(lines[1]).toBe('さしすせそ')
    expect(lines.join('')).toBe('あいうえおかきくけこさしすせそ')
  })

  it('1 行目先頭が禁則（前行なし）→ そのまま先頭に置く（フォールバック）', () => {
    // 「。あいう」を maxW=20, fontSize=10 で wrap。
    // 1 文字目「。」は current.length===0 のため current = '。' に直接セットされる
    // （ぶら下げ先なし）。2 文字目以降は通常通り。
    const lines = wrapText('。あいうえお', 20, fixedFont, 10)
    expect(lines[0]?.startsWith('。')).toBe(true)
    expect(lines.join('')).toBe('。あいうえお')
  })

  it('小書き仮名「ね」は通常仮名のため改行する（対照）／「っ」はぶら下げる', () => {
    // 「ね」（通常仮名）→ 行頭に来たら改行する（通常挙動）
    // 'あいうえね' → 5 文字目で 25pt 超過、'ね' は非禁則なので 4 文字で改行 → 'ね' は次行先頭
    const linesNe = wrapText('あいうえね', 20, fixedFont, 10)
    expect(linesNe[0]).toBe('あいうえ')
    expect(linesNe[1]).toBe('ね')

    // 「っ」（小書き仮名・促音）→ 行頭に来たら前行末にぶら下げる
    const linesTsu = wrapText('あいうえっと', 20, fixedFont, 10)
    expect(linesTsu[0]).toBe('あいうえっ')
    expect(linesTsu[1]).toBe('と')
  })

  it('小書き仮名（拗音）「ゃゅょ」も行頭禁則', () => {
    // 「あいうえょ」→ 5 文字目「ょ」は小書き仮名→ぶら下げ
    const lines = wrapText('あいうえょ', 20, fixedFont, 10)
    expect(lines[0]).toBe('あいうえょ')
    expect(lines.length).toBe(1)
  })

  it('長文の途中で複数回ぶら下げが発生しても整合性を維持する', () => {
    // 'ABCD。EFGH、IJKL' を maxW=20, fontSize=10 で wrap（1 文字 5pt → 4 文字で行）
    // 'ABCD' → 5 文字目 '。' ぶら下げ → 'ABCD。' / 'EFGH' → 9 文字目 '、' ぶら下げ
    // → 'EFGH、' / 'IJKL'
    const lines = wrapText('ABCD。EFGH、IJKL', 20, fixedFont, 10)
    expect(lines).toEqual(['ABCD。', 'EFGH、', 'IJKL'])
    expect(lines.join('')).toBe('ABCD。EFGH、IJKL')
  })
})

/**
 * 3 経路一致テスト（ドリフト再発防止の必須ゲート）。
 *
 * 同一 text / maxWidth / font / fontSize で `wrapText` を呼ぶと、
 *   ① PDF 経路（overlay-generator → fitting.fitMultiline → wrapText）
 *   ② 画像経路（image-renderer → 同上）
 *   ③ canvas プレビュー経路（field-values-composite-canvas が wrapText を直 import）
 * がすべて同じ行配列を返すことを担保する。
 *
 * 3 経路は `fitting.ts` の `wrapText` を唯一の wrap 実装として共有する。
 * 本テストは `wrapText` 自身（=共有純関数）の入出力一致を確認することで、
 * 3 経路の一致を構造的に保証する（同一純関数・同一入力＝同一出力）。
 */
describe('wrapText - 3 経路一致（PDF / 画像 / canvas プレビューが共有する唯一の wrap）', () => {
  it('禁則ぶら下げ結果が同一入力で完全一致する（同じ純関数を 2 回呼んで配列等価）', () => {
    const text = '会議の議事内容です。次の項目に進みます、お願いします）。'
    const maxWidth = 50
    const fontSize = 10

    // PDF 経路相当の呼び出し（fitting.ts wrapText を直接呼ぶ）
    const linesPdf = wrapText(text, maxWidth, fixedFont, fontSize)
    // 画像経路相当の呼び出し（同一純関数を再度呼ぶ）
    const linesImage = wrapText(text, maxWidth, fixedFont, fontSize)
    // canvas プレビュー経路相当の呼び出し（field-values-composite-canvas が
    // fitting.ts から wrapText を直 import している = 物理的に同一関数）
    const linesCanvas = wrapText(text, maxWidth, fixedFont, fontSize)

    expect(linesPdf).toEqual(linesImage)
    expect(linesImage).toEqual(linesCanvas)
    expect(linesPdf).toEqual(linesCanvas)

    // 全行を連結すると元テキストと一致（禁則ぶら下げで文字欠落しない）
    expect(linesPdf.join('')).toBe(text)
    // 禁則文字が行頭に来ていない（最初の行を除き）
    for (let i = 1; i < linesPdf.length; i++) {
      const head = linesPdf[i]?.[0]
      if (head !== undefined) {
        expect(LINE_HEAD_KINSOKU.has(head)).toBe(false)
      }
    }
  })

  it('禁則を含まないテキストは 3 経路で同一かつ既存と回帰なし', () => {
    const text = 'あいうえおかきくけこさしすせそ'
    const maxWidth = 40
    const fontSize = 8

    const a = wrapText(text, maxWidth, fixedFont, fontSize)
    const b = wrapText(text, maxWidth, fixedFont, fontSize)
    expect(a).toEqual(b)
    // 既存テスト挙動と一致（10 文字＋5 文字）
    expect(a).toEqual(['あいうえおかきくけこ', 'さしすせそ'])
  })
})

describe('truncateWithEllipsis (helper)', () => {
  it('収まる text はそのまま返す', () => {
    expect(truncateWithEllipsis('abc', 100, fixedFont, 12)).toBe('abc')
  })

  it('長い text は末尾 "…" 付与', () => {
    // 'A'.repeat(20) を 12pt: 20 * 12 * 0.5 = 120pt、maxW=60 で trim
    const result = truncateWithEllipsis('A'.repeat(20), 60, fixedFont, 12)
    expect(result.endsWith('…')).toBe(true)
    expect(result.length).toBeLessThan(20)
  })

  it('空文字列は空文字列', () => {
    expect(truncateWithEllipsis('', 100, fixedFont, 12)).toBe('')
  })
})
