/**
 * 段階2-D12（ユーザー実機フィードバック「2 つ目以降の bbox 文字が追従しない」真因解消・案 D 案）unit test
 *
 * ユーザー実機フィードバック:
 *   - D11 改善なし
 *   - 「1 つ目の bbox は追従するけど、2 つ目以降が追従しなくなる」
 *   - PC ファンも鳴る
 *
 * 真因 1（最致命）:
 *   案 D `whiteoutRawImageUrl={selectedOnlyBgUrl ?? rawBgUrl}` が selected 切替で差し替わり、
 *   bbox-pane.tsx の rawImg ロード useEffect が setRawImg(null) → 新画像 fetch/decode 中は
 *   合成 useEffect が `if (!rawImg) return` で描画停止 → ブランクアウト。
 *
 * 推し対策（案 D 案）:
 *   drag 中だけ案 D OFF（whiteoutRawImageUrl を rawBgUrl 固定）にする。
 *
 * テスト対象:
 *   `resolveWhiteoutRawImageUrl(isDragging, rawBgUrl, selectedOnlyBgUrl)` 純関数。
 *
 * 厳守:
 *   - field-override.ts / required-bbox-height.ts / fitting.ts / uniform-size.ts は不変
 *   - bbox-pane.tsx の合成順 / templates 編集モード挙動は完全不変
 *   - D11 親 RAF 間引きロジックは据置
 */
import { describe, it, expect } from 'vitest'
import { resolveWhiteoutRawImageUrl } from '@/app/(dashboard)/minutes/[id]/adjust/adjust-view-helpers'

describe('resolveWhiteoutRawImageUrl（D12 案 D 案）', () => {
  describe('isDragging=true（drag 中・案 D OFF）', () => {
    it('rawBgUrl 固定を返す（selectedOnlyBgUrl があっても無視）', () => {
      expect(
        resolveWhiteoutRawImageUrl(true, 'https://raw.png', 'https://only.png'),
      ).toBe('https://raw.png')
    })

    it('selectedOnlyBgUrl=null でも rawBgUrl を返す', () => {
      expect(resolveWhiteoutRawImageUrl(true, 'https://raw.png', null)).toBe(
        'https://raw.png',
      )
    })

    it('rawBgUrl=null なら null を返す（背景未取得時のフォールバック）', () => {
      expect(resolveWhiteoutRawImageUrl(true, null, 'https://only.png')).toBeNull()
      expect(resolveWhiteoutRawImageUrl(true, null, null)).toBeNull()
    })
  })

  describe('isDragging=false（drag 終了 / 通常時・案 D 通常経路）', () => {
    it('selectedOnlyBgUrl があればそちらを優先（負荷軽減効果を保つ）', () => {
      expect(
        resolveWhiteoutRawImageUrl(false, 'https://raw.png', 'https://only.png'),
      ).toBe('https://only.png')
    })

    it('selectedOnlyBgUrl=null なら rawBgUrl にフォールバック', () => {
      expect(resolveWhiteoutRawImageUrl(false, 'https://raw.png', null)).toBe(
        'https://raw.png',
      )
    })

    it('rawBgUrl=null かつ selectedOnlyBgUrl があれば selectedOnlyBgUrl を返す', () => {
      expect(resolveWhiteoutRawImageUrl(false, null, 'https://only.png')).toBe(
        'https://only.png',
      )
    })

    it('両方 null なら null を返す', () => {
      expect(resolveWhiteoutRawImageUrl(false, null, null)).toBeNull()
    })
  })

  describe('drag ライフサイクル: 1 つ目から 2 つ目への切替シミュレーション', () => {
    it('selected=field1 → drag 開始 → selected=field2 でも whiteoutRawImageUrl 不変', () => {
      // 初期: field1 selected, selectedOnlyBgUrl=only1
      const url1 = resolveWhiteoutRawImageUrl(
        false,
        'https://raw.png',
        'https://only-1.png',
      )
      expect(url1).toBe('https://only-1.png')

      // drag 開始: isDragging=true → rawBgUrl 固定
      const url2 = resolveWhiteoutRawImageUrl(
        true,
        'https://raw.png',
        'https://only-1.png',
      )
      expect(url2).toBe('https://raw.png')

      // drag 中に selected=field2 に切替（selectedOnlyBgUrl が変わっても）→ 不変
      const url3 = resolveWhiteoutRawImageUrl(
        true,
        'https://raw.png',
        'https://only-2.png',
      )
      expect(url3).toBe('https://raw.png')

      // drag 終了: 案 D 復帰
      const url4 = resolveWhiteoutRawImageUrl(
        false,
        'https://raw.png',
        'https://only-2.png',
      )
      expect(url4).toBe('https://only-2.png')
    })
  })
})
