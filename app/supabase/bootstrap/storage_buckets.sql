-- storage bucket bootstrap（migration には含めない・新規プロジェクトへ個別実行する）
-- outputs と imports はコード上未参照だが本番に実在するため保持する。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('templates_raw', 'templates_raw', false, null, null)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('templates_processed', 'templates_processed', false, null, null)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('outputs', 'outputs', false, null, null)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('imports', 'imports', false, null, null)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('minutes_output', 'minutes_output', false, null, null)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('image_cache', 'image_cache', false, null, null)
on conflict (id) do nothing;
