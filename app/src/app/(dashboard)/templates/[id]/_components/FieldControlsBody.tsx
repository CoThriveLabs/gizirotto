'use client'

import NudgeControls, { type NudgeAction } from '../nudge-controls'
import { DeleteFieldButton } from './DeleteFieldButton'
import { LabelInput } from './LabelInput'
import { RenameLabelRow } from './RenameLabelRow'
import { SplitFieldButton } from './SplitFieldButton'

/**
 * 記入欄の操作 body（段階2 Phase 2-D 修正・案A）。
 *
 * 案A: 「縦に2分割」「この枠を削除」を NudgeControls の「そろえる」列（中央寄せボタン）の**下**へ
 * extra として差し込み、第3カラム内に縦配置して縦を詰める（前回はカラム外の全幅縦積みで
 * 「中央寄せの下」になっていなかった不具合を解消）。
 *   - compact=true（PC 右固定パネル）: NudgeControls 縦積み。
 *   - dense=true（フロート <lg）: 3カラム横並びのままボタン/間隔だけ縮小。
 * 機能・onNudge/onSplit/onDelete・isFreshClick ガードは無改変（見た目/配置のみ）。
 */
export function FieldControlsBody({
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
  compact = false,
  dense = false,
  scale = 1,
}: {
  onNudge: (action: NudgeAction) => void
  onCenter: () => void
  onDelete: () => void
  canDelete: boolean
  onSplit: () => void
  canSplit: boolean
  splitDisabledReason?: string
  labelEditing: boolean
  labelValue: string
  onLabelChange: (value: string) => void
  onLabelCommit: () => void
  /** C-1（リネーム）: 鉛筆「項目名を編集」で既存 label のインライン入力を開く。 */
  onStartRename: () => void
  isFreshClick: () => boolean
  compact?: boolean
  dense?: boolean
  /** 幅追従スケール係数（0〜1）。 */
  scale?: number
}) {
  const small = compact || dense
  return (
    <>
      {labelEditing ? (
        <LabelInput
          value={labelValue}
          onChange={onLabelChange}
          onCommit={onLabelCommit}
        />
      ) : (
        // C-1: 非編集時は現 label と鉛筆ボタンを表示。クリックでインライン入力を開く。
        <RenameLabelRow
          label={labelValue}
          onStartRename={onStartRename}
          small={small}
        />
      )}
      <NudgeControls
        disabled={false}
        onNudge={onNudge}
        onCenter={onCenter}
        compact={compact}
        dense={dense}
        scale={scale}
        extra={
          <>
            {/* 案A: そろえる列の下に 縦に2分割 → この枠を削除 を縦にぶら下げる。 */}
            <SplitFieldButton
              onSplit={onSplit}
              canSplit={canSplit}
              disabledReason={splitDisabledReason}
              isFreshClick={isFreshClick}
              small={small}
              scale={dense ? scale : 1}
            />
            <DeleteFieldButton
              onDelete={onDelete}
              canDelete={canDelete}
              small={small}
              scale={dense ? scale : 1}
            />
          </>
        }
      />
    </>
  )
}
