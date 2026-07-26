-- 世帯単位の「書き方を学習する」ON/OFF トグル。
-- OFF の間はプロファイル生成・下書きへの注入の両方を止める（既定 ON = オプトアウト運用）。
alter table public.families
  add column if not exists style_learning_enabled boolean not null default true;
