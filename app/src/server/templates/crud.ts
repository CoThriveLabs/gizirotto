'use server'

import { createSupabaseServerClient } from '@/lib/supabase/server'

/**
 * 関連件数（議事録 / チャットセッション）を返す。modal 表示時に使う。
 * RLS により自家族範囲しか count されない前提。
 */
export async function countTemplateRefs(templateId: string) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  const [minutesRes, chatRes] = await Promise.all([
    supabase
      .from('minutes')
      .select('id', { count: 'exact', head: true })
      .eq('template_id', templateId),
    supabase
      .from('chat_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('template_id', templateId),
  ])
  if (minutesRes.error) throw minutesRes.error
  if (chatRes.error) throw chatRes.error
  return {
    minutes: minutesRes.count ?? 0,
    chatSessions: chatRes.count ?? 0,
  }
}

export type DeleteTemplateMode = 'template_only' | 'with_minutes'

/**
 * 削除（自家族の自前テンプレのみ。デフォルトは RLS でブロック）。
 * mode:
 *   - 'template_only': 関連 minutes / chat_sessions は残し template_id を NULL に（DB 側 FK ON DELETE SET NULL に任せる）
 *   - 'with_minutes' : 関連 minutes を delete_minute_with_files RPC で物理削除 →
 *                      残った minute_id=NULL の chat_sessions も削除 → templates DELETE
 * Storage 側の raw / processed も合わせて削除する（取りこぼし許容、DB 削除を主とする）。
 */
export async function deleteTemplate(
  templateId: string,
  mode: DeleteTemplateMode = 'template_only',
) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  // 先に対象テンプレの path を取得（RLS で自家族 + is_default=false のみ見える前提）
  const { data: target, error: selectError } = await supabase
    .from('templates')
    .select('id, source_path, processed_path, is_default')
    .eq('id', templateId)
    .single()
  if (selectError) throw selectError
  if (target.is_default) throw new Error('CANNOT_DELETE_DEFAULT')

  if (mode === 'with_minutes') {
    // 関連 minutes を物理削除（storage 出力含む / minute_id 紐付き chat_sessions も連鎖削除）
    const { data: relatedMinutes, error: listErr } = await supabase
      .from('minutes')
      .select('id')
      .eq('template_id', templateId)
    if (listErr) throw listErr
    for (const m of relatedMinutes ?? []) {
      const { error: rpcErr } = await supabase.rpc('delete_minute_with_files', {
        p_minute_id: m.id,
      })
      if (rpcErr) throw rpcErr
    }
    // 議事録未保存の chat_sessions（minute_id IS NULL）も削除
    const { error: chatErr } = await supabase
      .from('chat_sessions')
      .delete()
      .eq('template_id', templateId)
    if (chatErr) throw chatErr
  }
  // mode === 'template_only' の場合は FK ON DELETE SET NULL に任せる

  if (target.source_path) {
    await supabase.storage.from('templates_raw').remove([target.source_path])
  }
  if (target.processed_path && !target.processed_path.startsWith('builtin/')) {
    await supabase.storage
      .from('templates_processed')
      .remove([target.processed_path])
  }

  const { error: deleteError } = await supabase
    .from('templates')
    .delete()
    .eq('id', templateId)
  if (deleteError) throw deleteError
  return { ok: true }
}

/**
 * 単一テンプレ取得。
 */
export async function getTemplate(templateId: string) {
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .eq('id', templateId)
    .single()
  if (error) throw error
  return data
}
