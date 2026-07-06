# Architecture — Gizirotto（ぎじろっと）

このドキュメントは Gizirotto の技術構成・設計思想・主要な設計判断をまとめたものです。
プロジェクトの概要・触り方は [README.md](./README.md) を参照してください。

---

## 1. アプリ概要

Gizirotto（ぎじろっと）は、家族や少人数グループの議事録を AI が下書き・整形するアプリです。

一般的な議事録 SaaS が「会社の会議」を主対象にするのに対し、Gizirotto は **家族・少人数の議事録** という独自スコープに振り切っています。家族会議・月例ミーティング・子どもの予定共有・家計報告といった、形式が緩く継続的に積み重なる議事録を対象にしています。

主要なユースケースは次の流れです。

1. テンプレートを選ぶ（家族会議 / 子の予定 / 家計報告などの組み込みテンプレ、または独自テンプレ）
2. 議事録を記入する（チャット形式の AI 支援、または手動入力）
3. AI がテンプレートの書式に沿って整形する
4. WYSIWYG エディタでレイアウトを微調整し、PDF として出力する

過去の議事録から、その家庭ならではの「書き方の癖」を反映した下書きを返す機能は、v1.1 で提供予定です。現状の整形はテンプレート書式への清書までを担います。本アプリは、家族や少人数グループでの家庭利用を想定しています。

---

## 2. 技術スタック

| 層 | 技術 |
|---|---|
| フロントエンド | Next.js 15（App Router）/ React 19 / TypeScript / Tailwind CSS |
| バックエンド | Next.js Server Actions / Route Handlers / Supabase Edge Functions（Deno）|
| DB / 認証 / ストレージ | Supabase（PostgreSQL + Row Level Security + Auth + Storage）|
| AI | Claude（議事録整形・チャット支援）/ Mistral OCR（スキャン PDF の文字抽出）|
| PDF 処理 | pdfjs-dist（解析・ラスタライズ）/ pdf-lib（焼き込み）/ @napi-rs/canvas（サーバ描画）/ tesseract.js（OCR フォールバック）|
| Word 処理 | mammoth（docx → HTML）/ docxtemplater（docx 出力）|
| フォント | Noto Sans JP（サブセット・SIL OFL 1.1）|
| レート制御 | Upstash Redis（Cloudflare Turnstile 併用）|
| メール | Resend（認証メール・通知メール送信）|
| ホスティング | **Vercel のみ（GitHub Pages は非利用）** |

ホスティングは Vercel のみで、GitHub Pages は使いません。Next.js の Server Actions・Route Handlers・Edge Functions をそのまま動かすサーバーレス実行環境が必要なためです。

---

## 3. アーキテクチャ全体図

責務ごとにディレクトリを分離しています。主要なレイヤは次の通りです。

```
src/
├── app/            ルーティング・ページ・Server Actions・Route Handlers
│   ├── (auth)/     ログイン・サインアップ（route group）
│   ├── (dashboard)/ 認証必須ページ群（テンプレ管理・議事録編集）
│   ├── (home)/     ホーム
│   ├── family/ members/ settings/  家族・メンバー・設定
│   └── api/        Route Handlers（ヘルスチェック・PDF 処理 API 等）
├── server/         サーバサイドのドメインロジック（家族・議事録）
├── lib/
│   ├── parsers/    PDF / Word 解析（解析 → 中間表現の抽出）
│   ├── pdf-output/ PDF 焼き込み出力（座標確定・フィッティング）
│   ├── ai/         プロンプト設計・構造化出力・コスト最適化
│   ├── copyright/  利用規約・ライセンス文言
│   ├── errors/     ユーザー向けエラーメッセージ変換
│   └── supabase/   client（ブラウザ）/ server（RSC）/ service（サーバ専用）
├── components/     UI 部品（チャット・プレビュー・トースト等）
└── hooks/          custom hooks
supabase/           migrations（RLS ポリシー）・Edge Functions
```

データフローの中心は「ユーザー入力 → Server Action / Route Handler → AI・PDF パイプライン → Supabase → クライアントのプレビュー」です。PDF のプレビュー描画はブラウザ側で、最終出力の焼き込みはサーバ側で行います（§5 参照）。

