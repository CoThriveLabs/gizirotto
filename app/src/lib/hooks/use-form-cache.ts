'use client'

import { useEffect, useRef } from 'react'
import {
  clearFormCache,
  FORM_CACHE_DEFAULT_TTL_MS,
  getDraftStorageSafe,
  readFormCache,
  writeFormCache,
} from '@/lib/utils/form-cache'

export interface UseFormCacheOptions<T> {
  /** mount 時に snapshot があり expectedPath が一致すれば呼ばれる（1 回限り） */
  onRestore?: (values: T) => void
  /** TTL (ms)。デフォルト 5 分 */
  ttlMs?: number
}

export interface UseFormCacheReturn<T> {
  /** 送信前の未認証検知で呼ぶ snapshot 保存関数 */
  saveSnapshot: (values: T) => void
  /** 復元成功 / 明示クリア時に呼ぶ */
  clearSnapshot: () => void
}

/**
 * フォーム途中入力の localStorage キャッシュ React hook。
 *
 * mount 時:
 *   - snapshot を読み出して expectedPath が現在の pathname と一致すれば onRestore(values) を 1 回呼ぶ
 *   - 復元後は snapshot を自動削除
 *   - 別 page で誤復元しないよう expectedPath !== pathname のときは復元せず snapshot は保留
 *   - React 18 StrictMode 二重 mount は useRef ガードで吸収
 *
 * 使い方:
 *   const { saveSnapshot, clearSnapshot } = useFormCache<{ name: string }>('templates:new', {
 *     onRestore: (v) => setValue('name', v.name)
 *   })
 *
 *   送信前に未認証検知 → saveSnapshot({ name })
 *   送信成功 → clearSnapshot()
 *
 * 注意: 機微情報（password / token / クレジット系）は絶対に渡さないこと。
 */
export function useFormCache<T extends Record<string, unknown>>(
  formId: string,
  options?: UseFormCacheOptions<T>,
): UseFormCacheReturn<T> {
  const restoredRef = useRef(false)
  const onRestoreRef = useRef(options?.onRestore)
  onRestoreRef.current = options?.onRestore
  const ttlMs = options?.ttlMs ?? FORM_CACHE_DEFAULT_TTL_MS

  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const storage = getDraftStorageSafe()
    if (!storage) return
    const entry = readFormCache<T>(storage, formId, ttlMs)
    if (!entry) return
    if (entry.expectedPath !== window.location.pathname) {
      // 別 page の誤復元防止。snapshot は破棄せず保留（同一 page に戻ったら復元可能性あり）
      return
    }
    onRestoreRef.current?.(entry.values)
    clearFormCache(storage, formId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId])

  const saveSnapshot = (values: T) => {
    const storage = getDraftStorageSafe()
    writeFormCache(storage, formId, values, window.location.pathname)
  }

  const clearSnapshot = () => {
    const storage = getDraftStorageSafe()
    clearFormCache(storage, formId)
  }

  return { saveSnapshot, clearSnapshot }
}
