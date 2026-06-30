import { createClient } from '@supabase/supabase-js'

/**
 * @supabase/supabase-js 由来の service_role クライアント。
 * auth.admin.deleteUser 等の管理 API を呼ぶ用途専用。
 *
 * Why:
 *   既存 createSupabaseServiceClient は @supabase/ssr の createServerClient で
 *   構築されており、auth.admin namespace を提供しない。auth.admin.* を呼ぶには
 *   @supabase/supabase-js の createClient が必要。
 *
 * Gotcha:
 *   - 絶対にクライアントコンポーネント（'use client'）から import しない。
 *   - 'use server' ファイル / route handler 内でのみ使用。
 */
export function createSupabaseAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  )
}