> 移設予定の注記: ブラウザプレビュー用の合成描画モジュール（`*-composite-canvas.ts`）は現状 `lib/parsers/pdf/` 配下にあります。将来的にプレビュー専用ディレクトリへの移設を計画しています。本ドキュメントは現時点の配置を記述しています。

---

## 4. 座標の真実マップ（設計の核）

Gizirotto の技術的な肝は **座標変換の一元管理** です。

PDF とブラウザ表示・画像描画では座標系が異なります。

- 単位: PDF はポイント（pt）、画面・ラスタ画像はピクセル（px）
- 原点: PDF は左下原点、画面・Canvas は左上原点

この pt ⇔ px・上下反転を含む変換式を**複数箇所に散らさず 1 モジュールに集約**し、式のドリフト（場所ごとに微妙に違う変換が生まれること）を禁止する、という不変条件を設計の中心に置いています。

| モジュール | 責務 |
|---|---|
| `parsers/pdf/whiteout-coords.ts` | 座標変換の真実（pt/px・原点反転）を集約する純関数 |
| `pdf-output/bbox-coords.ts` | 出力 PDF 上の bbox（テキスト領域）座標の確定 |
| `pdf-output/fitting.ts` | テキストを bbox に収めるフィッティング計算 |
| `pdf-output/rule-based-snap.ts` | フィールド領域のルールベース・スナップ |
| `pdf-output/uniform-size.ts` | フォントサイズの均一化 |

**なぜ重要か**: 座標のずれは、個人情報を隠す白塗りのずれに直結します。白塗りが 1mm ずれれば、隠すべき情報が露出したり、逆に必要な文字が消えたりします。だからこそ変換式を 1 箇所に集約し、解析・プレビュー・出力のすべてが同じ式を参照する設計にしています。

---

## 5. サーバ・クライアント 2 本立て描画

同じ「合成描画」に 2 つの実装が存在します。これは重複ではなく、意図的な設計です。

| モジュール | 役割 | 描画 API |
|---|---|---|
| `parsers/pdf/whiteout-composite.ts` | サーバ側の焼き込み（最終 PDF 出力用） | `@napi-rs/canvas`（ネイティブ） |
| `parsers/pdf/whiteout-composite-canvas.ts` | ブラウザプレビュー（WYSIWYG 編集用） | ブラウザの Canvas2D |

両者は座標式を `whiteout-coords.ts` の純関数で**共有**し、**描画 API だけ**を分けています。

**なぜ 2 本立てか**: `@napi-rs/canvas` はサーバ専用のネイティブモジュールで、クライアントバンドルに混ぜるとビルドが壊れます。バンドル汚染を避けるため、共通ロジックは純関数に切り出したうえで、描画の入口だけをサーバ用とブラウザ用に分離しています。座標計算という最も間違えやすい部分を共有しているため、プレビューと最終出力が食い違わないことが保証されます。

---

## 6. エディタの状態統合と責務分離

WYSIWYG エディタの中核は、複数レイヤ（フィールド・白塗り・固定テキスト）・undo/redo・ズーム・ドラッグが密に連動する「状態統合点」です。純粋なロジック（座標計算・フィッティング・スナップ）は `lib/` 層に分離済みで、ビューは custom hooks（`src/hooks/editor/`）に段階的に切り出して整理しました。状態の集約点としてのまとまりを保ちつつ、ロジックとビューの責務分離ができています。

---

## 7. データモデル

主要テーブルと関係は次の通りです（実スキーマは `supabase/migrations/` が正本です）。

| テーブル | 役割 |
|---|---|
| `families` | 家族（世帯）。データ分離の単位 |
| `family_members` | 家族メンバー（ユーザーと家族の関連）|
| `minutes` | 議事録本体 |
| `minutes_embeddings` | 議事録の埋め込みベクトル（類似検索用）|

テンプレート・処理済み PDF・サムネイル等は Storage と関連テーブルで管理しています。

