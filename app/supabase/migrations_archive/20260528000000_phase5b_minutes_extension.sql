-- Phase 5b: 議事録 CRUD + AI チャット + テンプレ拡張 + 招待コード再発行 用 schema 拡張
-- baseline: 20260526112403_remote_schema.sql + 20260601000000_phase5a_thumbnail_columns.sql 後に適用

-- ============================================================
-- 0. phantom 残骸 cleanup（履歴未登録の chat_sessions/messages 対応）
--    過去 drafting 中に手動投入された残骸を冪等 DROP（無ければ無効）。
--    本 migration 1 本で本番と同じ schema が再現できる完結性を維持。
-- ============================================================
DROP TABLE IF EXISTS public.messages CASCADE;
DROP TABLE IF EXISTS public.chat_sessions CASCADE;

-- ============================================================
-- 1. minutes.bbox_overrides 列追加（微調整 UI 初版用）
-- ============================================================
ALTER TABLE public.minutes
  ADD COLUMN bbox_overrides jsonb;

COMMENT ON COLUMN public.minutes.bbox_overrides IS
  '微調整 UI 初版で議事録ごとに上書きされた bbox の差分。NULL = テンプレ fields.json の bbox をそのまま使う。形式: { field_name: { x, y } } の Partial（Phase 5b は x/y のみ、リサイズは Phase 6 以降）';

-- ============================================================
-- 2. templates.blank_pdf_status 列追加（Phase 2.5 拡張）
--    Phase 2 既存 pdf テンプレは Phase 2 既存パイプで blank PDF 生成済
--    （templates.ts 暫定: source_format='pdf' は {template_id}_blank.pdf 保存済）。
--    → 既存行は source_format で判定してバックフィル。docx 既存テンプレは
--    Phase 2.5 拡張（CloudConvert）で生成待ちのため 'pending' のままで OK。
-- ============================================================
ALTER TABLE public.templates
  ADD COLUMN blank_pdf_status text NOT NULL DEFAULT 'pending'
    CHECK (blank_pdf_status IN ('pending', 'ready', 'failed'));

UPDATE public.templates SET blank_pdf_status = 'ready' WHERE source_format = 'pdf';

COMMENT ON COLUMN public.templates.blank_pdf_status IS
  'docx テンプレ blank PDF 化ステータス（Phase 2.5 拡張）。pdf テンプレは Phase 2 既存パイプで blank PDF 生成済のため常に ready 扱い。pending = 生成中 / ready = 完了 / failed = CloudConvert 呼出失敗（再アップロード待ち）';

-- ============================================================
-- 3. chat_sessions テーブル新規作成
-- ============================================================
CREATE TABLE public.chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES public.templates(id),
  mode text NOT NULL CHECK (mode IN ('A-1', 'A-2')),
  minute_id uuid REFERENCES public.minutes(id) ON DELETE SET NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

COMMENT ON TABLE public.chat_sessions IS
  'AI チャットセッション (A-1 質問順 / A-2 自由会話)。B-2 項目モードは chat 不要のため記録しない。minute_id は議事録保存後にリンク、それ以前は NULL。';

CREATE INDEX idx_chat_sessions_family_created_at
  ON public.chat_sessions(family_id, created_at DESC);

-- ============================================================
-- 4. messages テーブル新規作成
-- ============================================================
CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_session_created_at
  ON public.messages(session_id, created_at ASC);

-- ============================================================
-- 5. RLS Policy: family_id ベース
-- ============================================================
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_sessions_family_access ON public.chat_sessions
  FOR ALL
  USING (family_id = (SELECT family_id FROM public.family_members WHERE user_id = auth.uid()))
  WITH CHECK (family_id = (SELECT family_id FROM public.family_members WHERE user_id = auth.uid()));

CREATE POLICY messages_family_access ON public.messages
  FOR ALL
  USING (
    session_id IN (
      SELECT id FROM public.chat_sessions
      WHERE family_id = (SELECT family_id FROM public.family_members WHERE user_id = auth.uid())
    )
  )
  WITH CHECK (
    session_id IN (
      SELECT id FROM public.chat_sessions
      WHERE family_id = (SELECT family_id FROM public.family_members WHERE user_id = auth.uid())
    )
  );

