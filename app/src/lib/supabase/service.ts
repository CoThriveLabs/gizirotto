import { createServerClient } from '@supabase/ssr'

/**
 * service_role 相当（新形式キー: SUPABASE_SECRET_KEY）。
 * RLS をバイパスするため、サーバ専用処理（DB Trigger 補完・管理 RPC 等）のみで使用。
 * 絶対にクライアントコンポーネントから import しない。
 */
export function createSupabaseServiceClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    {
      cookies: {
        getAll: () => [],
        setAll: () => {
          // service client では Cookie 更新不要
        },
      },
    },
  )
}