**行レベルセキュリティ（RLS）**: すべてのデータは家族（世帯）単位で物理的に分離しています。認証トークン（JWT）に `family_id` を埋め込み、PostgreSQL の Row Level Security ポリシーで「自分の家族のデータしか SELECT できない」ことを DB レベルで保証します。アプリ側のうっかりミスでは他世帯のデータに到達できません。

議事録には作成経路を示す内部値を持たせています（テンプレ選択経由 / 手動入力経由など）。値の意味はアプリ層で解釈し、表示時に読者向けの文言へ変換します。

---

## 8. セキュリティ設計

Gizirotto は家庭の個人情報（家族構成・予定・家計など）を扱うため、認証・入力検証・API 保護・レスポンスヘッダの各レイヤで多層防御を組んでいます。以下は現時点の実装を層ごとに整理したものです。

### 8.1 認証・認可（世帯単位のデータ分離）

- Supabase Auth + Row Level Security（RLS）により、世帯（`family_id`）単位のデータ分離を **DB レイヤーで強制**しています。アプリ側のロジックミスがあっても、他世帯のデータには到達できません。
- policy は verb（SELECT / INSERT / UPDATE / DELETE）別に個別定義しています。`FOR ALL` の 1 本化は UPDATE / INSERT の post-condition（更新後の値チェック）を縛れないため避け、判定式は一貫して `family_id = (auth.jwt() ->> 'family_id')::uuid` を使っています。UPDATE policy は `USING`（更新前行の可視性）と `WITH CHECK`（更新後行の許可）の両方を指定し、別世帯の `family_id` へ書き換える詐取攻撃を防いでいます。
- `family_id` は Supabase の `custom_access_token_hook` により JWT claims へ注入されます。クライアントは `auth.getUser()` で署名検証済みの session から `access_token` を取得し、そのペイロードを base64url decode して自世帯の `family_id` のみを取り出します。
- なお `user.app_metadata` は使いません。これは `raw_app_meta_data` 列の中身であり、hook の注入先（JWT claims）とは別管理のためです。
- アカウント削除時は、DB 側は外部キー CASCADE で関連行を連鎖削除し、Storage 側は 4 bucket（`templates_raw` / `templates_processed` / `image_cache` / `minutes_output`）を明示的に全削除します。削除フローは世帯構成に応じて 3 ケースに分岐します（唯一メンバーの場合は世帯ごと全削除／他メンバーがいる唯一の管理者の場合はブロックして退会させない／他メンバーがいる一般メンバーの場合は自分の関連データのみ削除し共有データは保持）。ケース判定はクライアント申告を信用せず、サーバ側で再検証します。

### 8.2 Bot 対策

- 認証・ゲスト経路に Cloudflare Turnstile（invisible widget）を配置しています。
- フロントのトークンだけを信用せず、サーバ側で Cloudflare の siteverify API による再検証を行う二段検証構成です。
- テストキーのハードコードやフォールバックは実装していません。`TURNSTILE_SECRET_KEY` が未設定の環境（ローカル開発など）では検証を skip する設計です。本番運用では Vercel の環境変数に `TURNSTILE_SECRET_KEY` を必ず設定し、検証が有効化された状態で稼働させる運用を前提としています。テストキーへの自動フォールバックは意図的に排除しています。

### 8.3 API 過剰利用・DoS 対策

- **quota チェック**: `ai_usage_exceeded` RPC で world / family / user の 3 階層から AI 呼び出し回数を確認します。RPC 呼び出し自体が失敗した場合は **fail-closed**（ブロック側に倒す）とし、公開後の暴走課金を防いでいます。
- **レート制限**（Upstash Redis の sliding window、独立した 3 種類）:
  - バースト制限: 既定 10 req / 10s / IP（middleware で `/api/*` 全経路に適用）
  - ゲスト AI daily 制限: 既定 20 req / 1d / IP（AI 呼び出し暴発防御・DoS 対策。議事録 1 件あたり約 10 request × 2 件分を想定）
  - ゲスト議事録件数制限: 既定 2 件 / 1d / IP（無限試用の防止。AdjustView 到達時に 1 回消費）
  - 既定値は環境変数（`GUEST_AI_DAILY_LIMIT_COUNT` / `GUEST_AI_DAILY_LIMIT_WINDOW` / `GUEST_TEMPLATE_LIMIT_COUNT` / `GUEST_TEMPLATE_LIMIT_WINDOW` 等）で調整可能です。
