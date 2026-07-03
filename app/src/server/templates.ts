// Server Actions を責務ごとに分割した barrel。
// upload / crud / listing / editor-save / guest-preview の各モジュールから re-export する。
// 'use server' は各サブモジュール側で宣言。
export * from './templates/upload'
export * from './templates/crud'
export * from './templates/listing'
export * from './templates/editor-save'
export * from './templates/guest-preview'
export type { UploadTemplateInput } from './templates/upload'
export type { DeleteTemplateMode } from './templates/crud'
