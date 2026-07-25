-- Phase 5a: テンプレ / 議事録サムネ管理カラム追加
-- baseline 20260526112403_remote_schema.sql 後に適用

-- templates テーブルにサムネ管理列追加（4 状態: pending/ready/failed/skipped）
ALTER TABLE public.templates
  ADD COLUMN thumbnail_path text,
  ADD COLUMN thumbnail_status text NOT NULL DEFAULT 'pending'
    CHECK (thumbnail_status IN ('pending', 'ready', 'failed', 'skipped'));

COMMENT ON COLUMN public.templates.thumbnail_path IS
  'image_cache バケット内パス: {family_id}/templates/{template_id}_72_png.png';
COMMENT ON COLUMN public.templates.thumbnail_status IS
  'pending = 生成中 / ready = 完了 / failed = 失敗 / skipped = docx で代替案① 採用時（Phase 5a 中はサムネ画像生成を持ち越し、Phase 5b で外部 SaaS 採用後に pending→ready 遷移可能化）';

-- minutes テーブルにサムネ管理列追加（3 状態: pending/ready/failed、skipped は templates 専用）
ALTER TABLE public.minutes
  ADD COLUMN thumbnail_path text,
  ADD COLUMN thumbnail_status text NOT NULL DEFAULT 'pending'
    CHECK (thumbnail_status IN ('pending', 'ready', 'failed'));

COMMENT ON COLUMN public.minutes.thumbnail_path IS
  'image_cache バケット内パス: {family_id}/minutes/{minutes_id}_72_png.png';
COMMENT ON COLUMN public.minutes.thumbnail_status IS
  'pending = 生成中 / ready = 完了 / failed = 失敗（minutes に skipped はない、templates 専用状態）';

-- ホーム画面の "最近の議事録 3 件" クエリ高速化（既存 idx_minutes_meeting_date とは別の複合 index）
CREATE INDEX IF NOT EXISTS idx_minutes_family_meeting_date
  ON public.minutes(family_id, meeting_date DESC);
