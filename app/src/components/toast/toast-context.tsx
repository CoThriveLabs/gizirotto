'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'

/**
 * 軽量トースト Provider（外部依存なし）。
 * Phase 3 第 3 週 T-E-3: 画質自動調整通知に利用。
 */

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface ToastItem {
  id: string
  kind: ToastKind
  message: string
}

interface ToastContextValue {
  toasts: ToastItem[]
  showToast: (kind: ToastKind, message: string) => void
  dismissToast: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const AUTO_DISMISS_MS = 6000

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const showToast = useCallback((kind: ToastKind, message: string) => {
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setToasts((prev) => [...prev, { id, kind, message }])
  }, [])

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismissToast }}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used within <ToastProvider>')
  }
  return ctx
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="fixed z-[60] bottom-4 right-4 flex flex-col gap-2 max-w-sm w-[calc(100vw-2rem)] pointer-events-none"
    >
      {toasts.map((t) => (
        <ToastBubble key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function ToastBubble({
  item,
  onDismiss,
}: {
  item: ToastItem
  onDismiss: (id: string) => void
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [item.id, onDismiss])

  const styleByKind: Record<ToastKind, string> = {
    info: 'bg-white border-gizirotto-blue-200 text-gizirotto-blue-900',
    success: 'bg-white border-green-300 text-green-800',
    warning: 'bg-amber-50 border-amber-300 text-amber-900',
    error: 'bg-red-50 border-red-300 text-red-800',
  }

  return (
    <div
      role="status"
      className={`pointer-events-auto rounded border shadow-sm px-4 py-3 text-sm flex items-start gap-3 ${styleByKind[item.kind]}`}
    >
      <span className="flex-1 leading-relaxed">{item.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="通知を閉じる"
        className="text-xs text-gray-500 hover:text-gray-700"
      >
        ×
      </button>
    </div>
  )
}
