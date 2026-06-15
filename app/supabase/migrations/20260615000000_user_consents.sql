-- ============================================================================
-- Phase 8 公開前必須 — user_consents (利用規約・プライバシーポリシー同意記録)
-- 設計: 初回ログイン時の同意モーダル取得結果を保存。
-- バージョン管理により、規約改定時の再同意トリガーに用いる。
-- ============================================================================

create table if not exists public.user_consents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  terms_version   text not null,
  privacy_version text not null,
  consented_at    timestamptz not null default now(),
  ip_address      text
);

-- 直近の同意レコードを高速参照するための index。
create index if not exists user_consents_user_id_consented_at_idx
  on public.user_consents (user_id, consented_at desc);

alter table public.user_consents enable row level security;

-- SELECT: 自分のレコードのみ。
drop policy if exists user_consents_select_own on public.user_consents;
create policy user_consents_select_own
  on public.user_consents
  for select
  using (auth.uid() = user_id);

-- INSERT: 認証済みユーザー自身のみ。
drop policy if exists user_consents_insert_own on public.user_consents;
create policy user_consents_insert_own
  on public.user_consents
  for insert
  with check (auth.uid() = user_id);
