'use server'

import { createSupabaseServerClient } from '@/lib/supabase/server'

/**
 * 自家族の templates 一覧 + デフォルトテンプレを取得。
 * RLS により自家族 + family_id IS NULL（builtin）のみ返る。
 */
export async function listTemplates() {
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase
    .from('templates')
    .select(
      'id, name, source_format, processed_path, fields, is_default, created_at, thumbnail_path, thumbnail_status',
    )
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

/**
 * テンプレ一覧 + 各テンプレの thumbnail signed URL を付与。
 * thumbnail_status='ready' かつ thumbnail_path が存在する場合のみ signed URL を生成。
 */
export async function listTemplatesWithThumbs() {
  const supabase = await createSupabaseServerClient()
  const templates = await listTemplates()
  const withThumbs = await Promise.all(
    templates.map(async (t) => {
      let signedThumbUrl: string | null = null
      if (t.thumbnail_status === 'ready' && t.thumbnail_path) {
        const { data } = await supabase.storage
          .from('image_cache')
          .createSignedUrl(t.thumbnail_path, 3600)
        signedThumbUrl = data?.signedUrl ?? null
      }
      return { ...t, signedThumbUrl }
    }),
  )
  return withThumbs
}
