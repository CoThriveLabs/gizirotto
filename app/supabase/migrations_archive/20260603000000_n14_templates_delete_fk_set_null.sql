-- N-14 真因修正: templates DELETE が FK 制約でブロックされる問題
-- 経緯:
--   - phase5b migration `20260528000000` で chat_sessions.template_id を NOT NULL + ON DELETE 未指定（NO ACTION）で再作成
--   - init 由来の minutes.template_id も ON DELETE 未指定（NO ACTION）
--   → そのテンプレで作成済の chat_sessions / minutes が 1 件でも残ると templates DELETE が FK 違反でブロック
-- 設計判断: 削除時に親レコードを保持するため SET NULL を採用する。
--   - DB 層は SET NULL を安全弁とする（テンプレ削除しても議事録/チャット履歴は残せるように）
--   - 実際の「議事録も一緒に削除」/「テンプレだけ削除」分岐はアプリ層 server action で実装
--   - chat_sessions.template_id の NOT NULL も解除（SET NULL 動作の前提）

-- minutes.template_id: NO ACTION → SET NULL
ALTER TABLE public.minutes
  DROP CONSTRAINT IF EXISTS minutes_template_id_fkey;

ALTER TABLE public.minutes
  ADD CONSTRAINT minutes_template_id_fkey
    FOREIGN KEY (template_id) REFERENCES public.templates(id) ON DELETE SET NULL;

-- chat_sessions.template_id: NOT NULL 解除 + NO ACTION → SET NULL
ALTER TABLE public.chat_sessions
  ALTER COLUMN template_id DROP NOT NULL;

ALTER TABLE public.chat_sessions
  DROP CONSTRAINT IF EXISTS chat_sessions_template_id_fkey;

ALTER TABLE public.chat_sessions
  ADD CONSTRAINT chat_sessions_template_id_fkey
    FOREIGN KEY (template_id) REFERENCES public.templates(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.chat_sessions.template_id IS
  'チャットセッション開始時のテンプレ。テンプレ削除（SET NULL）後も履歴を残せるよう NULL 許容。';

COMMENT ON COLUMN public.minutes.template_id IS
  '議事録作成時のテンプレ。テンプレ削除（SET NULL）後も議事録本体は残るよう NULL 許容。';
