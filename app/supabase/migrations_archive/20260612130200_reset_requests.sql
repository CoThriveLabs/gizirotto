-- ============================================================================
-- reset_requests + JST 当日判定 RPC
-- 冪等
-- 1 家族 1 日 1 回。当日境界はサーバ TZ 非依存・DB 側で Asia/Tokyo 評価。
-- ============================================================================

create table if not exists public.reset_requests (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists reset_requests_family_created_idx
  on public.reset_requests (family_id, created_at desc);

alter table public.reset_requests enable row level security;

-- 家族メンバーは自家族の依頼履歴を read 可 (usage section の「本日依頼済み」表示用)
drop policy if exists "family members read own reset requests" on public.reset_requests;
create policy "family members read own reset requests"
  on public.reset_requests for select
  using (
    family_id in (
      select family_id from public.family_members where user_id = auth.uid()
    )
  );
-- INSERT は service role のみ (request-reset route 経由)。

-- ★ v0.3 修正2 (Q-γ2 確定: JST 0:00 起点)
--   1 家族 1 日 1 回判定を DB 側で Asia/Tokyo 評価。サーバ TZ 非依存。
--   route から svc.rpc('reset_request_exists_today_jst', { p_family_id }) で呼ぶ。
create or replace function public.reset_request_exists_today_jst(p_family_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists(
    select 1 from public.reset_requests
     where family_id = p_family_id
       and created_at >= date_trunc('day', now() at time zone 'Asia/Tokyo')
                          at time zone 'Asia/Tokyo'
  );
$$;
grant execute on function public.reset_request_exists_today_jst(uuid)
  to authenticated, service_role;
