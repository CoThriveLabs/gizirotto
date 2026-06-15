import { describe, it, expect } from 'vitest'
import { generateBlankA4Png } from '@/lib/pdf-output/blank-a4-png'

describe('generateBlankA4Png', () => {
  it('returns a valid PNG (magic bytes) at dpi=150', async () => {
    const r = await generateBlankA4Png(150)
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    expect(r.bytes[0]).toBe(0x89)
    expect(r.bytes[1]).toBe(0x50)
    expect(r.bytes[2]).toBe(0x4e)
    expect(r.bytes[3]).toBe(0x47)
    expect(r.widthPt).toBe(595)
    expect(r.heightPt).toBe(842)
    // 150dpi -> scale 150/72 ~= 2.083 -> width ~= 1240px
    expect(r.widthPx).toBeGreaterThan(1000)
    expect(r.heightPx).toBeGreaterThan(1500)
  })

  it('scales pixel size with dpi', async () => {
    const a = await generateBlankA4Png(72)
    const b = await generateBlankA4Png(300)
    expect(b.widthPx).toBeGreaterThan(a.widthPx * 3)
    expect(b.heightPx).toBeGreaterThan(a.heightPx * 3)
  })
})
