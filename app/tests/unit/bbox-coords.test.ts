import { describe, it, expect } from 'vitest'
import {
  MIN_BBOX_PT,
  OVERLAP_GAP_PT,
  WIDGET_MARGIN_PX,
  WIDGET_FLIP_GAP_PX,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  type PageMeta,
  type BboxPt,
  displayWidth,
  displayScale,
  displayHeight,
  ptToDispX,
  ptToDispY,
  dispToPtX,
  dispToPtY,
  stepPtX,
  stepPtY,
  moveBbox,
  resizeBbox,
  resizeBboxKeepAspect,
  resizeBboxCentered,
  clampResizeToPage,
  nudgeSize,
  centerHorizontally,
  clampZoom,
  roundBbox,
  isBboxWithinPage,
  shrinkOverlaps,
  computeNudgePosition,
  splitVertical,
  centeredNewBbox,
  NEW_FIELD_W_PT,
  NEW_FIELD_H_PT,
  isWidgetEmergenceClick,
  CLICK_GUARD_MS,
} from '@/lib/pdf-output/bbox-coords'

// A4 想定（595.32 x 841.92 pt）を scale=2 でラスタライズした例。
// pixelWidth > 800 なので表示は縮小される（displayScale < 1）ケースを含む。
const META_A4: PageMeta = {
  page: 1,
  widthPt: 595.32,
  heightPt: 841.92,
  pixelWidth: 1190, // 595.32 * 2 ≒ 1190
  pixelHeight: 1684, // 841.92 * 2 ≒ 1684
}

// 表示縮小が無いケース（pixelWidth <= 800）。
const META_SMALL: PageMeta = {
  page: 1,
  widthPt: 300,
  heightPt: 400,
  pixelWidth: 600,
  pixelHeight: 800,
}

describe('bbox-coords 座標変換', () => {
  it('displayScale は縮小ケースで <1、非縮小ケースで 1', () => {
    expect(displayScale(META_A4)).toBeLessThan(1)
    expect(displayScale(META_SMALL)).toBe(1)
  })

  it('pt→表示px→pt 往復で元値に復元（誤差 < 0.5px 相当）', () => {
    // 0.5px 相当の pt 許容（横）。元画像 1px 分 pt = widthPt/pixelWidth。
    const tolX = 0.5 * (META_A4.widthPt / META_A4.pixelWidth)
    const tolY = 0.5 * (META_A4.heightPt / META_A4.pixelHeight)
    const samplesX = [0, 12.3, 100.7, 300.0, 595.32]
    const samplesY = [0, 5.5, 200.2, 600.6, 841.92]
    for (const xPt of samplesX) {
      const back = dispToPtX(META_A4, ptToDispX(META_A4, xPt))
      expect(Math.abs(back - xPt)).toBeLessThan(tolX)
    }
    for (const yPt of samplesY) {
      const back = dispToPtY(META_A4, ptToDispY(META_A4, yPt))
      expect(Math.abs(back - yPt)).toBeLessThan(tolY)
    }
  })

  it('1px ステップを 100 回加算後の累積 pt 誤差が 1px 未満', () => {
    // 100 回 × stepPt を加算 ＝ 厳密に 100*stepPt であるべき（float 累積誤差のみ）。
    const onePxPtX = META_A4.widthPt / META_A4.pixelWidth
    let acc = 0
    for (let i = 0; i < 100; i++) acc += stepPtX(META_A4)
    const expected = 100 * onePxPtX
    expect(Math.abs(acc - expected)).toBeLessThan(onePxPtX) // < 1px
  })

  it('1px ステップは元画像 1px 分の pt（縦横とも）', () => {
    expect(stepPtX(META_A4)).toBeCloseTo(META_A4.widthPt / META_A4.pixelWidth, 10)
    expect(stepPtY(META_A4)).toBeCloseTo(META_A4.heightPt / META_A4.pixelHeight, 10)
  })
})

