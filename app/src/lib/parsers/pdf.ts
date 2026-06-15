/**
 * 互換シム（Phase 2.5 で `pdf/` ディレクトリへ再構成）。
 *
 * 旧 src/lib/parsers/pdf.ts への直 import を壊さないために再エクスポートのみ提供。
 * 新規コードからは `@/lib/parsers/pdf` （= `pdf/index.ts`）を直接 import すること。
 *
 * 設計書 v1.4.1 §3-1 / R-1: 既存 TemplateParser<'pdf'> interface 温存 + 内部分解。
 */
export { pdfParser } from './pdf/index'
