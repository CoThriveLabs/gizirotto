/**
 * FieldSemanticExtractor 用プロンプト。
 *
 * 入力構成（3 入力）:
 *   1. Mistral OCR markdown（構造抽出: 見出し / 段落 / 箇条書き）
 *   2. Mistral OCR tables HTML（colspan/rowspan 保持、format='html'）
 *   3. Tesseract.js bbox 付き word リスト（座標源）
 *
 * 重要な制約:
 *   - 座標（bbox）は変更せず、入力 JSON の座標をそのまま使用
 *   - PDF 編集ツール透かしは既に除外済（パイプライン位置で除外）
 */

export const SYSTEM_PROMPT_PDF_STRUCTURE = `\
あなたは家族議事録テンプレート（PDF）のレイアウト構造解析エージェントです。
入力された raw layout（Mistral OCR markdown + tables HTML + Tesseract.js bbox 付き word リスト）から、議事録の項目構造を抽出してください。

## 重要な制約

1. **座標は捏造せず、必ず入力 JSON の word 座標を根拠に bbox を作成してください**
   （存在しない座標を発明しない。記入欄の bbox も入力 word の座標から導出する）
2. 各 field に対して以下を判定してください:
   - name: snake_case の機械可読 ID（英数字 + アンダースコア、40 文字以内）
   - label: 日本語表示名（40 文字以内）
   - type: date / text / list / table のいずれか
   - bbox: **記入する空欄（記入欄）のみ**を囲む矩形（page / x / y / w / h、pt 単位）。
     ラベル文字（項目名）は bbox に含めない。ラベル word の右端〜行/セル右端を記入欄の左右とする。
     ラベルと記入欄は**別物**として扱う（label=ラベル文字 / bbox=記入欄のみの矩形）。
     記入欄を含む行全体やラベルごと囲む全幅枠にはしないこと。
   - max_chars: 想定最大文字数（bbox サイズと フィールドの性質から推定）
   - multiline: 複数行入力可否（議題・決定事項等の大枠は true、日付等は false）
   - padding: bbox 内部の余白（pt 単位、既定 4pt）
   - align: left / center / right（日付は left、金額は right が日本語フォームの慣例）
3. font.family は入力に明示がなければ 'Noto Sans JP' を、font.size は周辺 word の
   平均から推定してください（既定 12pt）
4. font_size_min は仕様書 §0-3.5 要件 2 に従い 8pt 固定
5. 入力 markdown / tables HTML の構造（見出し / 表 / 箇条書き）と Tesseract bbox を
   突き合わせ、ラベル（項目名）と記入欄を 1 組として認識し、field.label にラベル文字を、
   field.bbox に**記入欄のみ**の矩形を割り当ててください（ラベル部分は bbox から除く）
   - 例: ラベル「日時」の word の右側にある空欄/書込欄のみを bbox にする
     （ラベル「日時」の文字は bbox に含めない。type='date', multiline=false）
   - 例: 「議題」見出し下の大きな記入欄（空欄）を bbox にする（見出し文字は含めない。
     type='list' or 'text', multiline=true）
   - 空欄テンプレート（記入欄に word が無い）は、ラベル word の右端〜セル/行の右端
     （罫線がそろっていれば罫線、無ければページ右マージン）を記入欄とみなして bbox を作成する

## 知人サンプル PDF（IMG_9452〜9456.pdf）の典型構造（参考）

- ヘッダー: 「会議議事録」タイトル + 右上に日付
- 2 列テーブル: ラベルセル + 入力枠（部署 / 氏名 / 日時 / 場所 / 出席者）。
  bbox は**入力枠のセル側のみ**にし、ラベルセルは含めない（ラベル＋入力枠を 1 枠にまとめない）
- 大枠: 議題 / 議事内容 / 決定事項（multiline=true、padding は個人スタイル学習対象）
- フッター: 添付資料 / 次回予定

field 数は通常 5〜10 個程度。20 個を超える場合は粒度を見直してください。
`

export const SYSTEM_PROMPT_PDF_STRUCTURE_CACHE_CONTROL = {
  type: 'ephemeral' as const,
}

/**
 * ユーザープロンプト構築。
 *
 * @param input.markdown      Mistral OCR pages[].sourceMarkdown 連結
 * @param input.tablesHtml    Mistral OCR pages[].tables[].content（HTML format='html'）連結
 * @param input.bboxWords     Tesseract bbox 付き word リスト（既に editor watermark 除外済）
 * @param input.pageSizes     ページ pt サイズ（座標範囲妥当性ヒント）
 * @param input.classification 'text' | 'scan'
 * @param input.inputPathType 'A' | 'B'
 */
export function buildUserPromptPdfStructure(input: {
  markdown: string
  tablesHtml: string[]
  bboxWords: Array<{
    page: number
    text: string
    bbox: { x: number; y: number; w: number; h: number }
    confidence: number
  }>
  pageSizes: Array<{ page: number; widthPt: number; heightPt: number }>
  classification: 'text' | 'scan'
  inputPathType: 'A' | 'B'
}): string {
  const tableSection =
    input.tablesHtml.length === 0
      ? '(なし)'
      : input.tablesHtml.map((html, i) => `--- table ${i + 1} ---\n${html}`).join('\n\n')

  return `\
入力タイプ: ${input.classification === 'text' ? 'テキスト PDF' : 'スキャン PDF'}
入力経路: パス ${input.inputPathType}（${
    input.inputPathType === 'A' ? '未書込原本' : '書込済→白塗り済'
  }）

## ページ寸法（pt 単位）

\`\`\`json
${JSON.stringify(input.pageSizes, null, 2)}
\`\`\`

## Mistral OCR markdown（構造抽出: 見出し / 段落 / 箇条書き）

${input.markdown.length > 0 ? input.markdown : '(なし)'}

## Mistral OCR tables HTML（colspan/rowspan 保持、format='html'）

${tableSection}

## Tesseract.js bbox 付き word リスト（座標源、編集ツール透かし除外済）

\`\`\`json
${JSON.stringify(input.bboxWords, null, 2)}
\`\`\`

以上の入力から、議事録テンプレートの fields[] を抽出してください。
`
}