- **本番未設定時は fail-closed**: 本番ランタイムで Upstash の環境変数が未設定の場合は起動時にエラーで落とし、silent にレート制限なしへフォールバックしない設計です（開発・CI 環境では noop として動作し、既存挙動を壊しません）。
- **CORS**: `ALLOWED_ORIGINS` で許可オリジンを明示し、未設定であれば許可オリジン無し（fail-safe）として扱います。
- **不正シグナル記録**: `signup_attempts` / `abuse_alerts` / `reset_requests` テーブルで、不審なサインアップやリソース作成の兆候を追跡します。
- **AI 使用量ログ**: `ai_usage_log` に endpoint・入力/出力トークン数・推定コストを記録し、事後監査を可能にしています。

### 8.4 セキュリティヘッダ

`next.config.mjs` の `headers()` で全レスポンスに以下を付与しています。

- HSTS（`Strict-Transport-Security`）
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`
- `Content-Security-Policy` は現在 Report-Only（`Content-Security-Policy-Report-Only`）で本番稼働中です。違反レポートを一定期間観測したうえで、強制モードへ昇格する移行計画です。

### 8.5 その他

- API キー・シークレット・接続情報はすべて `.env` 経由で管理し、コードへの直書きはありません。
- 依存パッケージの更新は Dependabot（monthly + セキュリティ更新のみ）で行っています。
- 脆弱性報告の窓口は GitHub の Private Vulnerability Reporting、または contact 用メールです（[SECURITY.md](./.github/SECURITY.md)）。

---

## 9. AI 利用ガイド

- **プロンプト設計**: 用途別（チャット支援・整形など）にプロンプトを分離して管理しています。
- **構造化出力**: Claude の構造化出力を使い、議事録フィールドを安定した形式で取得します。
- **コスト効率重視**: 無料枠・低コストの選択肢を優先する設計判断を一貫して取っています。
- **第三者 AI へのデータ送信**: 議事録テキストは整形・OCR のため Claude（Anthropic）・Mistral に送信されます。送信データの取り扱いは各社の API 規約に従い、モデル学習には使われません。詳細は [PRIVACY.md](./PRIVACY.md) を参照してください。

API キーや環境変数の実値はリポジトリに含めません。`.env.example` をコピーして各自で設定します。

---

## 10. 開発・公開ポリシー

- **Issue 対応**: best-effort（個人開発のため SLA はありません）。
- **外部 Pull Request**: 現状は受け付けていません（[CONTRIBUTING.md](./.github/CONTRIBUTING.md) 参照）。
- **依存更新**: Dependabot による monthly の更新 + セキュリティ更新のみ。
- **監視**: 専用の監視基盤は**導入しません**（個人 PF としての割り切り）。
- **ホスティング**: **Vercel のみ・GitHub Pages 非利用**。
- **ライセンス**: コードは [MIT](./LICENSE)。キャラクター画像は [CC-BY-NC 4.0](./app/public/character/LICENSE.md)（非商用利用のみ）。第三者依存は [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) を参照。
- **プライバシー**: 取得する個人情報・第三者提供先・開示請求窓口は [PRIVACY.md](./PRIVACY.md) を参照。
- **Cookie の利用範囲**: ログインセッション Cookie のみ。Vercel Analytics / Speed Insights は未導入のため、行動追跡・解析 Cookie は使用しません（同意 banner は不要）。

---

## 関連ドキュメント

- [README.md](./README.md) — プロジェクト概要
- [LICENSE](./LICENSE) — MIT
- [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) — 第三者依存ライセンス
- [public/character/LICENSE.md](./app/public/character/LICENSE.md) — キャラクター画像ライセンス（CC-BY-NC 4.0）
- [.github/SECURITY.md](./.github/SECURITY.md) — 脆弱性報告
- [.github/CONTRIBUTING.md](./.github/CONTRIBUTING.md) — コントリビュート方針
