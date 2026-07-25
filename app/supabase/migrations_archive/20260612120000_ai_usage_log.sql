-- ============================================================================
-- ai_usage_log (実値・集計用テーブル)
-- 上限 (family_limits) と実値 (ai_usage_log) は別テーブル分離
-- 冪等: create table if not exists / create index if not exists / drop policy if exists
-- ============================================================================

create table if not exists public.ai_usage_log (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid references public.families(id) on delete cascade,
  user_id           uuid references auth.users(id) on delete set null,
  endpoint          text not null check (endpoint in (
                       'format-item',
                       'chat-stream',
                       'whiteout-preview',
                       'whiteout-apply'
                    )),
  input_tokens      int default 0,
  output_tokens     int default 0,
  cost_usd_estimate numeric(10,6) default 0,
  created_at        timestamptz not null default now()
);

-- 3 階層 atomic check 用のインデックス (family / user / global それぞれの集計を支える)
create index if not exists ai_usage_log_family_created_idx
  on public.ai_usage_log (family_id, created_at desc);
create index if not exists ai_usage_log_user_created_idx
  on public.ai_usage_log (user_id, created_at desc);
create index if not exists ai_usage_log_global_created_idx
  on public.ai_usage_log (created_at desc);

alter table public.ai_usage_log enable row level security;

-- 家族メンバーは自家族のログのみ閲覧可 (残数表示用)
drop policy if exists "family members read own family ai log" on public.ai_usage_log;
create policy "family members read own family ai log"
  on public.ai_usage_log for select
  using (
    family_id in (
      select family_id from public.family_members
      where user_id = auth.uid()
    )
  );

-- INSERT は service role のみ (RLS bypass)。公開クライアントから書けない。
-- 明示的に anon / authenticated の INSERT を拒否する policy は不要 (default deny で十分)。
