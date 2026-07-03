import {
  type PageMeta,
  type BboxPt,
} from '@/lib/pdf-output/bbox-coords'
import { type BboxVariant, type WhiteoutKind } from './bbox-variant'
import type { FixedText } from '@/lib/pdf-output/fixedtext-adapter'
import { type FieldValueComposite } from '@/lib/preview/field-values-composite-canvas'
import type { FittableFont } from '@/lib/pdf-output/fitting'
import type { WhiteoutBox, RgbColor } from '@/lib/parsers/pdf/whiteout-pipeline'

export interface EditorField {
  name: string
  label: string
  bbox: BboxPt & { page: number }
}

/** 選択中 bbox の画面位置（フローティング nudge の近傍配置用・§A3）。 */
export interface SelectionGeom {
  /** ビューポート基準（fixed/PC 近傍配置に使う）。 */
  viewportLeft: number
  viewportTop: number
  width: number
  height: number
}

export interface Props {
  meta: PageMeta
  imageUrl: string | null
  /** このページに属する field のみ。 */
  fields: EditorField[]
  selectedName: string | null
  /** name 選択。null で選択解除（空白クリック・§A3）。 */
  onSelect: (name: string | null) => void
  /** bbox 更新（移動/リサイズの結果。pt 空間、丸めなし）。 */
  onChangeBbox: (name: string, bbox: BboxPt & { page: number }) => void
  /**
   * ドラッグ開始（pointerdown）時に1回通知する。
   * 親はここで「ドラッグ前 snapshot」を**一時退避**するだけ（まだ undoStack に積まない）。
   * 省略可（白塗りなど undo 不要の呼び出しは渡さない＝後方互換）。
   */
  onDragStart?: (name: string) => void
  /**
   * 新②undo（実機FB: 誤push修正）: ドラッグ確定（pointerup）時に通知する。
   *   changed=true（実際に bbox が変化した移動/リサイズ）のときのみ親が退避 snapshot を push する。
   *   changed=false（クリック＝選択のみ・移動量0）では push しない＝「戻る」が誤有効化しない。
   * 省略可（後方互換）。
   */
  onDragCommit?: (name: string, changed: boolean) => void
  /** 選択 bbox の画面位置を通知（フローティング nudge 配置・§A3）。 */
  onSelectionGeom?: (geom: SelectionGeom | null) => void
  /** ③ユーザーズーム倍率（PY1-1・既定 1.0）。displayWidth へ注入。 */
  zoom?: number
  /** ②縦フィット基準高さ（px・PY1-1）。省略時 高さ制約なし（従来）。 */
  viewportHeight?: number
  /** ④グリッド/中心線表示（PY1-4・描画のみ・座標非破壊）。 */
  showGrid?: boolean
  /**
   * 枠の見た目バリアント。
   *   - 'field'（既定）: 記入欄＝青枠（現状そのまま・段階1完了時と完全同一）。
   *   - 'whiteout'     : 白塗り＝灰色30%枠（記入欄の青と視覚差別化）。
   * 省略時 'field' で従来挙動を保証（記入欄側の呼び出しは無改修で動く＝後方互換）。
   * ⚠ 見た目のみ。座標計算（bbox-coords）・pointer ロジックは variant 非依存で共通＝ズレ温床ゼロ。
   */
  variant?: BboxVariant
  /**
   * 白塗り field の種別（auto=破線/manual=実線）を返す解決関数。
   * variant='whiteout' のときのみ参照。省略 or 戻り値 undefined は実線（manual 相当）。
   */
  whiteoutKindOf?: (name: string) => WhiteoutKind | undefined
  /**
   * 白塗りモードの raw 背景 PNG signedUrl（合成なし）。
   * variant='whiteout' かつ非 null のとき、<img> ではなく <canvas> に raw を描き、編集中の
   * fields（whiteoutFields）を compositeWhiteoutOnCanvas で都度合成する。削除した瞬間に
   * 合成対象から外れ元の文字が透ける（②本命 UX）＋ raw 固定でキャッシュ固着が消滅。
   * null のときは従来どおり imageUrl（焼込済 <img>）にフォールバック（raw 非対応テンプレ）。
   */
  whiteoutRawImageUrl?: string | null
  /**
   * 白塗り field の塗り色（estimatedBgColor）を返す解決関数。
   * canvas 合成で raw 上に塗る矩形の色。whiteoutRawImageUrl 使用時のみ参照。省略時は不透明白。
   */
  whiteoutBgColorOf?: (name: string) => RgbColor
  /**
   * #17・設計書 v1.8 §3-3-2: 動的プレビュー（全モード共通）の追加合成入力。
   *
   * - dynamicWhiteoutBoxes: 白塗りモード以外で「DB 保存済の白塗り」を canvas に重ねるための入力。
   *   白塗りモードは編集中 fields から自前で boxes を組むため省略する（後方互換）。
   * - dynamicFixedTexts: 全モード共通で固定テキストを動的合成するための入力。
   *   固定テキストモードでは編集中の fixedFields 由来、それ以外モードでは DB 保存値 fixed_texts。
   *   削除/value 変更で即 canvas 更新（焼き込み撤回・再編集不可バグ対策）。
   *
   * raw 経路が有効（whiteoutRawImageUrl があるとき）にのみ重ねる。raw 非対応テンプレでは
   * 従来 <img>（焼込済 _blank.pdf）にフォールバックし固定テキストの動的合成は無効になる
   * （旧データ後方互換・実害なし＝raw が無いと bbox-editor 経路自体が制限される）。
   */
  dynamicWhiteoutBoxes?: WhiteoutBox[]
  dynamicFixedTexts?: FixedText[]
  /**
   * 段階2-D2（設計書 v2.0 §1-2-3）: AdjustView 記入欄値の動的合成入力。
   *
   * 当該ページに属する items[]（field + value + override）を渡すと、canvas 上に
   * 「白塗り → 固定テキスト → 記入値」の順で重ね描画する（焼き込み残り二重描画ゼロ）。
   * useCanvasBg=true（raw URL あり）のときのみ機能する。空 / undefined は無描画＝従来挙動。
   */
  dynamicFieldValues?: FieldValueComposite[]
  /**
   * 段階2-D2（設計書 v2.0 §4 / §1-2-3）: 記入欄値合成時の uniform フォントサイズ（pt）。
   * 省略時は各 field.font.size を使う。per-field override.fontSize は uniform より優先。
   */
  fieldValuesUniformFontSize?: number
  /**
   * 🔴 段階2-D3（設計書 v2.2 §1-2-6 動的プレビュー vs PDF 完全一致・推し案 B）:
   * 記入欄値合成時に **PDF 出力経路（pdf-lib）と同じ OTF メトリクス** で wrap 判定するための
   * `FittableFont` 互換オブジェクト（opentype.js 経由・preview-font-loader 由来）。
   *
   * 渡された場合: `fitting.ts` の `wrapText` を呼ぶ → PDF 経路と wrap 位置・行数が完全一致。
   * 未渡し: `ctx.measureText` ベースの近似 wrap（v2.1 fallback・劣化プレビュー）。
   *
   * AdjustView のフォントロード未完了時 / SSR / 失敗時でも UI を止めないため undefined 許容。
   */
  fieldValuesPreviewFont?: FittableFont
  /**
   * もう片方のレイヤを薄く参考表示する read-only オーバーレイ。
   * 編集対象（fields）とは別に、選択/移動/リサイズ不可で薄く重ねるだけ（pointer-events-none）。
   * 例: 記入欄モードでは白塗りを、白塗りモードでは記入欄を薄く出して相互位置を確認できる（§4-1）。
   */
  referenceFields?: EditorField[]
  /** 参考レイヤの variant（薄表示の色味を編集対象と区別する）。省略時は編集対象の逆。 */
  referenceVariant?: BboxVariant
  /**
   * 段階2 Phase 2-D 修正（実機FB）: PDF プレビュー（背景画像）の実表示幅(px)を親へ通知する。
   * フローティングウィジェットの横幅を PDF 表示幅に追従させる（中央で同幅に縦並びさせる統一感）用。
   * displayWidth（containerWidth/縦フィット/zoom を反映した実描画幅）が変わるたびに呼ぶ。
   */
  onDisplayWidth?: (width: number) => void
  /**
   * C-2 v1.3 §3-2-5（A5）: 固定テキストモードの編集中プレビュー。
   * 各 field の `value` を bbox 内に fit-to-box（高さ基準・横溢れ縮小）で描画する。
   * `fixedTextValueOf` が非 undefined のときのみ、この pane を固定テキスト描画モードとみなす
   * （記入欄/白塗りモードでは渡さない＝描画なし・無改修）。空文字は枠のみ（描画なし）。
   */
  fixedTextValueOf?: (name: string) => string | undefined
  /**
   * C-2 v1.5 §3-2-3（縦横比保持 復活）: 4 隅ドラッグを**縦横比保持**でリサイズする。
   * true（固定テキストモード）のとき resizeBbox の代わりに resizeBboxKeepAspect を使い、
   * リサイズ開始時の bbox の aspect（w/h）を保ったまま拡縮する。
   * 省略/false（記入欄・白塗り）は従来の自由リサイズ（resizeBbox）＝無改修。
   */
  keepAspect?: boolean
  /**
   * AdjustView 専用のドラッグ中レイヤ凍結を
   * 有効化する。true のとき、bbox ドラッグ中（pane 内部 drag !== null の間）は重い背景フル
   * 再合成（compositeWhiteoutOnCanvas の全面 drawImage）をスキップし、freeze 時に撮った
   * ImageBitmap スナップショット + 移動 field の軽量描画だけを行う。
   *
   * 🚨 省略時 false = 従来挙動（templates 編集モードは常に false＝完全不変）。
   *   本フラグが false の経路は段階1完了時と 1px も変えない（既存行の削除・改変禁止・追加のみ）。
   */
  freezeDragLayer?: boolean
}