describe('bbox-coords 移動・リサイズ', () => {
  const base: BboxPt = { x: 100, y: 100, w: 50, h: 30 }

  it('移動は w/h 不変で x/y に加算', () => {
    const moved = moveBbox(base, 10, -5)
    expect(moved).toEqual({ x: 110, y: 95, w: 50, h: 30 })
  })

  it('se リサイズは右下隅を動かし左上固定', () => {
    const r = resizeBbox(base, 'se', 20, 10)
    expect(r).toEqual({ x: 100, y: 100, w: 70, h: 40 })
  })

  it('nw リサイズは左上隅を動かし右下固定', () => {
    const r = resizeBbox(base, 'nw', 10, 5)
    expect(r.x).toBeCloseTo(110)
    expect(r.y).toBeCloseTo(105)
    expect(r.w).toBeCloseTo(40)
    expect(r.h).toBeCloseTo(25)
  })

  // C-2 v1.4（案A・§3-2-3）: 固定テキストモードのリサイズは専用関数を新設せず resizeBbox を
  //   全モード共通で流用する。対角 anchor 固定（掴んだ隅だけ動く・スケール係数なし）を 4 隅すべてで担保。
  it('ne リサイズは右上隅を動かし左下固定（対角 anchor）', () => {
    const r = resizeBbox(base, 'ne', 20, 10)
    // 右へ +20（右端 150→170）／上端を下げる +10（上端 100→110・下端 130 固定）。
    expect(r.x).toBeCloseTo(100) // 左端不動
    expect(r.y).toBeCloseTo(110)
    expect(r.w).toBeCloseTo(70)
    expect(r.h).toBeCloseTo(20)
    expect(r.y + r.h).toBeCloseTo(base.y + base.h) // 下端（左下の対角）固定
    expect(r.x).toBeCloseTo(base.x) // 左端（左下の対角）固定
  })

  it('sw リサイズは左下隅を動かし右上固定（対角 anchor）', () => {
    const r = resizeBbox(base, 'sw', -10, 10)
    // 左へ −10（左端 100→90）／下端を下げる +10（下端 130→140・上端 100 固定）。
    expect(r.x).toBeCloseTo(90)
    expect(r.y).toBeCloseTo(100) // 上端不動
    expect(r.w).toBeCloseTo(60)
    expect(r.h).toBeCloseTo(40)
    expect(r.x + r.w).toBeCloseTo(base.x + base.w) // 右端（右上の対角）固定
    expect(r.y).toBeCloseTo(base.y) // 上端（右上の対角）固定
  })

  it('リサイズ最小クランプ: w/h が MIN_BBOX_PT 未満にならない（se で大きく縮める）', () => {
    const r = resizeBbox(base, 'se', -1000, -1000)
    expect(r.w).toBeGreaterThanOrEqual(MIN_BBOX_PT)
    expect(r.h).toBeGreaterThanOrEqual(MIN_BBOX_PT)
  })

  it('リサイズ反転禁止: nw で右下を超えて押しても潰れず最小維持', () => {
    const r = resizeBbox(base, 'nw', 1000, 1000)
    expect(r.w).toBeGreaterThanOrEqual(MIN_BBOX_PT)
    expect(r.h).toBeGreaterThanOrEqual(MIN_BBOX_PT)
    // 右下端は固定（x+w, y+h が元と一致）。
    expect(r.x + r.w).toBeCloseTo(base.x + base.w)
    expect(r.y + r.h).toBeCloseTo(base.y + base.h)
  })

  it('nudgeSize は最小クランプ付きで w/h を増減', () => {
    expect(nudgeSize(base, 5, -5)).toEqual({ x: 100, y: 100, w: 55, h: 25 })
    const clamped = nudgeSize(base, -1000, -1000)
    expect(clamped.w).toBe(MIN_BBOX_PT)
    expect(clamped.h).toBe(MIN_BBOX_PT)
  })
})

// C-2 v1.5 準備（縦横比固定リサイズ・案B 復活）: resizeBboxKeepAspect の純ロジック担保。
//   aspect=w/h を保ち・対角 anchor 不動・スケール係数なし・長辺基準で短辺追従・最小/端クランプ。
describe('resizeBboxKeepAspect（縦横比保持リサイズ・C-2 v1.5）', () => {
  // aspect = 60/30 = 2（横長）。広いページで端クランプは効かない設定。
  const base: BboxPt = { x: 100, y: 100, w: 60, h: 30 }
  const ASPECT = base.w / base.h // 2

  it('se: 幅主導（dW>dH）で高さが比率追従・左上 anchor 不動', () => {
    // se で +40,+10。raw=(w100,h40)。dW=40>dH=10 → w 主軸: w=100, h=100/2=50。
    const r = resizeBboxKeepAspect(base, 'se', 40, 10, ASPECT)
    expect(r.x).toBeCloseTo(100) // 左上固定
    expect(r.y).toBeCloseTo(100)
    expect(r.w).toBeCloseTo(100)
    expect(r.h).toBeCloseTo(50)
    expect(r.w / r.h).toBeCloseTo(ASPECT) // 比率維持
  })

  it('se: 高さ主導（dH>dW）で幅が比率追従', () => {
    // se で +5,+30。raw=(w65,h60)。dW=5<dH=30 → h 主軸: h=60, w=60*2=120。
    const r = resizeBboxKeepAspect(base, 'se', 5, 30, ASPECT)
    expect(r.w).toBeCloseTo(120)
    expect(r.h).toBeCloseTo(60)
    expect(r.w / r.h).toBeCloseTo(ASPECT)
    expect(r.x).toBeCloseTo(100) // 左上 anchor 固定
    expect(r.y).toBeCloseTo(100)
  })

  it('nw: 右下 anchor 不動で比率維持（左上を掴む）', () => {
    // nw で −40,−... 。raw 幅は w=60+40=100（左へ拡張）。w 主導 → w=100,h=50。
    // 右下端（x+w=160, y+h=130）は固定。
    const r = resizeBboxKeepAspect(base, 'nw', -40, -5, ASPECT)
    expect(r.w).toBeCloseTo(100)
    expect(r.h).toBeCloseTo(50)
    expect(r.x + r.w).toBeCloseTo(base.x + base.w) // 右端固定
    expect(r.y + r.h).toBeCloseTo(base.y + base.h) // 下端固定
    expect(r.w / r.h).toBeCloseTo(ASPECT)
  })

  it('ne: 左下 anchor 不動で比率維持（右上を掴む）', () => {
    // ne で +40,−... 。w=100 主導 → h=50。左端(x=100)・下端(y+h=130)が固定。
    const r = resizeBboxKeepAspect(base, 'ne', 40, -5, ASPECT)
    expect(r.w).toBeCloseTo(100)
    expect(r.h).toBeCloseTo(50)
    expect(r.x).toBeCloseTo(base.x) // 左端固定
    expect(r.y + r.h).toBeCloseTo(base.y + base.h) // 下端固定
    expect(r.w / r.h).toBeCloseTo(ASPECT)
  })

  it('bl(sw): 右上 anchor 不動で比率維持（左下を掴む）', () => {
    // sw で −40,+... 。w=100 主導 → h=50。右端(x+w=160)・上端(y=100)が固定。
    const r = resizeBboxKeepAspect(base, 'sw', -40, 5, ASPECT)
    expect(r.w).toBeCloseTo(100)
    expect(r.h).toBeCloseTo(50)
    expect(r.x + r.w).toBeCloseTo(base.x + base.w) // 右端固定
    expect(r.y).toBeCloseTo(base.y) // 上端固定
    expect(r.w / r.h).toBeCloseTo(ASPECT)
  })

  it('最小クランプも比率維持（潰しても aspect が崩れない）', () => {
    const r = resizeBboxKeepAspect(base, 'se', -1000, -1000, ASPECT)
    expect(r.w).toBeGreaterThanOrEqual(MIN_BBOX_PT)
    expect(r.h).toBeGreaterThanOrEqual(MIN_BBOX_PT)
    expect(r.w / r.h).toBeCloseTo(ASPECT) // 下限でも比率維持
  })

  it('ページ端クランプ（meta 指定）も比率維持で収める', () => {
    // 左上原点近くで se を大きく引っ張り、ページ幅を超える → 比率保ったまま収める。
    const small: BboxPt = { x: 0, y: 0, w: 20, h: 10 } // aspect 2
    const meta: PageMeta = {
      page: 1,
      widthPt: 100,
      heightPt: 1000,
      pixelWidth: 100,
      pixelHeight: 1000,
    }
    const r = resizeBboxKeepAspect(small, 'se', 500, 500, 2, meta)
    // 幅は 100 を超えない・比率 2 維持。
    expect(r.x + r.w).toBeLessThanOrEqual(100 + 1e-6)
    expect(r.w / r.h).toBeCloseTo(2)
  })

  it('aspect 不正（0/NaN）は自由リサイズへフォールバック', () => {
    const free = resizeBbox(base, 'se', 20, 10)
    expect(resizeBboxKeepAspect(base, 'se', 20, 10, 0)).toEqual(free)
    expect(resizeBboxKeepAspect(base, 'se', 20, 10, NaN)).toEqual(free)
  })
})

