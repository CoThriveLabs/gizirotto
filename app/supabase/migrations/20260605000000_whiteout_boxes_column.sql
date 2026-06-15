-- 段階1 C-2: 白塗り座標の永続化（A500 回避の土台）
-- baseline 20260526112403_remote_schema.sql 後に適用

-- パス B 白塗り座標を独立カラムで永続化する。
-- fields jsonb 拡張ではなく独立カラムにする理由:
--   ① fields は記入欄（グループB）の編集対象で computeFieldsVersion の楽観ロック対象。
--      白塗り座標を混ぜると fieldsVersion が白塗り操作で無用に変わり保存衝突を誘発する。
--   ② 白塗りと fields は編集ライフサイクルが別。分離が非破壊。
ALTER TABLE public.templates
  ADD COLUMN whiteout_boxes jsonb;

COMMENT ON COLUMN public.templates.whiteout_boxes IS
  'パスB白塗り座標の永続化（段階1 C-2）。WhiteoutBox[]（{page,bbox:{x,y,w,h},estimatedBgColor,source}・左上原点 pt）。
   用途: ① bbox-editor / サムネ / 出力表示の raw 背景への白塗り再合成（A500 回避） ② 段階2の白塗りリッチ再編集。
   null = 白塗り未適用 or 旧データ（その場合は従来の _blank.pdf ラスタライズにフォールバック）';
