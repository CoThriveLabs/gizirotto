'use server'

import { createSupabaseServerClient } from '@/lib/supabase/server'
import { MINUTES_PAGE_SIZE } from './shared'

export type MinutesListItem = {
  id: string
  title: string
  meeting_date: string
  thumbnail_path: string | null
  thumbnail_status: string
  template_id: string | null
  template_name: string | null
  source_format: string | null
  signedThumbUrl: string | null
}

export type MinutesListResult = {
  items: MinutesListItem[]
  totalCount: number
  page: number
  pageSize: number
}

/**
 * 議事録一覧。月絞り + meeting_date 降順 + 20 件 / page。
 */
export async function listMinutes(options?: {
  month?: string
  page?: number
}): Promise<MinutesListResult> {
  const page = Math.max(1, options?.page ?? 1)
  const offset = (page - 1) * MINUTES_PAGE_SIZE

  const supabase = await createSupabaseServerClient()

  let query = supabase
    .from('minutes')
    .select(
      'id, title, meeting_date, thumbnail_path, thumbnail_status, template_id, template:templates(name, source_format)',
      { count: 'exact' },
    )
    .order('meeting_date', { ascending: false })
    .range(offset, offset + MINUTES_PAGE_SIZE - 1)

  if (options?.month && /^\d{4}-\d{2}$/.test(options.month)) {
    const [year, month] = options.month.split('-').map(Number)
    const start = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10)
    const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
    query = query.gte('meeting_date', start).lte('meeting_date', end)
  }

  const { data, count, error } = await query
  if (error) throw error

  const items: MinutesListItem[] = await Promise.all(
    (data ?? []).map(async (row) => {
      const tpl = Array.isArray(row.template) ? row.template[0] : row.template
      let signedThumbUrl: string | null = null
      if (row.thumbnail_status === 'ready' && row.thumbnail_path) {
        const { data: signed } = await supabase.storage
          .from('image_cache')
          .createSignedUrl(row.thumbnail_path, 3600)
        signedThumbUrl = signed?.signedUrl ?? null
      }
      return {
        id: row.id,
        title: row.title,
        meeting_date: row.meeting_date,
        thumbnail_path: row.thumbnail_path,
        thumbnail_status: row.thumbnail_status,
        template_id: row.template_id,
        template_name: tpl?.name ?? null,
        source_format: tpl?.source_format ?? null,
        signedThumbUrl,
      }
    }),
  )

  return {
    items,
    totalCount: count ?? 0,
    page,
    pageSize: MINUTES_PAGE_SIZE,
  }
}