describe('resizeBboxCentered（中心保持リサイズ・C-2 v1.5 大きさボタン）', () => {
  const base: BboxPt = { x: 100, y: 100, w: 60, h: 30 } // 中心 (130,115)

  it('中心を固定したまま w/h を変える（四方拡縮）', () => {
    const r = resizeBboxCentered(base, 100, 50)
    // 中心 (130,115) 不動・新 w/h。
    expect(r.x + r.w / 2).toBeCloseTo(130)
    expect(r.y + r.h / 2).toBeCloseTo(115)
    expect(r.w).toBeCloseTo(100)
    expect(r.h).toBeCloseTo(50)
  })

  it('縮小も中心保持', () => {
    const r = resizeBboxCentered(base, 20, 10)
    expect(r.x + r.w / 2).toBeCloseTo(130)
    expect(r.y + r.h / 2).toBeCloseTo(115)
    expect(r.w).toBeCloseTo(20)
    expect(r.h).toBeCloseTo(10)
  })

  it('ページ端クランプ（meta 指定）は中心固定で比率保持して収める', () => {
    // 中心 (130,115)。中心から右端まで widthPt−130、左まで 130。小さい方 *2 が最大幅。
    const meta: PageMeta = {
      page: 1,
      widthPt: 200,
      heightPt: 200,
      pixelWidth: 200,
      pixelHeight: 200,
    }
    // 中心 (130,115): maxHalfW=min(130,70)=70→maxW=140 / maxHalfH=min(115,85)=85→maxH=170。
    // 目標 w/h=300/150（比率2）。w 制約 140/300=0.467・h 制約 170/150=1.13 → s=0.467。
    const r = resizeBboxCentered(base, 300, 150, meta)
    expect(r.x + r.w / 2).toBeCloseTo(130) // 中心不動
    expect(r.y + r.h / 2).toBeCloseTo(115)
    expect(r.w).toBeLessThanOrEqual(140 + 1e-6)
    expect(r.w / r.h).toBeCloseTo(2) // 比率保持
    // ページ内に収まる。
    expect(r.x).toBeGreaterThanOrEqual(-1e-6)
    expect(r.x + r.w).toBeLessThanOrEqual(200 + 1e-6)
  })

  it('最小サイズ MIN_BBOX_PT を維持', () => {
    const r = resizeBboxCentered(base, 0, 0)
    expect(r.w).toBeGreaterThanOrEqual(MIN_BBOX_PT)
    expect(r.h).toBeGreaterThanOrEqual(MIN_BBOX_PT)
    expect(r.x + r.w / 2).toBeCloseTo(130) // 中心は保持
  })
})

