/**
 * FieldBboxDetector unit test（白塗り v0.7.1、設計書 n6_layout_structure_draft_v0.7.1 §9 ケース 1〜6）。
 *
 * @napi-rs/canvas のデコードを切り離し、合成 ImageData（RGBA）を直接
 * detectFieldBboxesFromImageData / detectLines に流して検証する。
 *
 * 検証（§9）:
 *   1. 3×3 罫線グリッド → エリアA セル 9 個、隣接整合（座標が罫線内側）
 *   2. 内部罫線なし大枠（外周のみ）→ エリアB 1 枠検出（v0.6 漏れ回帰）
 *   3. 記入文字行を含む大枠 → 文字行が横罫線に誤検出されず 1 枠維持（§4-2 LINE_RUN_RATIO）
 *   4. 1 パス投影 + 最長ラン集計が罫線（連続）と文字行（途切れ）を区別（高速化リグレ）
 *   5. ダウンサンプル(C)有無で罫線座標 ±数 px 一致
 *   6. 背景色（グレー帯）を一切参照しない（GRAY_* const 不在 + 灰色背景で結果一致）
 */
import { describe, it, expect } from 'vitest'
import {
  detectFieldBboxesFromImageData,
  BINARIZE_LUMA_THRESHOLD,
  LINE_FILL_RATIO,
  LINE_RUN_RATIO,
  VLINE_BAND_RUN_RATIO,
  VLINE_BAND_FILL_RATIO,
  DETECT_DOWNSAMPLE,
  INSET_PT,
  __internal_field_bbox_detector,
  type FieldBox,
} from '@/lib/parsers/pdf/field-bbox-detector'

/** 全白（255,255,255,255）の RGBA バッファ。 */
function makeWhiteCanvas(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  data.fill(255)
  return data
}

/** 全面を指定輝度（背景色）で塗った RGBA バッファ。背景色非依存検証用。 */
function makeFilledCanvas(w: number, h: number, v: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = v
    data[i * 4 + 1] = v
    data[i * 4 + 2] = v
    data[i * 4 + 3] = 255
  }
  return data
}

function setPixel(data: Uint8ClampedArray, w: number, x: number, y: number, v: number): void {
  const i = (y * w + x) * 4
  data[i] = v
  data[i + 1] = v
  data[i + 2] = v
  data[i + 3] = 255
}

/** y 行に横罫線（fillRatio 区間を塗る。fillRatio=1.0 で全幅連続線）。 */
function drawHLine(data: Uint8ClampedArray, w: number, y: number, v = 0, fillRatio = 1.0): void {
  const fillTo = Math.floor(w * fillRatio)
  for (let x = 0; x < fillTo; x++) setPixel(data, w, x, y, v)
}

/** x 列に縦罫線。 */
function drawVLine(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  v = 0,
  fillRatio = 1.0,
): void {
  const fillTo = Math.floor(h * fillRatio)
  for (let y = 0; y < fillTo; y++) setPixel(data, w, x, y, v)
}

/** x 列の [y0, y1) 区間にだけ縦罫線を引く（帯ローカル縦罫線の合成用、v0.7.2）。 */
function drawVLineRange(
  data: Uint8ClampedArray,
  w: number,
  x: number,
  y0: number,
  y1: number,
  v = 0,
): void {
  for (let y = y0; y < y1; y++) setPixel(data, w, x, y, v)
}

/** x 列の [y0, y1) 区間に「縦並び文字」を模したまだら縦線（多数の暗ピクセルだが連続しない）。 */
function drawVTextRange(
  data: Uint8ClampedArray,
  w: number,
  x: number,
  y0: number,
  y1: number,
): void {
  // 2px 黒 + 4px 白の繰り返し（暗ピクセル総数は多いが最長ランは 2px = 帯高比率に届かない）
  for (let y = y0; y < y1; y++) {
    if ((y - y0) % 6 < 2) {
      setPixel(data, w, x, y, 0)
      setPixel(data, w, x + 1, y, 0)
    }
  }
}

