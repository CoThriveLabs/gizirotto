-- account delete 機能 #412: auth.users 削除時の FK SET NULL 化
-- 退会フローで auth.admin.deleteUser を呼ぶ際、auth.users(id) を参照する
-- public 側の 3 列が NO ACTION のままだと FK 違反で削除がブロックされる。
-- 削除時に作成者列を NULL にして minutes / templates / chat_sessions 本体は残せるよう
-- SET NULL に張り直す。
--
-- Why SET NULL:
--   - GDPR 削除権に整合（auth.users 本体は物理削除）
--   - ただし他メンバーが引き続き minutes / templates を使えるよう作成者列だけ NULL 化
--   - chat_sessions は通常退会時にアプリ層で個別 DELETE するが、保険として SET NULL
--
-- Gotcha:
--   - chat_sessions の auth.users 参照列は `created_by`（親設計書の `user_id` 表記は誤り）
--   - DROP CONSTRAINT IF EXISTS でデフォルト命名を前提に外す。命名が異なる場合は
--     pg_constraint を見て手動修正が必要

-- ------------------------------------------------------------
-- 1. templates.created_by: NO ACTION → SET NULL
-- ------------------------------------------------------------
ALTER TABLE public.templates
  DROP CONSTRAINT IF EXISTS templates_created_by_fkey;

ALTER TABLE public.templates
  ADD CONSTRAINT templates_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- 2. minutes.created_by: NO ACTION → SET NULL
-- ------------------------------------------------------------
ALTER TABLE public.minutes
  DROP CONSTRAINT IF EXISTS minutes_created_by_fkey;

ALTER TABLE public.minutes
  ADD CONSTRAINT minutes_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- 3. chat_sessions.created_by: NOT NULL 解除 + NO ACTION → SET NULL
--    （phase5b migration で `created_by uuid NOT NULL REFERENCES auth.users(id)` で作成済）
-- ------------------------------------------------------------
ALTER TABLE public.chat_sessions
  ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE public.chat_sessions
  DROP CONSTRAINT IF EXISTS chat_sessions_created_by_fkey;

ALTER TABLE public.chat_sessions
  ADD CONSTRAINT chat_sessions_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- 4. COMMENT
-- ------------------------------------------------------------
COMMENT ON COLUMN public.templates.created_by IS
  'テンプレ作成者。退会時に auth.users 削除で SET NULL（家族で引き続き使用可）。';

COMMENT ON COLUMN public.minutes.created_by IS
  '議事録作成者。退会時に auth.users 削除で SET NULL（家族で引き続き閲覧可）。';

COMMENT ON COLUMN public.chat_sessions.created_by IS
  'セッション所有者。退会時の SET NULL を許容するため NULL 可。';