-- ============================================================
-- 6. RPC delete_minute_with_files（削除フロー）
--    DB 行削除 + storage オブジェクト削除を同 transaction で実行。
--    Phase 5b は物理削除即時。Phase 6 でゴミ箱 30 日復元へ書換え予定。
-- ============================================================
CREATE OR REPLACE FUNCTION public.delete_minute_with_files(p_minute_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_family_id uuid;
  v_user_family_id uuid;
  v_output_pdf_path text;
  v_output_docx_path text;
  v_thumbnail_path text;
BEGIN
  -- 認可: minute の family_id と current user の family_id 一致確認
  SELECT family_id, output_pdf_path, output_docx_path, thumbnail_path
    INTO v_family_id, v_output_pdf_path, v_output_docx_path, v_thumbnail_path
    FROM public.minutes WHERE id = p_minute_id;
  SELECT family_id INTO v_user_family_id FROM public.family_members WHERE user_id = auth.uid();
  IF v_family_id IS NULL OR v_family_id <> v_user_family_id THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;

  -- DB 行削除（messages → chat_sessions → minutes の FK 解消順）
  -- Phase 5b は物理削除即時（同 transaction で削除）。
  -- chat_sessions.minute_id は SET NULL 定義だが、Phase 5b では孤児残しは NG のため明示削除する。
  -- Phase 6 ゴミ箱導入時は schema 自体を論理削除に書き換え予定（minutes / chat_sessions 双方に deleted_at 追加）。
  DELETE FROM public.messages
    WHERE session_id IN (
      SELECT id FROM public.chat_sessions WHERE minute_id = p_minute_id
    );
  DELETE FROM public.chat_sessions WHERE minute_id = p_minute_id;
  DELETE FROM public.minutes WHERE id = p_minute_id;

  -- storage オブジェクト削除（失敗しても WARN ログのみ、DB 行は確実に消す優先）
  BEGIN
    IF v_output_pdf_path IS NOT NULL THEN
      DELETE FROM storage.objects WHERE bucket_id = 'minutes_output' AND name = v_output_pdf_path;
    END IF;
    IF v_output_docx_path IS NOT NULL THEN
      DELETE FROM storage.objects WHERE bucket_id = 'minutes_output' AND name = v_output_docx_path;
    END IF;
    IF v_thumbnail_path IS NOT NULL THEN
      DELETE FROM storage.objects WHERE bucket_id = 'image_cache' AND name = v_thumbnail_path;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'delete_minute_with_files: storage cleanup partial failure for minute_id=%, error=%', p_minute_id, SQLERRM;
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_minute_with_files(uuid) TO authenticated;

COMMENT ON FUNCTION public.delete_minute_with_files(uuid) IS
  'Phase 5b: 議事録物理削除 + 関連 storage オブジェクト一括削除。Phase 6 で論理削除 + 30 日ゴミ箱復元へ書換え予定。';

-- ============================================================
-- 7. RPC regenerate_family_invite_code（招待コード再発行）
--    admin only ガード（二重防御の DB 層）、UNIQUE 制約自動 verify、TTL 7 日リセット。
-- ============================================================
CREATE OR REPLACE FUNCTION public.regenerate_family_invite_code(p_family_id uuid, p_new_code text)
RETURNS TABLE(invite_code text, invite_code_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_family_id uuid;
  v_user_role text;
  v_new_expires_at timestamptz;
BEGIN
  -- 認可: 呼出ユーザーが対象 family の admin であること確認
  SELECT family_id, role INTO v_user_family_id, v_user_role
    FROM public.family_members WHERE user_id = auth.uid();
  IF v_user_family_id IS NULL OR v_user_family_id <> p_family_id THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED';
  END IF;
  IF v_user_role <> 'admin' THEN
    RAISE EXCEPTION 'ADMIN_ONLY';
  END IF;

  -- 新コード形式 check（既存 families.invite_code の baseline CHECK と同等、紛らわしい文字除外 32 文字 10 桁）
  IF p_new_code IS NULL OR length(p_new_code) <> 10
     OR p_new_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$' THEN
    RAISE EXCEPTION 'INVALID_CODE_FORMAT';
  END IF;

  -- TTL 7 日リセット
  v_new_expires_at := now() + interval '7 days';

  -- UPDATE families.invite_code + invite_code_expires_at（UNIQUE 制約自動 verify）
  BEGIN
    UPDATE public.families
      SET invite_code = p_new_code,
          invite_code_expires_at = v_new_expires_at
      WHERE id = p_family_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- 衝突発生時はアプリ側で再生成リトライ（nanoid 衝突確率 1/3.4×10^16）
      RAISE EXCEPTION 'CODE_COLLISION';
  END;

  -- 戻り値: 新コード + 期限
  RETURN QUERY SELECT p_new_code, v_new_expires_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.regenerate_family_invite_code(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.regenerate_family_invite_code(uuid, text) IS
  'Phase 5b: 招待コード再発行（admin only）。CODE_COLLISION 時はアプリ側で 1 回リトライ。';