/**
 * y 行に「記入文字行」を模したまだら線を引く（多数の暗ピクセルだが連続しない）。
 * total 比率は高いが最長ランが短い → LINE_RUN_RATIO で罫線に化けないことを検証する。
 */
function drawTextRow(data: Uint8ClampedArray, w: number, y: number): void {
  // 2px 黒 + 4px 白 の繰り返し（暗ピクセル総数 ≈ 1/3、最長ラン = 2px）
  for (let x = 0; x < w; x++) {
    if (x % 6 < 2) {
      setPixel(data, w, x, y, 0)
      setPixel(data, w, x, y + 1, 0)
    }
  }
}

describe('detectFieldBboxesFromImageData（v0.7.1 罫線検出: 連続性 + エリアA/B + 背景色非依存）', () => {
  it('ケース1: 3×3 罫線グリッド → エリアA セル 9 個、隣接整合', () => {
    const w = 120
    const h = 120
    const data = makeWhiteCanvas(w, h)
    const hs = [10, 40, 70, 100]
    const vs = [10, 40, 70, 100]
    for (const y of hs) drawHLine(data, w, y)
    for (const x of vs) drawVLine(data, w, h, x)

    const boxes = detectFieldBboxesFromImageData(data, w, h, 1, 120, 120)
    const areaA = boxes.filter(b => b.area === 'A')
    expect(areaA.length).toBe(9)

    const xs = Array.from(new Set(areaA.map(b => Math.round(b.bbox.x)))).sort((a, c) => a - c)
    const ys = Array.from(new Set(areaA.map(b => Math.round(b.bbox.y)))).sort((a, c) => a - c)
    // ±DETECT_DOWNSAMPLE px の量子化を許容して罫線位置と一致
    expect(xs.length).toBe(3)
    expect(ys.length).toBe(3)
    expect(xs[0]).toBeGreaterThanOrEqual(10 - DETECT_DOWNSAMPLE)
    expect(xs[0]).toBeLessThanOrEqual(10 + DETECT_DOWNSAMPLE)
  })

  it('ケース2: 内部罫線なし大枠（外周のみ）→ エリアB 1 枠検出（v0.6 漏れ回帰）', () => {
    const w = 200
    const h = 200
    const data = makeWhiteCanvas(w, h)
    // 外周 4 本のみ（内部に縦罫線を一切置かない = 大記述エリア）
    drawHLine(data, w, 20)
    drawHLine(data, w, 180)
    drawVLine(data, w, h, 20)
    drawVLine(data, w, h, 180)

    const boxes = detectFieldBboxesFromImageData(data, w, h, 1, 200, 200)
    const areaB = boxes.filter(b => b.area === 'B')
    // 外周 4 本だけで大枠が 1 矩形として成立する（内部罫線不要）
    expect(areaB.length).toBe(1)
    expect(areaB[0].bbox.w).toBeGreaterThan(100)
    expect(areaB[0].bbox.h).toBeGreaterThan(100)
  })

  it('ケース3: 記入文字行を含む大枠 → 文字行が横罫線に誤検出されず 1 枠維持（LINE_RUN_RATIO）', () => {
    const w = 200
    const h = 200
    const data = makeWhiteCanvas(w, h)
    // 外周 4 本
    drawHLine(data, w, 20)
    drawHLine(data, w, 180)
    drawVLine(data, w, h, 20)
    drawVLine(data, w, h, 180)
    // 大枠内部に記入文字行を 3 行（途切れる暗ピクセル）→ 横罫線に化けてはいけない
    drawTextRow(data, w, 60)
    drawTextRow(data, w, 100)
    drawTextRow(data, w, 140)

    const boxes = detectFieldBboxesFromImageData(data, w, h, 1, 200, 200)
    const areaB = boxes.filter(b => b.area === 'B')
    // 文字行が横罫線として誤検出されると大枠が分断され areaB が 0 or 細切れ。
    // LINE_RUN_RATIO で文字行が落ちるので大枠は 1 枠を維持する。
    expect(areaB.length).toBe(1)
    expect(areaB[0].bbox.h).toBeGreaterThan(100)
  })

  it('ケース4: 最長ラン集計が連続線（罫線）と途切れ行（文字）を区別する', () => {
    const w = 120
    const h = 120
    const data = makeWhiteCanvas(w, h)
    drawHLine(data, w, 20) // 連続線 → 罫線
    drawHLine(data, w, 100) // 連続線 → 罫線
    drawVLine(data, w, h, 20)
    drawVLine(data, w, h, 100)
    drawTextRow(data, w, 60) // 途切れ行 → 罫線にしない

    const { hLines } = __internal_field_bbox_detector.detectLines(data, w, h)
    // y=60 付近の途切れ行は罫線化されない（hLines は外周 2 本相当のみ）
    const near60 = hLines.filter(y => Math.abs(y - 60) <= 4)
    expect(near60.length).toBe(0)
    // 連続線 2 本は検出される
    expect(hLines.length).toBe(2)
  })

  it('ケース5r: detectLines がダウンサンプル後 index でなく元解像度 px で罫線を返す（step 復元回帰）', () => {
    // 真因調査（N-6 painted=0 依頼1）の回帰: DETECT_DOWNSAMPLE=2 で間引き走査した罫線位置を
    // step 倍で元解像度に復元せず「ダウンサンプル後 index のまま」返すと、座標が実寸の約 1/2 に
    // なり written_bbox（正しい pt 座標）と中心包含しなくなる。元解像度で返ることを直接検証する。
    expect(DETECT_DOWNSAMPLE).toBe(2) // 復元が効く（step>1）前提
    const w = 400
    const h = 400
    const data = makeWhiteCanvas(w, h)
    // 元解像度で十分大きい座標に罫線を引く（復元漏れなら 1/2 ≈ 150/300 になる）。
    const hys = [100, 300]
    const vxs = [100, 300]
    for (const y of hys) drawHLine(data, w, y)
    for (const x of vxs) drawVLine(data, w, h, x)

    const { hLines, vLines } = __internal_field_bbox_detector.detectLines(data, w, h)
    expect(hLines.length).toBe(2)
    expect(vLines.length).toBe(2)
    // 復元漏れ（index のまま）だと 50/150 付近になる。元解像度なら 100/300 付近（±step）。
    for (const [got, want] of hLines.map((v, i) => [v, hys[i]] as const)) {
      expect(Math.abs(got - want)).toBeLessThanOrEqual(DETECT_DOWNSAMPLE)
    }
    for (const [got, want] of vLines.map((v, i) => [v, vxs[i]] as const)) {
      expect(Math.abs(got - want)).toBeLessThanOrEqual(DETECT_DOWNSAMPLE)
    }
  })

  it('ケース5: ダウンサンプル有無で罫線座標が ±数 px で一致', () => {
    const w = 160
    const h = 160
    const data = makeWhiteCanvas(w, h)
    // 内部縦罫線（x=72）を 1 本入れ、左セルが「内部縦罫線あり = エリアA」になるようにする。
    // dedup（内部縦罫線なしの帯はエリアB に倒れる）ため、エリアA セルの
    // 座標量子化を検証するには内部縦罫線を持つグリッドにする必要がある。
    drawHLine(data, w, 24)
    drawHLine(data, w, 120)
    drawVLine(data, w, h, 24)
    drawVLine(data, w, h, 72)
    drawVLine(data, w, h, 120)

    const boxes = detectFieldBboxesFromImageData(data, w, h, 1, 160, 160)
    const areaA = boxes.filter(b => b.area === 'A')
    // 内部縦罫線ありなので 24-72 / 72-120 の 2 セルがエリアA で生成される
    expect(areaA.length).toBe(2)
    const left = areaA.find(b => Math.abs(b.bbox.x - 24) <= DETECT_DOWNSAMPLE)
    expect(left).toBeDefined()
    const b = left!.bbox
    // sx=sy=1。ダウンサンプル量子化で ±DETECT_DOWNSAMPLE px 以内
    expect(Math.abs(b.x - 24)).toBeLessThanOrEqual(DETECT_DOWNSAMPLE)
    expect(Math.abs(b.y - 24)).toBeLessThanOrEqual(DETECT_DOWNSAMPLE)
  })

  it('ケース2b: dedup — 内部縦罫線なし大枠はエリアB のみ生成（エリアA に同一矩形を二重生成しない）', () => {
    const w = 200
    const h = 200
    const data = makeWhiteCanvas(w, h)
    drawHLine(data, w, 20)
    drawHLine(data, w, 180)
    drawVLine(data, w, h, 20)
    drawVLine(data, w, h, 180)

    const boxes = detectFieldBboxesFromImageData(data, w, h, 1, 200, 200)
    // 外周のみの帯は area B 1 枠だけ。dedup 前は同一座標の area A セルも生成され二重塗りだった。
    expect(boxes.filter(b => b.area === 'B').length).toBe(1)
    expect(boxes.filter(b => b.area === 'A').length).toBe(0)
    expect(boxes.length).toBe(1)
  })

  it('ケース6a: 灰色背景でも白背景と同じ罫線検出結果（背景色非参照）', () => {
    const w = 200
    const h = 200
    const drawFrame = (d: Uint8ClampedArray) => {
      drawHLine(d, w, 20)
      drawHLine(d, w, 180)
      drawVLine(d, w, h, 20)
      drawVLine(d, w, h, 180)
    }
    const white = makeWhiteCanvas(w, h)
    drawFrame(white)
    // 灰色背景（luma=200、二値化閾値 160 超なので暗ピクセル化しない）
    const gray = makeFilledCanvas(w, h, 200)
    drawFrame(gray)

    const boxesWhite = detectFieldBboxesFromImageData(white, w, h, 1, 200, 200)
    const boxesGray = detectFieldBboxesFromImageData(gray, w, h, 1, 200, 200)
    // 背景色が違っても枠検出は同一（背景色を一切判定に使っていない）
    expect(boxesGray.length).toBe(boxesWhite.length)
    expect(boxesGray.filter(b => b.area === 'B').length).toBe(
      boxesWhite.filter(b => b.area === 'B').length,
    )
  })

  it('ケース6b: ソースに GRAY_* / rowGray 系のシンボルが存在しない（背景色非依存の静的確認）', async () => {
    // import 名前空間に GRAY 系 export が無いことを確認（コンパイル時の静的保証）。
    // 注（v0.7.2）: VLINE_BAND_FILL_RATIO は「帯ローカル縦罫線の暗ピクセル総数比率」であり
    // 背景色（GRAY）とは無関係。背景色非依存の判定基準は「GRAY/rowGray シンボル不在」で行う。
    const mod = await import('@/lib/parsers/pdf/field-bbox-detector')
    const keys = Object.keys(mod)
    expect(keys.some(k => /GRAY/i.test(k))).toBe(false)
    expect(keys.some(k => /rowGray/i.test(k))).toBe(false)
  })

  it('閾値定数が設計 §11/§13 値と一致（const 集中定義の回帰）', () => {
    expect(BINARIZE_LUMA_THRESHOLD).toBe(160)
    expect(LINE_FILL_RATIO).toBe(0.5)
    expect(LINE_RUN_RATIO).toBe(0.6)
    // v0.7.2 新設（§11）: 帯ローカル縦罫線の閾値
    expect(VLINE_BAND_RUN_RATIO).toBe(0.7)
    expect(VLINE_BAND_FILL_RATIO).toBe(0.5)
    expect(DETECT_DOWNSAMPLE).toBe(2)
    expect(INSET_PT).toBe(2.0)
  })

  it('罫線が 1 本以下なら空配列（閉じた枠を構成できない）', () => {
    const w = 100
    const h = 100
    const data = makeWhiteCanvas(w, h)
    drawHLine(data, w, 50)
    const boxes: FieldBox[] = detectFieldBboxesFromImageData(data, w, h, 1, 100, 100)
    expect(boxes.length).toBe(0)
  })
})