describe('clampResizeToPage（リサイズ専用クランプ・差し戻し-3）', () => {
  it('ページ内に収まる bbox はそのまま', () => {
    const b: BboxPt = { x: 100, y: 100, w: 50, h: 30 }
    expect(clampResizeToPage(b, META_A4)).toEqual(b)
  })

  it('右下リサイズで右端を超えても x は引き戻さず w だけ縮む（綱引き回避）', () => {
    // x=550 のまま w を端まで縮める（x が 550→ widthPt-w に動かない）。
    const b: BboxPt = { x: 550, y: 100, w: 200, h: 30 }
    const r = clampResizeToPage(b, META_A4)
    expect(r.x).toBe(550) // 引き戻されない
    expect(r.x + r.w).toBeCloseTo(META_A4.widthPt) // 右端でクランプ
    expect(r.y).toBe(100)
  })

  it('下端を超えても y は引き戻さず h だけ縮む', () => {
    const b: BboxPt = { x: 100, y: 800, w: 50, h: 200 }
    const r = clampResizeToPage(b, META_A4)
    expect(r.y).toBe(800)
    expect(r.y + r.h).toBeCloseTo(META_A4.heightPt)
  })

  it('左/上にはみ出したら端を 0 に寄せ w/h を縮める（右下端は保持）', () => {
    const b: BboxPt = { x: -20, y: -10, w: 80, h: 50 }
    const r = clampResizeToPage(b, META_A4)
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
    // 右下端（-20+80=60, -10+50=40）は保持。
    expect(r.x + r.w).toBeCloseTo(60)
    expect(r.y + r.h).toBeCloseTo(40)
  })

  it('クランプで潰れても最小 MIN_BBOX_PT を維持', () => {
    // 右端ぎりぎりに極小幅を要求 → 最小 4pt 確保。
    const b: BboxPt = { x: META_A4.widthPt - 1, y: 100, w: 50, h: 30 }
    const r = clampResizeToPage(b, META_A4)
    expect(r.w).toBeGreaterThanOrEqual(MIN_BBOX_PT)
    expect(r.h).toBeGreaterThanOrEqual(MIN_BBOX_PT)
  })
})

describe('bbox-coords 保存丸めと範囲判定', () => {
  it('roundBbox は小数 2 桁に丸める', () => {
    const r = roundBbox({ x: 1.23456, y: 2.001, w: 3.999, h: 4.005 })
    expect(r).toEqual({ x: 1.23, y: 2, w: 4, h: 4.01 })
  })

  it('±4px 回帰: 移動 0 → 丸めても元 bbox とほぼ一致（誤差 < 4px 相当）', () => {
    const onePxPtX = META_A4.widthPt / META_A4.pixelWidth
    const b: BboxPt = { x: 120.37, y: 240.81, w: 88.12, h: 22.46 }
    // 操作せず保存（丸めのみ）。
    const saved = roundBbox(b)
    expect(Math.abs(saved.x - b.x)).toBeLessThan(4 * onePxPtX)
    expect(Math.abs(saved.y - b.y)).toBeLessThan(4 * onePxPtX)
  })

  it('1px×k 移動後の移動量が k×stepPt ± 丸め に収まり ±4px 内', () => {
    const onePxPtX = stepPtX(META_A4)
    const b: BboxPt = { x: 100, y: 100, w: 50, h: 30 }
    const k = 3
    let cur = b
    for (let i = 0; i < k; i++) cur = moveBbox(cur, onePxPtX, 0)
    const saved = roundBbox(cur)
    const moved = saved.x - b.x
    expect(Math.abs(moved - k * onePxPtX)).toBeLessThan(4 * onePxPtX)
  })

  it('範囲判定: ページ内は true、はみ出しは false', () => {
    expect(isBboxWithinPage({ x: 10, y: 10, w: 100, h: 50 }, META_A4)).toBe(true)
    expect(
      isBboxWithinPage({ x: -1, y: 10, w: 100, h: 50 }, META_A4),
    ).toBe(false)
    expect(
      isBboxWithinPage(
        { x: 10, y: 10, w: META_A4.widthPt, h: 50 },
        META_A4,
      ),
    ).toBe(false)
    expect(isBboxWithinPage({ x: 10, y: 10, w: 0, h: 50 }, META_A4)).toBe(false)
  })
})

