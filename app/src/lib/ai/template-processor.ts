import PizZip from 'pizzip'
import type { TemplateSchema, TemplateField } from './schemas/template-schema'

/**
 * docxtemplater 互換の最小 .docx を組み立てる。
 *
 * v1 戦略:
 * - 元 docx のレイアウト 100% 温存は v1 では諦め
 * - fields[] を順に「【{label}】\n{{field_name}}」形式で書き出した .docx を生成
 * - 結果を templates_processed バケットに保存 → 出力時 docxtemplater が {field_name} を埋める
 *
 * 実装方針: Word 互換 OOXML の最小構造（[Content_Types].xml / _rels / word/document.xml）を
 * その場で組み立てる。フォント・色はデフォルト（Noto Sans JP は表示側 OS に依存）。
 *
 * @param schema  Claude が抽出した TemplateSchema
 * @param templateName  テンプレ表示名（h1 として埋め込み）
 * @returns 生成された docx の ArrayBuffer
 */
export async function generatePlaceholderDocx(
  schema: TemplateSchema,
  templateName: string,
): Promise<ArrayBuffer> {
  const docXml = buildDocumentXml(schema.fields, templateName)
  const zip = new PizZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES_XML)
  zip.file('_rels/.rels', ROOT_RELS_XML)
  zip.file('word/_rels/document.xml.rels', WORD_RELS_XML)
  zip.file('word/document.xml', docXml)
  const buffer = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' })
  // Buffer → ArrayBuffer
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer
}

// ---------------------------------------------------------------------------
// 内部実装: 最小 docx OOXML
// ---------------------------------------------------------------------------

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const WORD_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`

/** XML エスケープ */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** タイトル段落 */
function titleParagraph(text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

/** 項目見出し段落（【label】） */
function labelParagraph(label: string): string {
  return `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">【${escapeXml(label)}】</w:t></w:r></w:p>`
}

/** プレースホルダ段落（{field_name} または箇条書きループ） */
function placeholderParagraph(field: TemplateField): string {
  if (field.type === 'list') {
    // docxtemplater のループ構文: {#name} ... {/name}
    // 配列要素の各行を箇条書きにする
    return [
      `<w:p><w:r><w:t xml:space="preserve">{#${field.name}}</w:t></w:r></w:p>`,
      `<w:p><w:r><w:t xml:space="preserve">・{.}</w:t></w:r></w:p>`,
      `<w:p><w:r><w:t xml:space="preserve">{/${field.name}}</w:t></w:r></w:p>`,
    ].join('')
  }
  return `<w:p><w:r><w:t xml:space="preserve">{${field.name}}</w:t></w:r></w:p>`
}

function buildDocumentXml(fields: TemplateField[], title: string): string {
  const body = [
    titleParagraph(title),
    ...fields.flatMap((f) => [labelParagraph(f.label), placeholderParagraph(f)]),
  ].join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${body}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>
  </w:body>
</w:document>`
}