describe('v0.7.2 帯ローカル縦罫線検出（設計 §3 / §8 回帰: 短い内部縦罫線 + 帯別セル分割）', () => {
  it('ケースV1: ページ全高は通さないが帯高を貫く短い縦罫線が帯ローカルで検出される（主回帰）', () => {
    // 真因（v0.7.1 vLines=2）の根治確認。
    // レイアウト: 横罫線 4 本（y=20,80,140,200）で 3 帯。外周縦罫線 2 本（全高通し）。
    // 第 2 帯（y=80..140）だけに内部縦罫線 x=120 を「その帯の帯高分だけ」引く。
    // この縦罫線はページ全高（240）の 60% = 144px に届かない（帯高 60px のみ）→ v0.7.1 では全落ち。
    // v0.7.2 は帯ローカル（帯高 60px * 0.7 = 42px）基準で検出 → 代表 vLines が 2 → 3 以上に増える。
    const w = 240
    const h = 240
    const data = makeWhiteCanvas(w, h)
    const hs = [20, 80, 140, 200]
    for (const y of hs) drawHLine(data, w, y)
    drawVLine(data, w, h, 20, 0, 1.0) // 左外周（全高）
    drawVLine(data, w, h, 220, 0, 1.0) // 右外周（全高）
    drawVLineRange(data, w, 120, 80, 140) // 第2帯のみの短い内部縦罫線（帯高 60px）

    const { vLines, bandVLines } = __internal_field_bbox_detector.detectLines(data, w, h)
    // 代表 vLines は外周 2 本 + 内部 1 本 = 3 本以上（v0.7.1 なら 2 本のまま）
    expect(vLines.length).toBeGreaterThanOrEqual(3)
    // 内部縦罫線が「第 2 帯のローカル縦罫線」として現れる（外周 leftMost..rightMost 内側）
    const band1Inner = bandVLines[1].filter(x => x > 20 + DETECT_DOWNSAMPLE && x < 220 - DETECT_DOWNSAMPLE)
    expect(band1Inner.length).toBeGreaterThanOrEqual(1)
    expect(band1Inner.some(x => Math.abs(x - 120) <= DETECT_DOWNSAMPLE * 2)).toBe(true)
    // 内部縦罫線を持たない帯（第 0 / 第 2 帯）は帯ローカル内部縦罫線が空
    expect(bandVLines[0].filter(x => x > 20 + DETECT_DOWNSAMPLE && x < 220 - DETECT_DOWNSAMPLE).length).toBe(0)
    expect(bandVLines[2].filter(x => x > 20 + DETECT_DOWNSAMPLE && x < 220 - DETECT_DOWNSAMPLE).length).toBe(0)
  })

  it('ケースV2: 上段2セル + 下段3セル → 帯ごとに異なる縦区切りでエリアA セルが生成される', () => {
    // 上段（y=20..120）: 内部縦罫線 1 本（x=200）→ 2 セル
    // 下段（y=120..220）: 内部縦罫線 2 本（x=140, 260）→ 3 セル
    // v0.7.1 のグローバル vLines 総当りでは帯ごとに異なる区切りを表現できなかった。
    const w = 400
    const h = 240
    const data = makeWhiteCanvas(w, h)
    const hs = [20, 120, 220]
    for (const y of hs) drawHLine(data, w, y)
    drawVLine(data, w, h, 20, 0, 1.0) // 左外周
    drawVLine(data, w, h, 380, 0, 1.0) // 右外周
    drawVLineRange(data, w, 200, 20, 120) // 上段の内部縦罫線（帯ローカル）
    drawVLineRange(data, w, 140, 120, 220) // 下段の内部縦罫線1
    drawVLineRange(data, w, 260, 120, 220) // 下段の内部縦罫線2

    const boxes = detectFieldBboxesFromImageData(data, w, h, 1, 400, 240)
    const areaA = boxes.filter(b => b.area === 'A')
    // 上段 2 セル + 下段 3 セル = 5 セル
    expect(areaA.length).toBe(5)
    // 上段帯（y≈20）に 2 セル
    const upper = areaA.filter(b => Math.abs(b.bbox.y - 20) <= DETECT_DOWNSAMPLE * 2)
    expect(upper.length).toBe(2)
    // 下段帯（y≈120）に 3 セル
    const lower = areaA.filter(b => Math.abs(b.bbox.y - 120) <= DETECT_DOWNSAMPLE * 2)
    expect(lower.length).toBe(3)
  })

  it('ケースV3: 内部縦罫線なし帯 → エリアB 大枠 1 枠（v0.7.1 §4 / §3-7 維持確認）', () => {
    // 横罫線 2 本 + 外周縦罫線 2 本のみ。内部縦罫線は一切なし → エリアB として 1 矩形。
    const w = 240
    const h = 240
    const data = makeWhiteCanvas(w, h)
    drawHLine(data, w, 20)
    drawHLine(data, w, 220)
    drawVLine(data, w, h, 20, 0, 1.0)
    drawVLine(data, w, h, 220, 0, 1.0)

    const boxes = detectFieldBboxesFromImageData(data, w, h, 1, 240, 240)
    expect(boxes.filter(b => b.area === 'B').length).toBe(1)
    expect(boxes.filter(b => b.area === 'A').length).toBe(0)
  })

  it('ケースV4: 帯内の縦並び文字（縦ラン < 帯高 * RUN_RATIO）は縦罫線に誤検出されない（§3-6）', () => {
    // 第 2 帯に「縦並び文字」を模したまだら縦線を置く。最長ランが帯高比率に届かず落ちること。
    const w = 240
    const h = 240
    const data = makeWhiteCanvas(w, h)
    const hs = [20, 80, 140, 200]
    for (const y of hs) drawHLine(data, w, y)
    drawVLine(data, w, h, 20, 0, 1.0)
    drawVLine(data, w, h, 220, 0, 1.0)
    drawVTextRange(data, w, 120, 80, 140) // 第2帯に縦並び文字（途切れる）

    const { bandVLines } = __internal_field_bbox_detector.detectLines(data, w, h)
    // 第 2 帯の内部縦罫線は 0（まだら文字は帯高比率に届かない）
    const band1Inner = bandVLines[1].filter(x => x > 20 + DETECT_DOWNSAMPLE && x < 220 - DETECT_DOWNSAMPLE)
    expect(band1Inner.length).toBe(0)
  })

  it('ケースV5: 横罫線検出が v0.7.1 と一致（hLines 本数・座標が無改変）', () => {
    // 横罫線は全幅通し基準（rowDark/rowMaxRun）を維持 → 帯ローカル化の影響を受けない。
    const w = 240
    const h = 240
    const data = makeWhiteCanvas(w, h)
    const hs = [20, 80, 140, 200]
    for (const y of hs) drawHLine(data, w, y)
    drawVLine(data, w, h, 20, 0, 1.0)
    drawVLine(data, w, h, 220, 0, 1.0)

    const { hLines } = __internal_field_bbox_detector.detectLines(data, w, h)
    expect(hLines.length).toBe(4)
    for (const [got, want] of hLines.map((v, i) => [v, hs[i]] as const)) {
      expect(Math.abs(got - want)).toBeLessThanOrEqual(DETECT_DOWNSAMPLE)
    }
  })

  it('ケースV6: 灰色背景でも帯ローカル縦罫線検出が白背景と一致（背景色非参照の動的確認）', () => {
    const w = 240
    const h = 240
    const draw = (d: Uint8ClampedArray) => {
      const hs = [20, 80, 140, 200]
      for (const y of hs) drawHLine(d, w, y)
      drawVLine(d, w, h, 20, 0, 1.0)
      drawVLine(d, w, h, 220, 0, 1.0)
      drawVLineRange(d, w, 120, 80, 140)
    }
    const white = makeWhiteCanvas(w, h)
    draw(white)
    const gray = makeFilledCanvas(w, h, 200) // luma=200 > 160 なので暗ピクセル化しない
    draw(gray)

    const rW = __internal_field_bbox_detector.detectLines(white, w, h)
    const rG = __internal_field_bbox_detector.detectLines(gray, w, h)
    expect(rG.vLines.length).toBe(rW.vLines.length)
    expect(rG.hLines.length).toBe(rW.hLines.length)
  })
})
