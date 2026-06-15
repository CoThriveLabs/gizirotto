/**
 * 二重描画退行の構造修正（shouldComposeFieldClientSide）unit test
 *
 * 症状: bbox を1個ドラッグ移動すると、動かしていない他 field のテキストまで二重に
 *       描画される（背景PNG(DB位置) + client(override位置) で重なる）。
 *
 * 真因:
 * A = 背景PNG に焼かれる集合 = 全field − {selected}
 * B = client 合成 field 集合（shouldComposeFieldClientSide が true を返す集合）
 * compositeFieldValuesOnCanvas は fillText 重ね描き（背景ピクセルを消さない）。
 * ∴ A∩B≠∅ の field が二重描画される。
 * 旧 hasOverride 分岐は、initialOverrides=DBコミット値で初期化されるため
 * 過去セッションで保存済みの field が mount 時点から hasOverride=true → B に入り、
 * 同時に A にも居て A∩B≠∅ → 一斉二重描画。
 *
 * 修正:
 * 不変条件 A∩B=∅ を構造保証する。
 *   1. shouldComposeFieldClientSide の hasOverride 分岐を削除（引数からも除去）。
 *   2. useDebouncedSelectedBackground に渡す selected を hasAnyOverride ? null : selected に。
 *      override が1つでもあれば selectedOnlyBgUrl=null → useSelectedOnly=false →
 *      全 field を client 合成（B=全field・A=rawBgUrl(空集合)）→ A∩B=∅。
 *   3. override 皆無時のみ selectedOnlyBgUrl 生成 → B={selected}・A=全field−{selected}
 *      → A∩B=∅。
 *
 * 対象:
 *   shouldComposeFieldClientSide({ fieldName, selected, selectedOnlyBgUrl, isDragging })
 *   - hasOverride は撤廃。isDragging 判定は維持。
 *
 * 不変: 既存 resolveWhiteoutRawImageUrl の挙動は不変。
 */
import { describe, it, expect } from 'vitest'
import { shouldComposeFieldClientSide } from '@/app/(dashboard)/minutes/[id]/adjust/AdjustView'

/**
 * テストヘルパ: AdjustView 側の hasAnyOverride 経路を再現する。
 * hasAnyOverride=true なら呼出側が selected=null を渡し selectedOnlyBgUrl は生成されない（null）。
 * これを純関数の入力に反映して「呼出側 + 純関数」の合成挙動を検証する。
 */
function composedSelectedOnlyBgUrl(args: {
  rawSelectedOnlyBgUrl: string | null
  hasAnyOverride: boolean
}): string | null {
  // hasAnyOverride 時はフックに selected=null を渡すため bgUrl は null にリセットされる。
  return args.hasAnyOverride ? null : args.rawSelectedOnlyBgUrl
}

