'use client'

import { type NudgeAction } from '../nudge-controls'
import { FieldControlsBody } from './FieldControlsBody'
import { FloatingShell } from './FloatingShell'

/**
 * フローティング nudge ラッパ。レスポンシブ:
 *   - スマホ（< md）: 画面下部中央バー（PDF 幅追従・幅に応じて 3カラムを連続スケール）。
 *   - タブレット＋PC（>= md）: フローティングは出さず、右固定パネル（親が描画）に集約。
 * → よって本コンポーネントは **md 未満専用**（md 以上は親で非表示にする）。
 */
export function FloatingNudge({
  onNudge,
  onCenter,
  onDelete,
  canDelete,
  onSplit,
  canSplit,
  splitDisabledReason,
  labelEditing,
  labelValue,
  onLabelChange,
  onLabelCommit,
  onStartRename,
  isFreshClick,
  pdfWidth,
}: {
  onNudge: (action: NudgeAction) => void
  onCenter: () => void
  /** グループB B-2: この枠を削除（選択中のみ表示される親で制御）。 */
  onDelete: () => void
  /** false = 最後の1枠（削除不可）。ボタンを disabled にする。 */
  canDelete: boolean
  /** グループB B-4: この枠を縦に2分割（選択中のみ表示される親で制御）。 */
  onSplit: () => void
  /** false = 件数 or 最小幅ガードで分割不可。ボタンを disabled にする。 */
  canSplit: boolean
  /** 分割不可の理由（ツールチップ表示用）。canSplit=false のとき設定。 */
  splitDisabledReason?: string
  /** グループB B-3: 生成直後の枠で label インライン入力欄を出すか。 */
  labelEditing: boolean
  /** 選択枠の現在 label（入力欄の値）。 */
  labelValue: string
  onLabelChange: (value: string) => void
  /** 入力確定（Enter/blur）。空なら親が「項目N」を仮置きする。 */
  onLabelCommit: () => void
  /** C-1（リネーム）: 鉛筆「項目名を編集」で既存 label のインライン入力を開く。 */
  onStartRename: () => void
  /** ウィジェット出現/再配置直後の合成 click か（破壊的ボタンのガード）。 */
  isFreshClick: () => boolean
  /** PDF 実表示幅(px)。スマホ下部バーの幅をこれに揃え中央配置。 */
  pdfWidth: number | null
}) {
  const renderBody = (scale: number) => (
    <FieldControlsBody
      onNudge={onNudge}
      onCenter={onCenter}
      onDelete={onDelete}
      canDelete={canDelete}
      onSplit={onSplit}
      canSplit={canSplit}
      splitDisabledReason={splitDisabledReason}
      labelEditing={labelEditing}
      labelValue={labelValue}
      onLabelChange={onLabelChange}
      onLabelCommit={onLabelCommit}
      onStartRename={onStartRename}
      isFreshClick={isFreshClick}
      dense
      scale={scale}
    />
  )

  return (
    <FloatingShell pdfWidth={pdfWidth} renderBody={renderBody} />
  )
}
