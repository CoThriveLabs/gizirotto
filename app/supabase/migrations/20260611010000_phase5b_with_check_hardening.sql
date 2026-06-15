-- セキュリティ監査対応: RLS UPDATE policies に WITH CHECK 追加
--
-- 背景:
--   既存の UPDATE policy は USING のみで WITH CHECK が無く、攻撃者が認証済みセッションで
--   `family_id` 等の所有権キーを別 family の値に書き換える「pollution / 詐取」攻撃を防げない。
--   PostgreSQL の RLS UPDATE は USING（更新前行の可視性）と WITH CHECK（更新後行の許可）
--   両方を指定して初めて pre+post 両側を縛れる。
--
-- スコープ:
--   F1（致命）: families_update — 家族 ID 詐取防止
--   H1（重要）: minutes_update / templates_update / minutes_embeddings_all 分割
--   L3（軽微）: storage.objects FOR ALL policies に WITH CHECK 追加
--
-- 禁止事項:
--   - DELETE policy への WITH CHECK 追加は syntax error（USING のみ可）
--   - archived migration ファイル本体は編集禁止（本 migration で上書き運用）

-- ──────────────────────────────────────────────────────────────
-- F1: families_update に WITH CHECK 追加
-- ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "families_update" ON public.families;
CREATE POLICY "families_update" ON public.families
  FOR UPDATE TO authenticated
  USING (id = (auth.jwt() ->> 'family_id')::uuid)
  WITH CHECK (id = (auth.jwt() ->> 'family_id')::uuid);

-- ──────────────────────────────────────────────────────────────
-- H1: minutes_update に WITH CHECK 追加（cross-family pollution 防止）
-- ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "minutes_update" ON public.minutes;
CREATE POLICY "minutes_update" ON public.minutes
  FOR UPDATE TO authenticated
  USING (family_id = (auth.jwt() ->> 'family_id')::uuid)
  WITH CHECK (family_id = (auth.jwt() ->> 'family_id')::uuid);

-- ──────────────────────────────────────────────────────────────
-- H1: templates_update に WITH CHECK 追加
--   builtin（is_default = true）は UPDATE 不可（USING 段階で除外）を維持し、
--   user テンプレのみ family_id 一致を pre+post で強制。
-- ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "templates_update" ON public.templates;
CREATE POLICY "templates_update" ON public.templates
  FOR UPDATE TO authenticated
  USING (family_id = (auth.jwt() ->> 'family_id')::uuid AND is_default = false)
  WITH CHECK (family_id = (auth.jwt() ->> 'family_id')::uuid AND is_default = false);

-- ──────────────────────────────────────────────────────────────
-- H1: minutes_embeddings_all を verb 別 policy に分割
--   FOR ALL は USING のみで INSERT/UPDATE の post-condition を縛れないため、
--   SELECT/INSERT/UPDATE/DELETE に分割し UPDATE/INSERT に WITH CHECK を付与。
--
--   過去の初期マイグレーションで `minutes_embeddings_select` が既に作成済
--   （FOR SELECT、`minutes_embeddings_all` と共存）。本 migration の
--   分割 CREATE で同名衝突（SQLSTATE 42710）→ migration 全体ロールバックを起こすため、
--   分割後 4 名前を全て DROP IF EXISTS で先に落として冪等性を確保。
-- ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "minutes_embeddings_all" ON public.minutes_embeddings;
DROP POLICY IF EXISTS "minutes_embeddings_select" ON public.minutes_embeddings;
DROP POLICY IF EXISTS "minutes_embeddings_insert" ON public.minutes_embeddings;
DROP POLICY IF EXISTS "minutes_embeddings_update" ON public.minutes_embeddings;
DROP POLICY IF EXISTS "minutes_embeddings_delete" ON public.minutes_embeddings;

CREATE POLICY "minutes_embeddings_select" ON public.minutes_embeddings
  FOR SELECT TO authenticated
  USING (family_id = (auth.jwt() ->> 'family_id')::uuid);

CREATE POLICY "minutes_embeddings_insert" ON public.minutes_embeddings
  FOR INSERT TO authenticated
  WITH CHECK (family_id = (auth.jwt() ->> 'family_id')::uuid);

CREATE POLICY "minutes_embeddings_update" ON public.minutes_embeddings
  FOR UPDATE TO authenticated
  USING (family_id = (auth.jwt() ->> 'family_id')::uuid)
  WITH CHECK (family_id = (auth.jwt() ->> 'family_id')::uuid);

CREATE POLICY "minutes_embeddings_delete" ON public.minutes_embeddings
  FOR DELETE TO authenticated
  USING (family_id = (auth.jwt() ->> 'family_id')::uuid);

-- ──────────────────────────────────────────────────────────────
-- L3: storage.objects FOR ALL policies に WITH CHECK 追加
--   FOR ALL は USING のみで INSERT/UPDATE の post-condition を縛れない。
--   SELECT のみの builtin_read は対象外（WITH CHECK は SELECT に無効）。
-- ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "storage_templates_raw" ON storage.objects;
CREATE POLICY "storage_templates_raw" ON storage.objects
  FOR ALL
  USING (
    bucket_id = 'templates_raw'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'family_id')
  )
  WITH CHECK (
    bucket_id = 'templates_raw'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'family_id')
  );

DROP POLICY IF EXISTS "storage_templates_processed_self" ON storage.objects;
CREATE POLICY "storage_templates_processed_self" ON storage.objects
  FOR ALL
  USING (
    bucket_id = 'templates_processed'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'family_id')
  )
  WITH CHECK (
    bucket_id = 'templates_processed'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'family_id')
  );

DROP POLICY IF EXISTS "storage_outputs" ON storage.objects;
CREATE POLICY "storage_outputs" ON storage.objects
  FOR ALL
  USING (
    bucket_id = 'outputs'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'family_id')
  )
  WITH CHECK (
    bucket_id = 'outputs'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'family_id')
  );

DROP POLICY IF EXISTS "storage_imports" ON storage.objects;
CREATE POLICY "storage_imports" ON storage.objects
  FOR ALL
  USING (
    bucket_id = 'imports'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'family_id')
  )
  WITH CHECK (
    bucket_id = 'imports'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'family_id')
  );
