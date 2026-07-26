-- 段階 2.5a: minutes.new_fields jsonb 新カラム追加（AdjustView 「項目追加」機能のデータ層）。
-- baseline 20260526112403_remote_schema.sql / 既存 minutes 拡張各 migration 後に適用。
--
-- 目的:
--   AdjustView で議事録ごとに記入欄を後追い追加できるようにする（2.5b で UI 実装）。
--   テンプレ fields は触らず、minutes 単位の新規 field だけ独立保存する。
--
-- 独立カラムにする理由:
--   ① bbox_overrides は「既存テンプレ field の override」専用の責務に保つ（混在禁止）。
--   ② RLS（既存 minutes_family_access policy）が jsonb 列にも自動継承され追加 policy 不要。
--   ③ 型生成（database.types.ts）1 回で完結し、$0 で済む。
--   ④ row サイズ増は微小（newFields 上限 20 件 × 1 件 ≈ 200B → 4KB 程度・toast せず行内収まる）。
--
-- 後方互換:
--   DEFAULT '[]'::jsonb + NOT NULL で「既存 minute は空配列」を保証。
--   mergeTemplateAndNewFields は null/空配列いずれも no-op（テンプレ fields だけ返す）。
ALTER TABLE public.minutes
  ADD COLUMN new_fields jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.minutes.new_fields IS
  '段階 2.5a（v2.7・Q-α-13 ② 案 B）。PdfField[]（{name,label,bbox:{page,x,y,w,h},type,font,...}・左上原点 pt）。
   AdjustView で追加した記入欄のみ。テンプレ fields とは独立。null は無く必ず配列（DEFAULT [])。
   merge は mergeTemplateAndNewFields(templates 優先・newFields 同 name は採番再確定) で実施。';
