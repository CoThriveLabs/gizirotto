# minutes-app

Gizirotto（ぎじろっと）— 家族・少人数グループの議事録 AI アシスタントの Next.js 実装。

このドキュメントは **開発者向けのローカルセットアップガイド**です。アプリ全体の概要・コンセプトはリポジトリルートの [README.md](../README.md)、設計思想・技術詳細は [ARCHITECTURE.md](../ARCHITECTURE.md) を参照してください。

## ローカル開発時のサンプルデータ

`app/sample/` は `.gitignore` で除外されています。
個人情報を含む可能性のあるデータはローカルのみ保管し、**絶対に commit しないでください**。
`app/tmp/` 配下の検証中間成果物も全て除外対象です（PDF 内容が混入している可能性があるため安全側で全除外）。

フィクスチャ依存テスト・スクリプトは `sample/` が無い環境では自動 skip されます:

- `tests/integration/scan-extractor.test.ts` — `existsSync` + `MISTRAL_API_KEY` で skipIf
- `scripts/extraction-report-pdf.ts` — `SAMPLE_DIR` 未存在時は冒頭で return
- `scripts/` の検証系ユーティリティ — 開発者ローカルの 1-shot ツール。Vercel/CI ビルドには含まれない

push 前に以下を必ず実行してください:

```bash
node app/scripts/check-pushable.mjs
```

危険ファイル（.pdf / sample/ / tmp/ / secret / token 等）が staged に含まれていないかを検査します。

## データの取り扱い

過去の議事録や、ご家族の書き方の特徴は、**ご家族専用のデータとしてのみ保存します**。
他のご家族や、他の方には見られません。送信先の AI サービス（Anthropic / Mistral）のモデル学習にも使われません。

詳細は [PRIVACY.md](../PRIVACY.md) を参照してください。

## セットアップ

### 前提

- Node.js 20.x 以上
- pnpm 9.x 以上（`npm i -g pnpm@latest`）
- Supabase CLI（`pnpm dlx supabase --version`）
- LibreOffice（PDF 出力をローカル検証する場合）

### ローカル起動

```powershell
# プロジェクトルート（app/）に移動
cd <project-root>/app

# 依存インストール
pnpm install

# 環境変数ファイルを準備
Copy-Item .env.example .env.local
# .env.local の各値を埋める（ローカル supabase 起動後の出力値を貼る）
# PING_SECRET はローカル開発時は任意の固定値（例: test-secret-local）を設定
# → ping-check.mjs / route.ts の fallback と一致させる

# Supabase ローカル起動 + マイグレーション + シード適用
pnpm dlx supabase start
pnpm dlx supabase db reset
# → migrations/ 配下の baseline（20260526112403_remote_schema.sql）と
#   後続 migration 群が順次 apply され、seed.sql のデフォルトテンプレ 3 種も投入される

# 開発サーバ起動
pnpm dev
# → http://localhost:3000
```

### PING_SECRET の運用

`.env.local` に以下のように設定する（ローカル開発時）:

```
PING_SECRET=test-secret-local
```

- `.env.local` の placeholder（`replace_with_random_hex_32` 等）のまま使うと `pnpm ping-check` が 401 になる
- `scripts/ping-check.mjs` は `dotenv` で `.env.local` を読み込み、未設定時は `test-secret-local` を fallback として使う
- production / preview デプロイ時は `openssl rand -hex 32` で生成した値を Vercel 環境変数に登録する

### RLS integration テスト（手動実行）

```powershell
# 前提: pnpm dlx supabase start でローカル Supabase 起動済、db reset で migration 適用済
$env:SUPABASE_URL = "http://127.0.0.1:54321"
$env:SUPABASE_PUBLISHABLE_KEY = "<supabase status の anon/publishable key>"
$env:SUPABASE_SECRET_KEY = "<supabase status の service_role/secret key>"
pnpm test:integration
```

- `tests/integration/rls.test.ts` が 2 ユーザー × 2 family を作成し、cross-family SELECT が 0 件であることを検証
- ローカル Supabase 必須・node 環境・testTimeout 30 秒
- CI（GitHub Actions）には含めない方針。スキーマ変更時に手動で回す

### Supabase Cloud 接続（運営側で実施）

1. Supabase ダッシュボードで新規プロジェクト作成（region: Northeast Asia Tokyo）
2. Project Settings → API Keys で新形式キー（`sb_publishable_xxx` / `sb_secret_xxx`）を発行
3. Authentication → Hooks → Custom Access Token Hook を有効化、関数名 `public.custom_access_token_hook` を指定
4. リポジトリを Cloud プロジェクトにリンクし、`migrations/` 配下を一括適用:

   ```powershell
   pnpm dlx supabase login
   pnpm dlx supabase link --project-ref <project-ref>
   pnpm dlx supabase db push
   ```

5. SQL Editor で `supabase/seed.sql` を実行（builtin テンプレ 3 種を投入）
6. 環境変数を Vercel / `.env.local` に設定

## Migration 追加時の必須手順

DB スキーマと TypeScript 型を常に同期させ、`background_pdf_path` / `output_pdf_path` のような **「migration で列を足したのにアプリ側 INSERT/SELECT を忘れる」事故**をコンパイル時に検出できるようにする運用です。

新しい migration（`supabase/migrations/YYYYMMDDhhmmss_*.sql`）を追加したら、必ず以下の順で実行してください:

