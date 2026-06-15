'use client'

import { type NudgeAction } from '../nudge-controls'
import { FloatingShell } from './FloatingShell'
import { WhiteoutControlsBody } from './WhiteoutControlsBody'

export function WhiteoutFloatingNudge({
  onNudge,
  onCenter,
  onDelete,
  pdfWidth,
}: {
  onNudge: (action: NudgeAction) => void
  onCenter: () => void
  onDelete: () => void
  /** PDF 実表示幅(px)。スマホ下部バー幅をこれに揃え中央配置。 */
  pdfWidth: number | null
}) {
  const renderBody = (scale: number) => (
    <WhiteoutControlsBody
      onNudge={onNudge}
      onCenter={onCenter}
      onDelete={onDelete}
      dense
      scale={scale}
    />
  )
  return (
    <FloatingShell pdfWidth={pdfWidth} renderBody={renderBody} />
  )
}
