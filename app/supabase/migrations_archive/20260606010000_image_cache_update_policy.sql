-- image_cache バケット UPDATE policy 追加（PY2-3 / 白塗り再保存→regenerate-thumbnail 500 修正）
--
-- 背景:
--   image_cache バケットは初期設計で INSERT / SELECT / DELETE policy のみ存在し UPDATE policy が無い。
--   supabase-js の `upload({ upsert: true })` は既存オブジェクトに対し内部で UPDATE 相当のクエリを走らせるため、
--   2 回目以降の同一 cacheKey 書き込みが RLS（policy なし）で弾かれ {ok:false, code:"UPLOAD_FAILED"} (500) になる。
--
--   再現条件: 白塗り編集モードで「白塗りを全削除して保存」→ 既存サムネと同 cacheKey へ upsert → 失敗。
--
-- 対策（多層防御）:
--   - アプリ側: template-thumbnail.ts で remove → upload(upsert:false) に修正済（INSERT/DELETE policy のみで成立）。
--   - DB 側: 本 migration で UPDATE policy 追加（他経路の image_cache upsert にも保険）。
--
-- 制約: SELECT/INSERT/DELETE policy と同一の「family 配下」スコープに揃え越権面を増やさない。

CREATE POLICY image_cache_update ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'image_cache'
    AND (storage.foldername(name))[1] = ((auth.jwt() ->> 'family_id'))
  )
  WITH CHECK (
    bucket_id = 'image_cache'
    AND (storage.foldername(name))[1] = ((auth.jwt() ->> 'family_id'))
  );