1. **ローカル supabase に migration を適用**

   ```powershell
   pnpm dlx supabase db reset   # ローカル DB をまっさらにして全 migration 再適用
   ```

2. **TypeScript 型を再生成**

   ```powershell
   pnpm types:gen               # ローカル supabase から生成（Docker 起動必須）
   ```

   Docker を起動したくない場合は `--linked` 版を使う:

   ```powershell
   # 初回のみ:
   pnpm dlx supabase login                              # PAT 発行 → ブラウザ認証
   pnpm dlx supabase link --project-ref <project-ref>  # Cloud プロジェクトに紐付け（Dashboard URL から取得）
   # 以降:
   pnpm types:gen:linked        # Cloud 側スキーマから型生成（Docker 不要）
   ```

3. **型チェックで齟齬を洗い出す**

   ```powershell
   pnpm typecheck
   ```

   `database.types.ts` を `createServerClient<Database>()` 等に渡して型強化していると、列追加忘れ・カラム名タイポ・型変更が **すべてここで赤くなる**。

4. **赤くなった箇所を修正してから commit**

   - 列追加忘れなら server action の INSERT に列を足す
   - SELECT で取った値の型ガードを更新する
   - 既存テストの fixture も型変更に追従させる

5. **`pnpm test` で回帰確認 → push 前に `node scripts/check-pushable.mjs`**

注意:

- `database.types.ts` は **自動生成ファイル**。手で編集しない（次回 `types:gen` で消える）
- migration 追加 PR では「`pnpm types:gen` 実行済 → `database.types.ts` の diff を同 commit に含める」のがレビューしやすい

## スクリプト

| コマンド | 内容 |
|---|---|
| `pnpm dev` | 開発サーバ（localhost:3000） |
| `pnpm build` | 本番ビルド |
| `pnpm start` | 本番起動 |
| `pnpm test` | Vitest ユニットテスト |
| `pnpm test:watch` | Vitest watch モード |
| `pnpm test:integration` | Vitest integration テスト（ローカル Supabase 必須・手動実行） |
| `pnpm typecheck` | `tsc --noEmit` で型チェック |
| `pnpm lint` | ESLint（Next.js 推奨設定） |
| `pnpm seed-storage` | builtin processed docx を生成 → Supabase Storage 投入 |
| `pnpm types:gen` | ローカル supabase から DB スキーマ → TypeScript 型生成（`src/lib/supabase/database.types.ts`） |
| `pnpm types:gen:linked` | リンク済み Cloud プロジェクトから型生成（Docker 不要、`supabase link` 済が前提） |
| `pnpm verify-font-bundle` | `pnpm build` 後に `.next/standalone` 配下に Noto Sans JP subset OTF が同梱されているか検証 |

## 環境変数

`.env.example` を参照。新形式 Supabase キー（`sb_publishable_xxx` / `sb_secret_xxx`）を採用。
旧 `anon` / `service_role` キーは 2026 年末に廃止予定のため使わない。

## アーキテクチャ概要

```
src/
├── app/
│   ├── (auth)/login/page.tsx                ログイン（マジックリンク）
│   ├── (dashboard)/                          ダッシュボード配下（議事録 / テンプレ / 設定）
│   ├── auth/callback/route.ts                Auth コールバック
│   ├── api/                                  Route Handlers（ping / templates / minutes 等）
│   ├── legal/                                利用規約・プライバシーポリシー
│   ├── layout.tsx / page.tsx                 ルート
│   └── globals.css
├── lib/
│   ├── supabase/{server,client,service}.ts   @supabase/ssr クライアント
│   ├── invite-code.ts                        nanoid(10) 家族コード生成
│   ├── parsers/                              docx / pdf テンプレ抽出
│   ├── pdf-output/                           PDF 生成・座標変換
│   ├── ai/                                   Claude / Mistral 連携
│   └── cloudconvert.ts                       docx → PDF 変換委託
├── server/
│   └── families.ts                           createFamily / joinFamily / regenerateInviteCode
└── middleware.ts                             Supabase セッションリフレッシュ
```

設計詳細はリポジトリルートの [ARCHITECTURE.md](../ARCHITECTURE.md) を参照。

## 整形方向性機能

- 4 テンプレ + 自由枠（50 字、`zod.string().max(50)` バリデート）
- 自由枠 UI には注意書きを必ず表示:

  > 自由枠に書く内容は事実改変も可能ですが、その結果はすべてあなたの責任です。
  > 家族エンタメ用途のみご利用ください（公的記録 NG）。

## 採用禁止ライブラリ

- `xlsx` (SheetJS) — CVE 未修正 + 有償移行
- `exceljs` — 2023/10 以降リリース停止
- `pdf-parse` — 2026 年公式 unmaintained
- `officegen` — legacy
- `html-docx-js` — テンプレ温存不可
- `docxtemplater` 有償拡張モジュール — v1 はコアのみ

## ライセンス

- コード本体: [MIT License](../LICENSE)
- 第三者依存ライセンス: [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md)
- バンドルフォント Noto Sans JP サブセット: SIL Open Font License 1.1（`public/fonts/OFL.txt`）
- キャラ画像（ぎじろっと）: [CC-BY-NC 4.0（商用利用不可）](./public/character/LICENSE.md) — コード本体の MIT とは別ライセンス
