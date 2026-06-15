-- ============================================================================
-- family_limits (上限マスタテーブル)
-- 上限値マスタを ai_usage_log と完全分離
-- Q-α1 確定値:
--   - 家族 1 日 30 回 (ai_calls_per_day)
--   - ユーザー 1 時間 10 回 (ai_calls_per_hour_user)
-- Q-α3 確定値:
--   - 議事録 100/月 / テンプレ 50 / Storage 500MB
-- 冪等: create table if not exists / drop policy if exists / on conflict do nothing
-- ============================================================================

create table if not exists public.family_limits (
  family_id              uuid primary key references public.families(id) on delete cascade,
  -- AI (Q-α1 確定)
  ai_calls_per_day       int    not null default 30,
  ai_calls_per_hour_user int    not null default 10,
  -- リソース (Q-α3 確定)
  max_minutes_monthly    int    not null default 100,
  max_templates          int    not null default 50,
  max_storage_bytes      bigint not null default 524288000,  -- 500MB
  updated_at             timestamptz not null default now()
);

alter table public.family_limits enable row level security;

-- 家族メンバーは自家族の上限のみ閲覧可 (残数表示用)
drop policy if exists "family members read own family limits" on public.family_limits;
create policy "family members read own family limits"
  on public.family_limits for select
  using (
    family_id in (
      select family_id from public.family_members
      where user_id = auth.uid()
    )
  );

-- 既存家族に default 値を投入 (migration で行う・seed.sql 不可)。
-- 既存議事録の created_at は今月以前 → 今月 cap 計算 (max_minutes_monthly) に含まれない
-- ため migration 直後に上限超過事故は起きない。
insert into public.family_limits (family_id)
  select id from public.families
  on conflict (family_id) do nothing;

-- 家族新規作成時に自動で limits を作る trigger
create or replace function public.create_family_limits_on_family_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.family_limits (family_id) values (new.id)
    on conflict (family_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_family_limits_autocreate on public.families;
create trigger trg_family_limits_autocreate
  after insert on public.families
  for each row execute function public.create_family_limits_on_family_insert();