describe('shrinkOverlaps（重なり軽減・§A2-1）', () => {
  type F = { name: string; bbox: BboxPt & { page: number } }
  const mk = (name: string, y: number, h: number, page = 1): F => ({
    name,
    bbox: { page, x: 100, y, w: 80, h },
  })

  it('縦に重なる隣接 bbox は上側 h を縮め GAP をあける', () => {
    // y=100 h=37.5（下端137.5）が次の y=119.5 と重なる（実機の日時/場所/出席者ケース）。
    const fields = [mk('a', 100, 37.5), mk('b', 119.5, 37.5)]
    const r = shrinkOverlaps(fields)
    const a = r.find((f) => f.name === 'a')!
    // a の h = 次のy(119.5) - 自分のy(100) - GAP(1) = 18.5。
    expect(a.bbox.h).toBeCloseTo(119.5 - 100 - OVERLAP_GAP_PT)
    // a の下端は b の上端より GAP 分だけ上。
    expect(a.bbox.y + a.bbox.h).toBeCloseTo(119.5 - OVERLAP_GAP_PT)
  })

  it('重ならない bbox は不変', () => {
    const fields = [mk('a', 100, 15), mk('b', 200, 15)]
    const r = shrinkOverlaps(fields)
    expect(r.find((f) => f.name === 'a')!.bbox.h).toBe(15)
    expect(r.find((f) => f.name === 'b')!.bbox.h).toBe(15)
  })

  it('縮めても MIN_BBOX_PT 未満にはならない', () => {
    // 次の y が自分の y にほぼ密着 → 縮小後 h が負/極小でも 4pt 維持。
    const fields = [mk('a', 100, 50), mk('b', 101, 50)]
    const r = shrinkOverlaps(fields)
    expect(r.find((f) => f.name === 'a')!.bbox.h).toBe(MIN_BBOX_PT)
  })

  it('入力を破壊せず並び順を保持する', () => {
    const fields = [mk('b', 200, 15), mk('a', 100, 200)]
    const before = JSON.stringify(fields)
    const r = shrinkOverlaps(fields)
    // 入力は不変。
    expect(JSON.stringify(fields)).toBe(before)
    // 出力の並び順は入力どおり（b, a）。
    expect(r.map((f) => f.name)).toEqual(['b', 'a'])
  })

  it('別ページ同士は重なり判定しない', () => {
    const fields = [mk('a', 100, 50, 1), mk('b', 120, 50, 2)]
    const r = shrinkOverlaps(fields)
    // page が違うので a は縮まない。
    expect(r.find((f) => f.name === 'a')!.bbox.h).toBe(50)
  })

  it('x 方向の重ならない横並び（部署｜氏名）は h 不変（差し戻し-A1）', () => {
    // 同じ y、x が重ならない別カラム。横並びなので縦縮小の対象外＝h 不変。
    const fields = [
      { name: 'dept', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
      { name: 'name', bbox: { page: 1, x: 200, y: 100, w: 80, h: 20 } },
    ]
    const r = shrinkOverlaps(fields)
    expect(r.find((f) => f.name === 'dept')!.bbox.h).toBe(20)
    expect(r.find((f) => f.name === 'name')!.bbox.h).toBe(20)
  })

  it('横並びカラムを挟んでも同カラムの縦隣接は正しく縮める（堅実版ペアリング）', () => {
    // 左カラム上(a)・右カラム(c, 横並び)・左カラム下(b)。y 昇順ソートで a→c→b の順になるが、
    // a の縦隣接は x 重なりのある b（c は別カラムでスキップ）。a を b 上端まで縮める。
    const fields = [
      { name: 'a', bbox: { page: 1, x: 100, y: 100, w: 80, h: 50 } }, // 下端150
      { name: 'c', bbox: { page: 1, x: 220, y: 110, w: 80, h: 20 } }, // 右カラム横並び
      { name: 'b', bbox: { page: 1, x: 100, y: 130, w: 80, h: 30 } }, // 同カラム下（a と重なる）
    ]
    const r = shrinkOverlaps(fields)
    // a は b(上端130) まで縮む: h = 130 - 100 - GAP(1) = 29。
    expect(r.find((f) => f.name === 'a')!.bbox.h).toBeCloseTo(130 - 100 - OVERLAP_GAP_PT)
    // c（右カラム横並び）は a/b と x 重ならないので不変。
    expect(r.find((f) => f.name === 'c')!.bbox.h).toBe(20)
    // b（最下段）は下に同カラム相手がいないので不変。
    expect(r.find((f) => f.name === 'b')!.bbox.h).toBe(30)
  })
})

describe('containerWidth 注入時の往復精度（スマホ連動・§A1）', () => {
  // スマホ幅 375px を想定（pixelWidth=1190 より小さい＝強く縮小）。
  const CW = 375

  it('displayWidth は containerWidth で上限される', () => {
    expect(displayWidth(META_A4, CW)).toBe(CW)
    // 省略時は従来（min(pixelWidth,800)）。
    expect(displayWidth(META_A4)).toBe(800)
  })

  it('containerWidth 注入時も pt→表示px→pt 往復が元値に復元（±4px 相当）', () => {
    const onePxPtX = META_A4.widthPt / META_A4.pixelWidth
    const tolX = 4 * onePxPtX
    const samplesX = [0, 12.3, 100.7, 300.0, 595.32]
    for (const xPt of samplesX) {
      const back = dispToPtX(META_A4, ptToDispX(META_A4, xPt, CW), CW)
      expect(Math.abs(back - xPt)).toBeLessThan(tolX)
    }
    const onePxPtY = META_A4.heightPt / META_A4.pixelHeight
    const tolY = 4 * onePxPtY
    const samplesY = [0, 5.5, 200.2, 600.6, 841.92]
    for (const yPt of samplesY) {
      const back = dispToPtY(META_A4, ptToDispY(META_A4, yPt, CW), CW)
      expect(Math.abs(back - yPt)).toBeLessThan(tolY)
    }
  })

  it('1px ステップは containerWidth 非依存（元画像 px 基準で一定）', () => {
    // displayScale は変わるが stepPt は pxToPt のみで containerWidth に依存しない。
    expect(stepPtX(META_A4)).toBeCloseTo(META_A4.widthPt / META_A4.pixelWidth, 10)
    expect(displayScale(META_A4, CW)).not.toBe(displayScale(META_A4, 800))
  })
})

describe('computeNudgePosition（フリップ＋画面内クランプ・§A3改訂-⑦）', () => {
  const VIEWPORT = { w: 1000, h: 800 }
  const WIDGET = { w: 300, h: 180 }
  const M = 8 // margin

  it('下に入るときは枠の下に配置', () => {
    // 枠下端 100+30=130、down=138。138+180=318 <= 800 なので下配置。
    const geom = { viewportLeft: 200, viewportTop: 100, width: 80, height: 30 }
    const pos = computeNudgePosition(geom, VIEWPORT, WIDGET, M)
    expect(pos.top).toBe(100 + 30 + M)
    expect(pos.left).toBe(200)
  })

  it('下に入らないときは上へフリップ（PY2-3: 間隔は WIDGET_FLIP_GAP_PX）', () => {
    // 枠が画面下端近く: top=700 height=60 → down=768, 768+180=948 > 800 → 上へ。
    // PY2-3: 上フリップ間隔は flipGap（既定 WIDGET_FLIP_GAP_PX）。
    // up = 700 - 180 - WIDGET_FLIP_GAP_PX（>= margin なので採用）。
    const geom = { viewportLeft: 200, viewportTop: 700, width: 80, height: 60 }
    const pos = computeNudgePosition(geom, VIEWPORT, WIDGET, M)
    expect(pos.top).toBe(700 - WIDGET.h - WIDGET_FLIP_GAP_PX)
  })

  it('PY2-3: 下配置・左右クランプは従来 margin 据置（flipGap 非適用）', () => {
    // 下配置: margin で配置（flipGap は上フリップ専用）。
    const geom = { viewportLeft: 200, viewportTop: 100, width: 80, height: 30 }
    const pos = computeNudgePosition(geom, VIEWPORT, WIDGET, M)
    expect(pos.top).toBe(100 + 30 + M) // flipGap でなく margin
    expect(pos.left).toBe(200)
    // 右クランプも margin 基準（flipGap 不使用）。
    const geomR = { viewportLeft: 900, viewportTop: 100, width: 80, height: 30 }
    const posR = computeNudgePosition(geomR, VIEWPORT, WIDGET, M)
    expect(posR.left).toBe(VIEWPORT.w - WIDGET.w - M)
  })

  it('PY2-3: flipGap を明示指定すると上フリップ間隔に反映', () => {
    const geom = { viewportLeft: 200, viewportTop: 700, width: 80, height: 60 }
    const pos = computeNudgePosition(geom, VIEWPORT, WIDGET, M, 32)
    expect(pos.top).toBe(700 - WIDGET.h - 32)
  })

  it('WIDGET_FLIP_GAP_PX は WIDGET_MARGIN_PX より広い（青枠被り軽減）', () => {
    expect(WIDGET_FLIP_GAP_PX).toBeGreaterThan(WIDGET_MARGIN_PX)
  })

  it('上下とも入らないときは画面内へクランプ', () => {
    // 縦に長いビューポート不足を模す: viewport.h を小さく、枠も上寄り。
    const smallVp = { w: 1000, h: 200 }
    // top=150 height=40 → down=198, 198+180=378 > 200 → 上へ。up=150-180-8=-38 < 8 →
    // clamp(8, -38, 200-180-8=12) = 8。
    const geom = { viewportLeft: 200, viewportTop: 150, width: 80, height: 40 }
    const pos = computeNudgePosition(geom, smallVp, WIDGET, M)
    expect(pos.top).toBeGreaterThanOrEqual(M)
    expect(pos.top).toBeLessThanOrEqual(smallVp.h - WIDGET.h - M)
  })

  it('左が画面右端を超えるときは左クランプ', () => {
    // viewportLeft=900, widget.w=300 → 900 > 1000-300-8=692 → left=692。
    const geom = { viewportLeft: 900, viewportTop: 100, width: 80, height: 30 }
    const pos = computeNudgePosition(geom, VIEWPORT, WIDGET, M)
    expect(pos.left).toBe(VIEWPORT.w - WIDGET.w - M)
  })

  it('左が画面左端より外のときは左端マージンにクランプ', () => {
    const geom = { viewportLeft: -50, viewportTop: 100, width: 80, height: 30 }
    const pos = computeNudgePosition(geom, VIEWPORT, WIDGET, M)
    expect(pos.left).toBe(M)
  })
})

describe('PY1: clampZoom（③ズーム境界・PY1-1）', () => {
  it('範囲内はそのまま', () => {
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(2.5)).toBe(2.5)
  })
  it('下限 ZOOM_MIN・上限 ZOOM_MAX でクランプ', () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN)
    expect(clampZoom(-5)).toBe(ZOOM_MIN)
    expect(clampZoom(100)).toBe(ZOOM_MAX)
  })
  it('ZOOM_STEP は正の刻み', () => {
    expect(ZOOM_STEP).toBeGreaterThan(0)
    expect(ZOOM_MIN).toBeLessThan(ZOOM_MAX)
  })
})

