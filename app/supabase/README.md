# Supabase migration 運用方針

## baseline + tombstone 構成

- 最古の migration ファイル `migrations/20260526112403_remote_schema.sql` が本番 schema の baseline（sanitize 済み）を保持する。`supabase db reset` はこのファイルからゼロ再構築できる。
- 以降のスキーマ変更は新規 migration ファイルとして `migrations/` 配下に追加していく。
- baseline より新しい過去の個別 migration ファイルは tombstone 化されている（ファイル名・タイムスタンプは本番の適用履歴と整合させるためそのまま残し、中身のみ「統合済み」コメント 1 行に置き換え済み）。原本は `migrations_archive/` に同名で退避してある。

## baseline から除外した内容

- **notify-abuse-alerts の Database Webhook トリガー**: service_role JWT を含むため公開リポには含めない。環境ごとに Supabase Dashboard の Database Webhooks から個別に再作成すること。
- **pg_cron 拡張**: 本番で未使用（`cron.job` 0 件）のため baseline から除外した。将来必要になれば Dashboard から有効化すること。

## 今後の整理対象

- **pg_net 拡張**: baseline に残存しているが現状未使用。次回スキーマ整理時に要不要を確認すること。

## storage bucket

`bootstrap/storage_buckets.sql` は migration には含めない。新規プロジェクトを立てた際に個別に流すこと。

## custom_access_token_hook

`custom_access_token_hook` 関数自体は migration に含まれるが、Auth Hook としての有効化は Supabase Dashboard の設定のため migration には含まれない。新規環境では Dashboard の Auth Hooks から個別に有効化が必要。
