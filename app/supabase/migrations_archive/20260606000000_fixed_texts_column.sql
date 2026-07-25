-- 固定テキスト（会議名・参加者など常時同一値）をテンプレに永続化する。
-- baseline 20260526112403_remote_schema.sql / 20260605000000_whiteout_boxes_column.sql 後に適用

-- fields jsonb 拡張ではなく独立カラムにする理由（whiteout_boxes と同思想）:
--   ① fields は記入欄（グループB）の編集対象で computeFieldsVersion の楽観ロック対象。
--      固定テキストを混ぜると fieldsVersion が無用に変わり保存衝突を誘発する。
--   ② 固定テキストと fields は編集ライフサイクルが別。分離が非破壊。
ALTER TABLE public.templates
  ADD COLUMN fixed_texts jsonb;

COMMENT ON COLUMN public.templates.fixed_texts IS
  '固定テキスト。FixedText[]（{name,value,bbox:{page,x,y,w,h},font}・左上原点 pt）。
   用途: 会議名・参加者など常時同一値を overlay 出力へ常時注入。記入欄 fields とは分離（fieldsVersion を汚さない）。
   ※白塗り whiteout_boxes / 既存 whiteout_C2 設計とは無関係。null = 固定テキスト未設定';