describe('shouldComposeFieldClientSide', () => {
  describe('selectedOnlyBgUrl=null: 全 field を常に client 合成', () => {
    it('selected=null でも include（従来フル合成）', () => {
      expect(
        shouldComposeFieldClientSide({
          fieldName: 'a',
          selected: null,
          selectedOnlyBgUrl: null,
          isDragging: false,
        }),
      ).toBe(true)
    })

    it('selected != field でも include（背景 PNG が無いので焼き込めない）', () => {
      expect(
        shouldComposeFieldClientSide({
          fieldName: 'a',
          selected: 'b',
          selectedOnlyBgUrl: null,
          isDragging: false,
        }),
      ).toBe(true)
    })
  })

  describe('selectedOnlyBgUrl 有効・通常編集（isDragging=false・override 皆無）: selected 縮退', () => {
    it('selected field は include', () => {
      expect(
        shouldComposeFieldClientSide({
          fieldName: 'a',
          selected: 'a',
          selectedOnlyBgUrl: 'https://only.png',
          isDragging: false,
        }),
      ).toBe(true)
    })

    it('非 selected は除外（背景 PNG 任せ＝従来最適化・軽量パス）', () => {
      expect(
        shouldComposeFieldClientSide({
          fieldName: 'b',
          selected: 'a',
          selectedOnlyBgUrl: 'https://only.png',
          isDragging: false,
        }),
      ).toBe(false)
    })
  })

  describe('ドラッグ中（isDragging=true）は selectedOnly を OFF → 全 field を client 合成', () => {
    it('非 selected でも include（前に動かした field をスナップに焼く土台）', () => {
      expect(
        shouldComposeFieldClientSide({
          fieldName: 'b',
          selected: 'a',
          selectedOnlyBgUrl: 'https://only.png',
          isDragging: true,
        }),
      ).toBe(true)
    })

    it('selected（現在ドラッグ中）field も当然 include', () => {
      expect(
        shouldComposeFieldClientSide({
          fieldName: 'current',
          selected: 'current',
          selectedOnlyBgUrl: 'https://only.png',
          isDragging: true,
        }),
      ).toBe(true)
    })
  })

  describe('hasOverride 分岐を撤廃（二重描画の根本原因を除去）', () => {
    // 旧実装は「override 付き field を常に client 合成」したが、selectedOnlyBgUrl が
    // 生きている（!=null）状況下では A(=全field−{selected}) にも居て A∩B≠∅ → 二重描画。
    // hasOverride 引数を消したので、selectedOnlyBgUrl が生きている限り
    // 非 selected は必ず除外される（B から外れる）。
    it('selectedOnlyBgUrl 生存下では非 selected は override の有無に関係なく除外（A∩B=∅）', () => {
      // 旧コードでは hasOverride=true で include されて二重描画していたケース。
      expect(
        shouldComposeFieldClientSide({
          fieldName: 'b',
          selected: 'a',
          selectedOnlyBgUrl: 'https://only.png',
          isDragging: false,
        }),
      ).toBe(false)
    })
  })

  // A∩B=∅ の構造保証を「呼出側 hasAnyOverride 経路 + 純関数」で検証
  describe('A∩B=∅ 両ケース検証（不変条件）', () => {
    const fields = ['name', 'date', 'place', 'note']

    /** A = 背景PNG に焼かれる集合（selectedOnlyBgUrl 生存時のみ存在 = 全field − {selected}）。 */
    function bgBakedSet(selectedOnlyBgUrl: string | null, selected: string | null): Set<string> {
      if (selectedOnlyBgUrl === null) return new Set() // rawBgUrl はテキスト0 = 空集合
      return new Set(fields.filter((f) => f !== selected))
    }

    /** B = client 合成集合（shouldComposeFieldClientSide が true を返す集合）。 */
    function clientSet(selectedOnlyBgUrl: string | null, selected: string | null, isDragging: boolean): Set<string> {
      return new Set(
        fields.filter((f) =>
          shouldComposeFieldClientSide({
            fieldName: f,
            selected,
            selectedOnlyBgUrl,
            isDragging,
          }),
        ),
      )
    }

    function intersect(a: Set<string>, b: Set<string>): string[] {
      return [...a].filter((x) => b.has(x))
    }

    it('ケース1: override あり（過去保存済み or 1個でも移動）→ 全 field client・背景テキスト0 → A∩B=∅', () => {
      const selected = 'name'
      // hasAnyOverride=true なので呼出側が selectedOnlyBgUrl を null にする。
      const selectedOnlyBgUrl = composedSelectedOnlyBgUrl({
        rawSelectedOnlyBgUrl: 'https://only.png',
        hasAnyOverride: true,
      })
      expect(selectedOnlyBgUrl).toBe(null)

      // 非ドラッグ時
      const a1 = bgBakedSet(selectedOnlyBgUrl, selected)
      const b1 = clientSet(selectedOnlyBgUrl, selected, false)
      expect([...b1].sort()).toEqual([...fields].sort()) // B = 全 field
      expect([...a1]).toEqual([]) // A = 空集合（rawBgUrl）
      expect(intersect(a1, b1)).toEqual([]) // A∩B=∅ → 二重描画なし

      // ドラッグ中も同様
      const a2 = bgBakedSet(selectedOnlyBgUrl, selected)
      const b2 = clientSet(selectedOnlyBgUrl, selected, true)
      expect(intersect(a2, b2)).toEqual([])
    })

    it('ケース2: override 皆無（一度も調整していない新規）→ 案 D（selected のみ client）→ A∩B=∅', () => {
      const selected = 'name'
      const selectedOnlyBgUrl = composedSelectedOnlyBgUrl({
        rawSelectedOnlyBgUrl: 'https://only.png',
        hasAnyOverride: false,
      })
      expect(selectedOnlyBgUrl).toBe('https://only.png')

      const a = bgBakedSet(selectedOnlyBgUrl, selected) // 全field − {name}
      const b = clientSet(selectedOnlyBgUrl, selected, false) // {name}
      expect([...b]).toEqual(['name']) // B = {selected}
      expect([...a].sort()).toEqual(['date', 'note', 'place']) // A = 全field − {selected}
      expect(intersect(a, b)).toEqual([]) // A∩B=∅
    })

    it('ケース2-drag: override 皆無で drag 開始（isDragging=true）→ 全 field client → A∩B=∅', () => {
      // drag 開始すると move field が override を持つため、本来は hasAnyOverride=true へ遷移するが、
      // 純関数レベルでは isDragging=true で useSelectedOnly=false → 全 field client になる。
      const selected = 'name'
      // drag 中も hasAnyOverride=true 相当 → selectedOnlyBgUrl=null
      const selectedOnlyBgUrl = composedSelectedOnlyBgUrl({
        rawSelectedOnlyBgUrl: 'https://only.png',
        hasAnyOverride: true,
      })
      const a = bgBakedSet(selectedOnlyBgUrl, selected)
      const b = clientSet(selectedOnlyBgUrl, selected, true)
      expect([...b].sort()).toEqual([...fields].sort())
      expect(intersect(a, b)).toEqual([])
    })
  })

  describe('退行根絶シナリオ: 過去保存済み議事録を開いて1個ドラッグ', () => {
    // 氏名・場所・日付などが過去セッションで override 済み（DB コミット値）。
    // 1個ドラッグしても他 field が二重描画されないことを A∩B=∅ で担保。
    const fields = ['name', 'date', 'place']

    it('過去 override 済み議事録: selectedOnlyBgUrl=null（hasAnyOverride 経路）→ 二重描画なし', () => {
      const selected = 'place' // place をドラッグ
      const selectedOnlyBgUrl = composedSelectedOnlyBgUrl({
        rawSelectedOnlyBgUrl: 'https://only.png',
        hasAnyOverride: true, // 開いた時点で override あり
      })
      expect(selectedOnlyBgUrl).toBe(null)

      // 全 field が client 合成され、背景にはテキストが焼かれない（A=空）。
      for (const f of fields) {
        expect(
          shouldComposeFieldClientSide({
            fieldName: f,
            selected,
            selectedOnlyBgUrl,
            isDragging: true,
          }),
        ).toBe(true)
      }
    })

    it('連続複数ドラッグ後の drop（isDragging=false・override 多数）も全 field client → 古い位置残りなし', () => {
      const selected = 'place'
      const selectedOnlyBgUrl = composedSelectedOnlyBgUrl({
        rawSelectedOnlyBgUrl: 'https://only.png',
        hasAnyOverride: true,
      })
      // drop 後（isDragging=false）でも selectedOnlyBgUrl=null のため全 field を
      // override 位置で client 合成 → 元位置残りなし。
      for (const f of fields) {
        expect(
          shouldComposeFieldClientSide({
            fieldName: f,
            selected,
            selectedOnlyBgUrl,
            isDragging: false,
          }),
        ).toBe(true)
      }
    })
  })
})
