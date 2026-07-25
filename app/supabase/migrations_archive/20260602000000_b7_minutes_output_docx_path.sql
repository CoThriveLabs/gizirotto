-- minutes.output_docx_path カラム追加漏れの修正
-- 経緯: Phase 5 prep の段階で output_pdf_path のみ追加され、
--   output_docx_path 追加 migration が作成漏れ。
-- 影響: minutes 詳細ページの getMinutes SELECT で 42703 undefined_column → notFound() → 404。
--       phase5b RPC delete_minute_with_files も同列参照しており同型エラーになる潜在リスクあり。
-- 概要: docx 出力で minutes_output/{family_id}/{id}.docx を保存 → minutes.output_docx_path に path を UPDATE する想定。

ALTER TABLE public.minutes
  ADD COLUMN IF NOT EXISTS output_docx_path text;

COMMENT ON COLUMN public.minutes.output_docx_path IS
  'minutes_output バケットの docx 出力 path: {family_id}/{minutes_id}.docx。content / bbox_overrides 変更時は NULL リセットして次回 docx ダウンロードで再生成。';
