-- ============================================================================
-- ai_usage_exceeded() 関数 (3 階層 atomic check の本体)
-- family / user / global を DB 関数 1 本に集約 (race condition 回避)
-- Q-α10 確定: 日次 cap $0.50/日 (月 $20 / 30 日 ≒ $0.667 から安全側)
-- 冪等: create or replace function
-- ============================================================================

create or replace function public.ai_usage_exceeded(
  p_family_id uuid,
  p_user_id   uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family_daily      int;
  v_family_cap_daily  int;
  v_user_hourly       int;
  v_user_cap_hourly   int;
  v_global_cost_today numeric;
  -- Q-α10 確定: global cap は cost ベース (回数ではなく $)
  -- 月 $20 / 30 日 ≒ $0.667/日 → 安全側 $0.50/日 (Console spend limit との二重防御)
  v_global_cost_cap_per_day constant numeric := 0.50;
begin
  -- 家族上限を取得
  select ai_calls_per_day, ai_calls_per_hour_user
    into v_family_cap_daily, v_user_cap_hourly
    from public.family_limits
    where family_id = p_family_id;

  -- limits 未設定: 上限不明として exceeded=true (保守的に止める)
  if v_family_cap_daily is null then
    return jsonb_build_object(
      'exceeded', true,
      'scope', 'unknown',
      'reason', 'no_family_limits'
    );
  end if;

  -- 家族 1 日上限 check
  select count(*) into v_family_daily
    from public.ai_usage_log
    where family_id = p_family_id
      and created_at > now() - interval '1 day';
  if v_family_daily >= v_family_cap_daily then
    return jsonb_build_object(
      'exceeded', true,
      'scope', 'family',
      'used', v_family_daily,
      'cap',  v_family_cap_daily,
      'reset_at', date_trunc('day', now()) + interval '1 day'
    );
  end if;

  -- ユーザー 1 時間上限 check
  select count(*) into v_user_hourly
    from public.ai_usage_log
    where user_id = p_user_id
      and created_at > now() - interval '1 hour';
  if v_user_hourly >= v_user_cap_hourly then
    return jsonb_build_object(
      'exceeded', true,
      'scope', 'user',
      'used', v_user_hourly,
      'cap',  v_user_cap_hourly,
      'reset_at', date_trunc('hour', now()) + interval '1 hour'
    );
  end if;

  -- 全体 1 日上限 check (cost ベース)
  select coalesce(sum(cost_usd_estimate), 0) into v_global_cost_today
    from public.ai_usage_log
    where created_at > date_trunc('day', now());
  if v_global_cost_today >= v_global_cost_cap_per_day then
    return jsonb_build_object(
      'exceeded', true,
      'scope', 'global',
      'used_cost', v_global_cost_today,
      'cap_cost',  v_global_cost_cap_per_day,
      'reset_at', date_trunc('day', now()) + interval '1 day'
    );
  end if;

  return jsonb_build_object('exceeded', false);
end;
$$;

-- service_role からのみ呼出可。API route の service client 経由のみ。
-- 既存 grant を一度 revoke してから再度 grant することで冪等化。
revoke all on function public.ai_usage_exceeded(uuid, uuid) from public;
grant execute on function public.ai_usage_exceeded(uuid, uuid) to service_role;
