/**
 * Built-in template IDs (family_id IS NULL, available to all users including
 * unauthenticated visitors). Any template ID not in this set must be treated
 * as user-family-owned and require auth + RLS.
 */
export const BUILTIN_TEMPLATE_IDS = new Set([
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
])

export function isBuiltinTemplate(id: string): boolean {
  return BUILTIN_TEMPLATE_IDS.has(id)
}
