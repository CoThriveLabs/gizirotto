import { customAlphabet } from 'nanoid'

/**
 * 家族コード生成器。
 * - 紛らわしい文字（I / O / 0 / 1）を除外したアルファベット 32 文字 + 数字 8 文字
 * - 長さ 10 → 衝突確率 1/3.4×10^16
 * - 有効期限 7 日（families.invite_code_expires_at で管理）
 * - 再発行回数は無制限（仕様書 §10-3 ③ ロック）
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const INVITE_CODE_LENGTH = 10
export const INVITE_CODE_TTL_DAYS = 7

const nanoid = customAlphabet(ALPHABET, INVITE_CODE_LENGTH)

export function generateInviteCode(): string {
  return nanoid()
}

export function computeInviteCodeExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITE_CODE_TTL_DAYS * 24 * 60 * 60 * 1000)
}

export function isInviteCodeExpired(expiresAt: string | Date, now: Date = new Date()): boolean {
  const exp = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt
  return exp.getTime() < now.getTime()
}

/**
 * 招待コードの形式バリデーション（DB 問い合わせ前のサーバ側軽量チェック）。
 * 大文字英数字（除外文字なし）かつ長さ 10。
 */
export function isValidInviteCodeFormat(code: string): boolean {
  if (code.length !== INVITE_CODE_LENGTH) return false
  for (const ch of code) {
    if (!ALPHABET.includes(ch)) return false
  }
  return true
}
