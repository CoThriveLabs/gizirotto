'use client'

import { type PageMeta, type FitOptions, ptToDispX, ptToDispY } from '@/lib/pdf-output/bbox-coords'
import { type BboxVariant, bboxBoxClass } from '../bbox-variant'
import type { EditorField } from '../bbox-pane-types'

export interface BboxReferenceLayerProps {
  referenceFields: EditorField[]
  referenceVariant?: BboxVariant
  variant: BboxVariant
  meta: PageMeta
  fitOpts: FitOptions
}

/* 参考レイヤ（§4-1）: もう片方のレイヤを薄く read-only 表示。
   編集対象（fields）の下に敷き、選択/ドラッグ不可（pointer-events-none）。
   相互の位置関係を見ながら編集できるようにするための非編集オーバーレイ。 */
export default function BboxReferenceLayer({
  referenceFields,
  referenceVariant,
  variant,
  meta,
  fitOpts,
}: BboxReferenceLayerProps) {
  return (
    <>
      {referenceFields.map((rf) => {
        const left = ptToDispX(meta, rf.bbox.x, fitOpts)
        const top = ptToDispY(meta, rf.bbox.y, fitOpts)
        const w = ptToDispX(meta, rf.bbox.x + rf.bbox.w, fitOpts) - left
        const h = ptToDispY(meta, rf.bbox.y + rf.bbox.h, fitOpts) - top
        const refVar: BboxVariant =
          referenceVariant ?? (variant === 'field' ? 'whiteout' : 'field')
        return (
          <div
            key={`ref-${rf.name}`}
            className={
              'absolute border-2 pointer-events-none opacity-40 ' +
              bboxBoxClass(refVar, false)
            }
            style={{
              left,
              top,
              width: Math.max(2, w),
              height: Math.max(2, h),
            }}
          />
        )
      })}
    </>
  )
}
