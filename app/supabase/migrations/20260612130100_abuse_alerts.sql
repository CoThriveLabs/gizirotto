-- ============================================================================
-- abuse_alerts + pg_cron (5 分集計 / spend 日次)
-- 冪等 / 閾値は SQL 内定数・ログに持たせない
-- abuse_alerts への INSERT を Database Webhook で notify-mail に飛ばす (手動設定)。
-- ============================================================================

create table if not exists public.abuse_alerts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete set null,
  pattern    text not null,        -- 'high_frequency' | 'signup_flood' | 'spend_80pct'
  detail     jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.abuse_alerts enable row level security;
-- 公開 read / INSERT policy なし。service role / pg_cron のみが INSERT。

-- pg_cron 拡張は Supabase Dashboard で有効化済み前提 (無料枠で利用可)。
-- 冪等: 同名 job があれば unschedule してから schedule。

do $$
begin
  perform cron.unschedule('detect-abuse-5min');
exception when others then null;
end $$;

select cron.schedule(
  'detect-abuse-5min',
  '*/5 * * * *',
  $$
  -- (1) AI 異常 burst: 5 分以内 同一 user 30 件超
  insert into public.abuse_alerts (user_id, pattern, detail)
  select user_id, 'high_frequency',
         jsonb_build_object('count', count(*), 'window', '5min')
    from public.ai_usage_log
    where created_at > now() - interval '5 minutes'
      and user_id is not null
    group by user_id
    having count(*) > 30;

  -- (2) signup 連投: 5 分以内 同一 IP 3 件超
  insert into public.abuse_alerts (user_id, pattern, detail)
  select null, 'signup_flood',
         jsonb_build_object('ip', ip, 'count', count(*), 'window', '5min')
    from public.signup_attempts
    where created_at > now() - interval '5 minutes'
      and ip is not null
    group by ip
    having count(*) > 3;
  $$
);

-- spend 80% 接近の日次検知 (健全時の日次サマリは送らない・α9)。
-- ★ v0.3 修正1 (月内ループ防止): 当月に spend_80pct を 1 通送っていたら抑止。
do $$
begin
  perform cron.unschedule('detect-spend-80pct');
exception when others then null;
end $$;

select cron.schedule(
  'detect-spend-80pct',
  '0 0 * * *',  -- UTC 0:00 = JST 9:00・1 日 1 回
  $$
  insert into public.abuse_alerts (user_id, pattern, detail)
  select null, 'spend_80pct',
         jsonb_build_object(
           'cost_month_to_date', s.cost,
           'cap_monthly', 20,
           'pct', round((s.cost / 20.0) * 100, 1)
         )
    from (
      select coalesce(sum(cost_usd_estimate), 0) as cost
        from public.ai_usage_log
        where created_at > date_trunc('month', now())
    ) s
    where s.cost >= 16  -- $20 x 80%
      and not exists (
        select 1 from public.abuse_alerts
         where pattern = 'spend_80pct'
           and created_at > date_trunc('month', now())
      );
  $$
);
