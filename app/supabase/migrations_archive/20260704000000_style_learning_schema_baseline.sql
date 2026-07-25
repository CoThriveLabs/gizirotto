-- ============================================================================
-- 議事録の書き方を覚える機能: user_styles / minutes_embeddings の DDL 正本化
--
-- 背景:
--   両テーブルは Supabase リモートに先行作成済みで、migration ファイルには
--   未追跡だった（match_documents() RPC のみ 20260526112403_remote_schema.sql に記録済）。
--   本 migration は新規スキーマ変更ではなく、現行リモート定義を migration へ
--   文書化するもの。create table if not exists で冪等。
--
-- Gotcha:
--   minutes_embeddings.embedding の次元数はリモート上の実定義を直接確認できないため
--   次元非指定の vector 型で正本化する。リモートに既存テーブルがある環境では
--   if not exists によりこの CREATE TABLE 自体は実行されない（実害なし）。
-- ============================================================================

create extension if not exists vector;

-- ----------------------------------------------------------------------------
-- user_styles: family 単位の文体プロファイル（案A・事前生成プロファイル注入の保存先）
-- ----------------------------------------------------------------------------
create table if not exists public.user_styles (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families(id) on delete cascade,
  profile            jsonb not null,
  source_minutes_ids uuid[] not null default '{}',
  last_updated_at    timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  unique (family_id)
);

create index if not exists user_styles_family_id_idx
  on public.user_styles (family_id);

alter table public.user_styles enable row level security;

drop policy if exists "user_styles_select" on public.user_styles;
create policy "user_styles_select" on public.user_styles
  for select to authenticated
  using (family_id = (auth.jwt() ->> 'family_id')::uuid);

drop policy if exists "user_styles_insert" on public.user_styles;
create policy "user_styles_insert" on public.user_styles
  for insert to authenticated
  with check (family_id = (auth.jwt() ->> 'family_id')::uuid);

drop policy if exists "user_styles_update" on public.user_styles;
create policy "user_styles_update" on public.user_styles
  for update to authenticated
  using (family_id = (auth.jwt() ->> 'family_id')::uuid)
  with check (family_id = (auth.jwt() ->> 'family_id')::uuid);

drop policy if exists "user_styles_delete" on public.user_styles;
create policy "user_styles_delete" on public.user_styles
  for delete to authenticated
  using (family_id = (auth.jwt() ->> 'family_id')::uuid);

-- ----------------------------------------------------------------------------
-- minutes_embeddings: pgvector 類似検索基盤（v1.1 では配線せず温存、match_documents() が参照）
-- ----------------------------------------------------------------------------
create table if not exists public.minutes_embeddings (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  minutes_id  uuid not null unique references public.minutes(id) on delete cascade,
  embedding   vector not null,
  created_at  timestamptz not null default now()
);

create index if not exists minutes_embeddings_family_id_idx
  on public.minutes_embeddings (family_id);

alter table public.minutes_embeddings enable row level security;

-- verb 別分割ポリシー（20260611010000_phase5b_with_check_hardening.sql で確定済の現行定義）
drop policy if exists "minutes_embeddings_all" on public.minutes_embeddings;
drop policy if exists "minutes_embeddings_select" on public.minutes_embeddings;
drop policy if exists "minutes_embeddings_insert" on public.minutes_embeddings;
drop policy if exists "minutes_embeddings_update" on public.minutes_embeddings;
drop policy if exists "minutes_embeddings_delete" on public.minutes_embeddings;

create policy "minutes_embeddings_select" on public.minutes_embeddings
  for select to authenticated
  using (family_id = (auth.jwt() ->> 'family_id')::uuid);

create policy "minutes_embeddings_insert" on public.minutes_embeddings
  for insert to authenticated
  with check (family_id = (auth.jwt() ->> 'family_id')::uuid);

create policy "minutes_embeddings_update" on public.minutes_embeddings
  for update to authenticated
  using (family_id = (auth.jwt() ->> 'family_id')::uuid)
  with check (family_id = (auth.jwt() ->> 'family_id')::uuid);

create policy "minutes_embeddings_delete" on public.minutes_embeddings
  for delete to authenticated
  using (family_id = (auth.jwt() ->> 'family_id')::uuid);

-- ----------------------------------------------------------------------------
-- ai_usage_log.endpoint に style-profile を追加（新規 endpoint も既存 quota 機構に通す）
-- ----------------------------------------------------------------------------
alter table public.ai_usage_log
  drop constraint if exists ai_usage_log_endpoint_check;

alter table public.ai_usage_log
  add constraint ai_usage_log_endpoint_check
  check (endpoint in (
    'format-item',
    'chat-stream',
    'whiteout-preview',
    'whiteout-apply',
    'style-profile'
  ));
