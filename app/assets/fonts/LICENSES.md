# Fonts Licenses

本ディレクトリに配置されているフォントファイルのライセンスと出典を明記する。

---

## Noto Sans CJK JP / Noto Sans JP

| 項目 | 内容 |
|---|---|
| 配布ライセンス | SIL Open Font License, Version 1.1 (OFL-1.1) |
| 著作権者 | Copyright 2014-2021 Adobe (https://www.adobe.com/), with Reserved Font Name "Source". Copyright 2014-2021 Google LLC. |
| 公式配布元 | https://fonts.google.com/noto/specimen/Noto+Sans+JP / https://github.com/notofonts/noto-cjk |
| ライセンス全文 | https://openfontlicense.org/open-font-license-official-text/ |
| 加工内容 | `pyftsubset`（fontTools）で日本語常用 約 3000 字に subset 化（`NotoSansJP-Regular.subset.otf`） |
| 用途 | 議事録 PDF / 画像出力時の日本語埋め込み（pdf-lib `embedFont`）|

### 加工フォントファイル

- `NotoSansJP-Regular.otf` — 原本（git 管理外、ローカル `pnpm download-font` で取得）
- `NotoSansJP-Regular.subset.otf` — pyftsubset で 3000 字 subset 済（約 1.4 MB、**`public/fonts/` に git commit 済 / Vercel 同梱用**）
- `NotoSansJP-Regular.ttf` — フォールバック原本（5.3 MB、git 管理外）

### OFL-1.1 主要条項（要約、原文優先）

1. **再配布可**: 単独でも他ソフトウェアに同梱しても配布可
2. **販売禁止**: フォントそのものの販売は不可（本アプリへの同梱は OK）
3. **改変版は別名必須**: 加工版を「Noto Sans JP」と同名で再配布してはならない（本リポジトリ内のサブセット版は `.subset` サフィックスで識別）
4. **ライセンス文同梱必須**: 本ファイル（または OFL.txt）を配布物に含める
5. **保証なし**: 無保証で提供される

### SIL OFL 1.1 原文

公式原文は `public/fonts/OFL.txt` に同梱している。

- 原文: https://openfontlicense.org/open-font-license-official-text/
- 日本語参考訳（非公式）: https://scripts.sil.org/OFL_web

---

## 表示義務（アプリ側）

- アプリ内「ライセンス」画面に Noto Sans JP の OFL-1.1 表記を掲載
- README に同等の記載

---

運営: Co-Thrive Labs
