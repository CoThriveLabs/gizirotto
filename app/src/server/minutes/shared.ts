import { z } from 'zod'

const MINUTES_PAGE_SIZE = 20

const contentSchema = z.record(z.string(), z.unknown())

/**
 * partial FieldOverride。x/y/w/h/fontSize すべて optional（旧 `{x,y}` のみ override も
 * 後方互換で valid）。w/h/fontSize は正の有限数のみ受け入れる。
 */
const fieldOverrideSchema = z
  .object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    w: z.number().finite().positive().optional(),
    h: z.number().finite().positive().optional(),
    fontSize: z.number().finite().positive().optional(),
  })
  .strict()

export { MINUTES_PAGE_SIZE, contentSchema, fieldOverrideSchema }
