/**
 * ブラウザ Canvas2D プレビュー描画ヘルパ群。
 * 責務: クライアントサイドの動的プレビュー合成のみ。
 * @napi-rs/canvas / pdf-lib / sharp 等のサーバ専用依存は一切 import しない（純関数のみ）。
 */
export { compositeWhiteoutOnCanvas } from './whiteout-composite-canvas'
export { compositeFixedTextsOnCanvas } from './fixedtext-composite-canvas'
export {
  compositeFieldValuesOnCanvas,
  _resetWrapCache,
  type FieldValueComposite,
  type FieldValueCompositeOptions,
} from './field-values-composite-canvas'
export {
  paintBackgroundSnapshot,
  paintDraggingField,
} from './drag-overlay-canvas'