describe('PY1: displayWidth FitOptions（②縦フィット・③ズーム・PY1-0/1）', () => {
  it('FitOptions 省略・空は従来挙動（min(pixelWidth,800)）', () => {
    expect(displayWidth(META_A4, {})).toBe(800)
    expect(displayWidth(META_A4)).toBe(800)
    // number 引数の後方互換（従来 containerWidth）。
    expect(displayWidth(META_A4, 375)).toBe(375)
    expect(displayWidth(META_A4, { containerWidth: 375 })).toBe(375)
  })

  it('②heightCap: 縦長 A4 は viewportHeight で縦フィット（幅が縦制約でキャップ）', () => {
    // viewportHeight=400 → heightCap = 400 * (1190/1684) ≒ 282.7。
    // widthCap=800・pixelWidth=1190 より小さいので heightCap が支配的。
    const vh = 400
    const expected = vh * (META_A4.pixelWidth / META_A4.pixelHeight)
    expect(displayWidth(META_A4, { viewportHeight: vh })).toBeCloseTo(expected, 6)
    // 縦フィット時の表示高 <= viewportHeight。
    expect(displayHeight(META_A4, { viewportHeight: vh })).toBeLessThanOrEqual(vh + 1e-6)
  })

  it('②横長ページは viewportHeight 指定でも heightCap が効かず従来幅（横支配）', () => {
    // 横長 META（widthPt>heightPt 相当）: pixelWidth=600,pixelHeight=300。
    const wide: PageMeta = { page: 1, widthPt: 600, heightPt: 300, pixelWidth: 600, pixelHeight: 300 }
    // viewportHeight=400 → heightCap=400*(600/300)=800 ≥ pixelWidth(600) → 効かず pixelWidth。
    expect(displayWidth(wide, { viewportHeight: 400 })).toBe(600)
  })

  it('③ズーム: fitW × zoom（zoom=1 で全体フィット原点・拡大は元px超えOK）', () => {
    const base = displayWidth(META_A4, { containerWidth: 375 }) // 375
    expect(displayWidth(META_A4, { containerWidth: 375, zoom: 2 })).toBeCloseTo(base * 2, 6)
    // 拡大で元画像px(1190)を超えてOK（上限クランプ無し・PY1-1確定）。
    const big = displayWidth(META_A4, { zoom: ZOOM_MAX }) // 800 * 4 = 3200
    expect(big).toBeCloseTo(800 * ZOOM_MAX, 6)
    expect(big).toBeGreaterThan(META_A4.pixelWidth)
  })

  it('③zoom は clampZoom 経由（範囲外は丸められる）', () => {
    expect(displayWidth(META_A4, { zoom: 100 })).toBeCloseTo(800 * ZOOM_MAX, 6)
    expect(displayWidth(META_A4, { zoom: 0 })).toBeCloseTo(800 * ZOOM_MIN, 6)
  })
})

