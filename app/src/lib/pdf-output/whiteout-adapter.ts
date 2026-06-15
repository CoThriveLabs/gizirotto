/**
 * WhiteoutBox ⇔ EditorField アダプタ。
 *
 * 白塗り（WhiteoutBox）と bbox-pane が扱う EditorField を相互変換する純関数。
 * 両者とも座標系は「左上原点・pt」で同一のため、座標は**無変換の詰め替えのみ**
 * （変換を挟まない＝ズレ温床ゼロ＝個人情報死守の §9 と相性が良い）。
 *
 * WhiteoutBox 固有の属性（source / estimatedBgColor / dismissed）は EditorField に
 * 乗らないので side table（Map）で保持し、保存（fieldsToWhiteoutBoxes）時に再合流する。
 *
 * 命名: 白塗りには項目名(label)が無いので合成 name `wo_N`（記入欄の field_N と非衝突）を
 * index ベースで採番し、label は空文字（UI は命名パネルを出さない・§4-3）。
 *
 * 🚨 個人情報死守（§9）:
 *   - dismissed（却下）な auto候補は焼き込み対象外。保存時 fieldsToWhiteoutBoxes は
 *     dismissed を除外して WhiteoutBox[] を返す（既存 whiteout-modal の handleApply と同一挙動）。
 *   - 30%透過は編集UIの見た目だけ。本アダプタは座標・色を変えず、実焼き込み(applyWhiteout)は
 *     estimatedBgColor の不透明白で完全被覆する。
 */
import type { BboxPt } from './bbox-coords'
import type {
  WhiteoutBox,
  WhiteoutSource,
  RgbColor,
} from '@/lib/parsers/pdf/whiteout-pipeline'

/** bbox-pane が扱う編集用 field（bbox-pane.tsx の EditorField と構造一致）。 */
export interface EditorField {
  name: string
  label: string
  bbox: BboxPt & { page: number }
}

/** WhiteoutBox 固有属性の side table 値（EditorField に乗らない属性）。 */
export interface WhiteoutMeta {
  source: WhiteoutSource
  estimatedBgColor: RgbColor
  /** 却下フラグ。true なら焼き込み対象外（保存時に除外）。 */
  dismissed?: boolean
}

/**
 * 取り込み入力型。永続化済 whiteout_boxes は WhiteoutBox[]（dismissed 無し）だが、
 * 編集セッションを跨いで dismissed を含むデータも安全に取り込めるよう dismissed を任意で許容する
 * （WhiteoutBox 本体型は段階1のまま不変＝DB スキーマ/焼き込み契約を汚さない）。
 */
export type WhiteoutBoxInput = WhiteoutBox & { dismissed?: boolean }

/** 合成 name の接頭辞（記入欄 field_N と衝突しない）。 */
const WHITEOUT_NAME_PREFIX = 'wo_'

/** index（0始まり）から合成 name `wo_N`（N は 1 始まり）を作る。 */
export function whiteoutFieldName(index: number): string {
  return `${WHITEOUT_NAME_PREFIX}${index + 1}`
}

/**
 * WhiteoutBox[] → EditorField[]（bbox-pane へ渡す形）＋ side table（meta）。
 *
 * - 座標は無変換（左上原点pt のまま EditorField.bbox へ詰め替え）。
 * - name は index ベースで `wo_1, wo_2, ...` を採番（順序安定）。
 * - label は空文字（白塗りに項目名概念なし・§4-3）。
 * - source / estimatedBgColor / dismissed は meta(Map) に退避し、保存時に再合流する。
 */
export function whiteoutBoxesToFields(boxes: WhiteoutBoxInput[]): {
  fields: EditorField[]
  meta: Map<string, WhiteoutMeta>
} {
  const fields: EditorField[] = []
  const meta = new Map<string, WhiteoutMeta>()
  boxes.forEach((box, i) => {
    const name = whiteoutFieldName(i)
    fields.push({
      name,
      label: '',
      bbox: {
        x: box.bbox.x,
        y: box.bbox.y,
        w: box.bbox.w,
        h: box.bbox.h,
        page: box.page,
      },
    })
    meta.set(name, {
      source: box.source,
      estimatedBgColor: box.estimatedBgColor,
      // 段階1の whiteout_boxes には dismissed は保存されていない（採用済みのみ永続）。
      // 取り込み時点では undefined（編集セッション内で却下トグルすると true になる）。
      dismissed: box.dismissed,
    })
  })
  return { fields, meta }
}

/**
 * EditorField[]（編集結果）→ WhiteoutBox[]（保存・焼き込み用）。
 *
 * - 座標は無変換（EditorField.bbox → WhiteoutBox.bbox）。
 * - source / estimatedBgColor は meta から復元（meta 欠落時は manual / 白で安全側に補完）。
 * - 🚨 dismissed（却下）な field は WhiteoutBox に含めない（焼き込み対象外・§2-2 / §9）。
 *   これにより applyWhiteout には「採用された白塗りのみ」が渡り、却下分は出力に塗られない。
 *
 * meta に dismissed=true で残る field を「保存対象に dismissed として残す」必要は無い:
 * 段階1から whiteout_boxes は採用済みのみ永続のため、却下分は単に落とせばよい。
 */
export function fieldsToWhiteoutBoxes(
  fields: EditorField[],
  meta: Map<string, WhiteoutMeta>,
): WhiteoutBox[] {
  const boxes: WhiteoutBox[] = []
  for (const f of fields) {
    const m = meta.get(f.name)
    // 却下分は焼き込み対象外（保存しない＝出力に残さない・個人情報死守）。
    if (m?.dismissed) continue
    boxes.push({
      page: f.bbox.page,
      bbox: { x: f.bbox.x, y: f.bbox.y, w: f.bbox.w, h: f.bbox.h },
      // meta 欠落（新規ドラッグ追加で meta 未登録の異常時）は manual / 不透明白で安全側補完。
      estimatedBgColor: m?.estimatedBgColor ?? { r: 255, g: 255, b: 255 },
      source: m?.source ?? 'manual',
    })
  }
  return boxes
}
