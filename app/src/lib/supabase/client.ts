import { createBrowserClient } from '@supabase/ssr'

/**
 * クライアントコンポーネント用の Supabase クライアント。
 * publishable key のみ参照（秘密鍵は触らない）。
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  )
}
