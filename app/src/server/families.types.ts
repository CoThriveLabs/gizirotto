import { z } from 'zod'

/**
 * families Server Actions の型 + 入力スキーマ。
 *
 * Next.js 15: `'use server'` ファイルから export できるのは async function のみで、
 * type / interface / 同期定数 / object を export すると runtime error
 * （"A 'use server' file can only export async functions"）。
 * そのため families.ts から型と zod schema をこのファイルに切り出している。
 */

export const createFamilySchema = z.object({
  familyName: z.string().min(1).max(40),
  displayName: z.string().min(1).max(20),
})

export const joinFamilySchema = z.object({
  inviteCode: z.string().length(10),
  displayName: z.string().min(1).max(20),
})

export type CreateFamilyInput = z.infer<typeof createFamilySchema>
export type JoinFamilyInput = z.infer<typeof joinFamilySchema>

export type FamilyActionResult =
  | { ok: true }
  | { ok: false; code: 'FAMILY_CLAIM_NOT_REFLECTED' }