describe('PY1-0: 往復一致・stepPt 不変（任意 zoom/viewportHeight・最重要死守）', () => {
  const samplesX = [0, 12.3, 100.7, 300.0, 595.32]
  const samplesY = [0, 5.5, 200.2, 600.6, 841.92]
  const optsList = [
    { zoom: 1 },
    { zoom: 0.5 },
    { zoom: 3 },
    { viewportHeight: 400 },
    { viewportHeight: 400, zoom: 2 },
    { containerWidth: 375, viewportHeight: 500, zoom: 1.7 },
  ]

  it('任意 zoom/viewportHeight で dispToPt∘ptToDisp が恒等（±4px 相当）', () => {
    const tolX = 4 * (META_A4.widthPt / META_A4.pixelWidth)
    const tolY = 4 * (META_A4.heightPt / META_A4.pixelHeight)
    for (const opts of optsList) {
      for (const xPt of samplesX) {
        const back = dispToPtX(META_A4, ptToDispX(META_A4, xPt, opts), opts)
        expect(Math.abs(back - xPt)).toBeLessThan(tolX)
      }
      for (const yPt of samplesY) {
        const back = dispToPtY(META_A4, ptToDispY(META_A4, yPt, opts), opts)
        expect(Math.abs(back - yPt)).toBeLessThan(tolY)
      }
    }
  })

  it('stepPtX/Y は zoom/viewportHeight に非依存（元画像px基準で一定）', () => {
    const ref = { x: stepPtX(META_A4), y: stepPtY(META_A4) }
    // stepPt は meta のみの関数。zoom/viewportHeight を変えても同値（関数が opts を取らない）。
    expect(stepPtX(META_A4)).toBe(ref.x)
    expect(stepPtY(META_A4)).toBe(ref.y)
    expect(ref.x).toBeCloseTo(META_A4.widthPt / META_A4.pixelWidth, 10)
    expect(ref.y).toBeCloseTo(META_A4.heightPt / META_A4.pixelHeight, 10)
    // displayScale は opts で変わる（表示は可変）＝係数だけ不変を担保。
    expect(displayScale(META_A4, { zoom: 2 })).not.toBe(displayScale(META_A4, { zoom: 1 }))
  })
})

describe('PY1: スマホ非破壊（containerWidth 小で従来値・heightCap/zoom 影響なし）', () => {
  const CW = 375
  it('containerWidth が支配的なら viewportHeight 追加で値が変わらない', () => {
    const base = displayWidth(META_A4, { containerWidth: CW }) // 375（横支配）
    expect(displayWidth(META_A4, { containerWidth: CW, viewportHeight: 5000 })).toBe(base)
    // viewportHeight が極端に小さいと heightCap が効くが、通常スマホ縦は十分大きい想定。
  })
  it('zoom 既定 1.0 は乗算無影響（従来値）', () => {
    expect(displayWidth(META_A4, { containerWidth: CW, zoom: 1 })).toBe(
      displayWidth(META_A4, { containerWidth: CW }),
    )
  })
})

describe('PY2-1: centerHorizontally（⑤水平センタリング）', () => {
  it('左右余白が均等（x = (W − w)/2・y/w/h 不変）', () => {
    const b: BboxPt = { x: 10, y: 100, w: 200, h: 30 }
    const W = 595.32
    const r = centerHorizontally(b, W)
    expect(r.x).toBeCloseTo((W - b.w) / 2, 10)
    expect(r.y).toBe(b.y)
    expect(r.w).toBe(b.w)
    expect(r.h).toBe(b.h)
    // 左余白 == 右余白。
    const leftMargin = r.x
    const rightMargin = W - (r.x + r.w)
    expect(leftMargin).toBeCloseTo(rightMargin, 10)
  })
  it('w がページ幅を超える異常時は x=0 にクランプ（負 x 防止）', () => {
    const b: BboxPt = { x: 50, y: 100, w: 700, h: 30 }
    const r = centerHorizontally(b, 595.32)
    expect(r.x).toBe(0)
    expect(r.w).toBe(700)
  })
})

