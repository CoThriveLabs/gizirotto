'use client'

import { type NudgeAction } from '../nudge-controls'
import { FixedTextControlsBody } from './FixedTextControlsBody'
import { FloatingShell } from './FloatingShell'

export function FixedTextFloatingNudge({
  onNudge,
  onCenter,
  onDelete,
  onSizeStep,
  value,
  onValueChange,
  pdfWidth,
}: {
  onNudge: (action: NudgeAction) => void
  onCenter: () => void
  onDelete: () => void
  onSizeStep: (delta: number) => void
  value: string
  onValueChange: (v: string) => void
  pdfWidth: number | null
}) {
  const renderBody = (scale: number) => (
    <FixedTextControlsBody
      onNudge={onNudge}
      onCenter={onCenter}
      onDelete={onDelete}
      onSizeStep={onSizeStep}
      value={value}
      onValueChange={onValueChange}
      dense
      scale={scale}
    />
  )
  return <FloatingShell pdfWidth={pdfWidth} renderBody={renderBody} />
}
