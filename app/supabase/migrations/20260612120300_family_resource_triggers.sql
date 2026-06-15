-- ============================================================================
-- リソース上限の DB トリガ (議事録 / テンプレ)
-- 議事録 INSERT 前 check / テンプレ INSERT 前 check
-- 既存議事録の created_at が今月以前 → 今月 cap に含まれない
--      (max_minutes_monthly は date_trunc('month') 基準)
-- 冪等: create or replace function / drop trigger if exists
-- ============================================================================

-- 議事録 INSERT 前: 当月件数が max_minutes_monthly に達していたら拒否
create or replace function public.check_minutes_monthly_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
  v_cap  int;
begin
  -- limits 未設定なら通す (保守的・既存ユーザー保護)
  select max_minutes_monthly into v_cap
    from public.family_limits where family_id = new.family_id;
  if v_cap is null then
    return new;
  end if;

  -- 当月の議事録件数を集計 (created_at が今月のもののみ)
  select count(*) into v_used from public.minutes
    where family_id = new.family_id
      and created_at >= date_trunc('month', now());

  if v_used >= v_cap then
    raise exception '議事録の今月上限（%）に達しました', v_cap
      using errcode = 'P0001',
            hint    = 'family_resource_limit';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_minutes_monthly_limit on public.minutes;
create trigger trg_minutes_monthly_limit
  before insert on public.minutes
  for each row execute function public.check_minutes_monthly_limit();


-- テンプレ INSERT 前: 累積件数が max_templates に達していたら拒否
create or replace function public.check_templates_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
  v_cap  int;
begin
  -- builtin (family_id is null) は上限対象外
  if new.family_id is null then
    return new;
  end if;

  select max_templates into v_cap
    from public.family_limits where family_id = new.family_id;
  if v_cap is null then
    return new;
  end if;

  select count(*) into v_used from public.templates
    where family_id = new.family_id;

  if v_used >= v_cap then
    raise exception 'テンプレ累積上限（%）に達しました', v_cap
      using errcode = 'P0001',
            hint    = 'family_resource_limit';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_templates_limit on public.templates;
create trigger trg_templates_limit
  before insert on public.templates
  for each row execute function public.check_templates_limit();
