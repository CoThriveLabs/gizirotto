import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import type { FixedText } from '@/lib/pdf-output/fixedtext-adapter'

// ─────────────────────────────────────────────────────────────────────
// Helpers（regenerate-minute-pdf.ts 同梱版のサーバ限定再利用。クライアント共有純
// 関数とは同居させない・mistake.md 2026-06-06 違反事例を踏まないため route.ts 内に閉じる）。
// ─────────────────────────────────────────────────────────────────────

export function normalizeFields(raw: unknown): PdfField[] {
  if (!raw) return []
  const arr: unknown = Array.isArray(raw)
    ? raw
    : typeof raw === 'object'
      ? (raw as { fields?: unknown }).fields
      : null
  if (!Array.isArray(arr)) return []
  return arr.filter(
    (f): f is PdfField =>
      !!f &&
      typeof f === 'object' &&
      typeof (f as { name?: unknown }).name === 'string',
  ) as PdfField[]
}

export function normalizeFixedTexts(raw: unknown): FixedText[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (ft): ft is FixedText =>
      !!ft &&
      typeof ft === 'object' &&
      typeof (ft as { name?: unknown }).name === 'string' &&
      typeof (ft as { value?: unknown }).value === 'string' &&
      !!(ft as { bbox?: unknown }).bbox &&
      typeof (ft as { bbox: { page?: unknown } }).bbox.page === 'number',
  )
}

export function applyBboxOverrides(fields: PdfField[], overrides: unknown): PdfField[] {
  if (!overrides || typeof overrides !== 'object') return fields
  const ov = overrides as Record<string, { x?: unknown; y?: unknown }>
  return fields.map((f) => {
    const o = ov[f.name]
    if (!o || typeof o.x !== 'number' || typeof o.y !== 'number') return f
    return { ...f, bbox: { ...f.bbox, x: o.x, y: o.y } }
  })
}
