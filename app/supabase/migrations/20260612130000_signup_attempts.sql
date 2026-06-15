-- ============================================================================
-- signup_attempts (初回 magic link 送信の IP 記録)
-- 冪等 / 実値ログとして閾値は持たせない
-- PII 配慮: メール全体は保存せず email_domain (@ 以降) のみ。公開 read なし。
-- ============================================================================

create table if not exists public.signup_attempts (
  id           uuid primary key default gen_random_uuid(),
  ip           text,
  email_domain text,
  created_at   timestamptz not null default now()
);

create index if not exists signup_attempts_ip_created_idx
  on public.signup_attempts (ip, created_at desc);

alter table public.signup_attempts enable row level security;
-- 公開 read / INSERT policy なし。service role のみが RLS bypass で INSERT。