describe('splitVertical（縦割り 2 分割・グループB §3-2）', () => {
  it('中央で左右 2 枠に割る（左=元 x・右=x+w/2・各 w=w/2・y/h 不変）', () => {
    const b: BboxPt = { x: 100, y: 200, w: 300, h: 40 }
    const [left, right] = splitVertical(b)
    expect(left).toEqual({ x: 100, y: 200, w: 150, h: 40 })
    expect(right).toEqual({ x: 250, y: 200, w: 150, h: 40 })
  })

  it('合算幅が元幅と一致（隙間なし隣接）', () => {
    const b: BboxPt = { x: 10, y: 0, w: 81, h: 24 }
    const [left, right] = splitVertical(b)
    expect(left.w + right.w).toBeCloseTo(b.w, 10)
    // 左の右端 == 右の左端（隣接）。
    expect(left.x + left.w).toBeCloseTo(right.x, 10)
  })

  it('page 付き bbox は page を両枠に引き継ぐ', () => {
    const b = { page: 3, x: 0, y: 0, w: 100, h: 20 }
    const [left, right] = splitVertical(b)
    expect(left.page).toBe(3)
    expect(right.page).toBe(3)
  })

  it('入力を破壊しない（純関数）', () => {
    const b: BboxPt = { x: 100, y: 200, w: 300, h: 40 }
    splitVertical(b)
    expect(b).toEqual({ x: 100, y: 200, w: 300, h: 40 })
  })

  it('新規枠の定型サイズ定数', () => {
    expect(NEW_FIELD_W_PT).toBe(200)
    expect(NEW_FIELD_H_PT).toBe(24)
  })
})

describe('centeredNewBbox（枠を追加・中央定型枠生成・グループB §2-2）', () => {
  it('定型サイズでページ中央に置く（x=(W-w)/2, y=(H-h)/2・page 引継ぎ）', () => {
    const b = centeredNewBbox(META_SMALL) // 300x400
    expect(b.w).toBe(NEW_FIELD_W_PT)
    expect(b.h).toBe(NEW_FIELD_H_PT)
    expect(b.x).toBeCloseTo((300 - 200) / 2, 10)
    expect(b.y).toBeCloseTo((400 - 24) / 2, 10)
    expect(b.page).toBe(1)
  })

  it('結果は isBboxWithinPage を満たす（クランプ後も範囲内）', () => {
    expect(isBboxWithinPage(centeredNewBbox(META_A4), META_A4)).toBe(true)
    expect(isBboxWithinPage(centeredNewBbox(META_SMALL), META_SMALL)).toBe(true)
  })

  it('ページが定型枠より小さい異常時も x/y が負にならずページ幅にクランプ', () => {
    const tiny: PageMeta = {
      page: 2,
      widthPt: 100,
      heightPt: 10,
      pixelWidth: 200,
      pixelHeight: 20,
    }
    const b = centeredNewBbox(tiny)
    expect(b.x).toBe(0)
    expect(b.y).toBe(0)
    expect(b.w).toBe(100)
    expect(b.h).toBe(10)
    expect(b.page).toBe(2)
    expect(isBboxWithinPage(b, tiny)).toBe(true)
  })
})

// 実機FB: 最下部の枠を一回クリックしただけで縦分割が暴発するバグの再発防止。
// 原因＝選択でウィジェットが出現/上フリップし、pointerup 直後の合成 click が
// クリック地点直上に来た「縦に2分割」ボタンを直撃すること。
// isWidgetEmergenceClick が「出現/再配置直後の誤爆 click」だけを true にし、
// 破壊的ボタン側がそれを無視することで防ぐ。正当操作（時間を置いた意図クリック）は false。
describe('isWidgetEmergenceClick（破壊的ボタンの誤爆クリックガード）', () => {
  it('出現直後（合成 click 相当・ガード時間未満）は誤爆とみなす＝true', () => {
    const armedAt = 1_000_000
    // pointerup→click は通常 < 200ms。ガード時間未満なので弾く。
    expect(isWidgetEmergenceClick(armedAt + 50, armedAt)).toBe(true)
    expect(isWidgetEmergenceClick(armedAt + (CLICK_GUARD_MS - 1), armedAt)).toBe(
      true,
    )
  })

  it('ガード時間ちょうど/経過後の意図クリックは通す＝false', () => {
    const armedAt = 1_000_000
    // 境界（= guardMs）は通す。人の意図クリックは選択から 300ms 以上かかる前提。
    expect(isWidgetEmergenceClick(armedAt + CLICK_GUARD_MS, armedAt)).toBe(false)
    expect(isWidgetEmergenceClick(armedAt + 2000, armedAt)).toBe(false)
  })

  it('未武装（armedAt<=0）は誤爆扱いしない＝false', () => {
    expect(isWidgetEmergenceClick(1_000_000, 0)).toBe(false)
    expect(isWidgetEmergenceClick(1_000_000, -5)).toBe(false)
  })

  it('guardMs を明示指定すれば閾値を変えられる', () => {
    const armedAt = 1_000_000
    expect(isWidgetEmergenceClick(armedAt + 150, armedAt, 100)).toBe(false)
    expect(isWidgetEmergenceClick(armedAt + 80, armedAt, 100)).toBe(true)
  })
})
