// Server Actions を責務ごとに分割した barrel。
// listing / crud / adjust-save の各モジュールから re-export する。
// 'use server' は各サブモジュール側で宣言。
export * from './minutes/listing'
export * from './minutes/crud'
export * from './minutes/adjust-save'
export type { MinutesListItem, MinutesListResult } from './minutes/listing'
export type { CreateMinuteInput, UpdateMinuteInput } from './minutes/crud'
export type { SaveBboxOverridesInput, SaveMinuteAdjustInput } from './minutes/adjust-save'
