'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { FileTextIcon } from './FileTextIcon'
import { DeleteTemplateModal } from './DeleteTemplateModal'

export type TemplateCardData = {
  id: string
  name: string
  source_format: string
  is_default: boolean
  created_at: string
  thumbnail_status: 'pending' | 'ready' | 'failed' | 'skipped'
  signedThumbUrl: string | null
}

export type TemplateCardMode = 'select' | 'manage'

interface Props {
  template: TemplateCardData
  variant: 'sample' | 'custom'
  mode: TemplateCardMode
  intent: 'ai' | 'manual'
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export function TemplateCard({
  template,
  variant,
  mode,
  intent,
}: Props) {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [regenError, setRegenError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const href = `/minutes/new?template_id=${template.id}&intent=${intent}`
  const status = template.thumbnail_status

  // ⑥サムネ再生成（PY2-2・failed×custom×manage のときのみ表示）。
  // 既存 API（temp 温存・案A で family 所属なら可）へ POST→成功で一覧再 fetch。
  const showRegen = status === 'failed' && variant === 'custom' && mode === 'manage'
  async function handleRegenerate(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (regenerating) return
    setRegenerating(true)
    setRegenError(null)
    try {
      const res = await fetch(
        `/api/templates/${template.id}/regenerate-thumbnail`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.code ?? `HTTP_${res.status}`)
      }
      router.refresh()
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : 'failed')
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <div
      className="relative bg-white border border-[#E5E7EB] rounded-xl shadow-sm overflow-hidden flex flex-col"
      data-variant={variant}
    >
      <Link
        href={href}
        className="relative z-0 block focus:outline-none focus:ring-2 focus:ring-gizirotto-blue-500 focus:ring-offset-2"
        aria-label={`${template.name} を使って議事録を作る`}
      >
        <div className="relative w-full" style={{ aspectRatio: '1 / 1.414' }}>
          {variant === 'sample' && (
            <span className="absolute top-2 left-2 z-10 bg-[#E0EBF5] text-[#3E6FAA] text-xs font-medium rounded-2xl px-2.5 py-1">
              サンプル
            </span>
          )}

          {status === 'pending' && (
            <div
              aria-label="サムネ生成中"
              className="absolute inset-0 bg-gray-100 animate-pulse"
            />
          )}

          {status === 'ready' && template.signedThumbUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={template.signedThumbUrl}
              alt={`${template.name} のサンプル画像`}
              className="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
            />
          )}

          {/* status=ready なのに署名 URL が無い（Storage 実体欠落）場合のフォールバック。
             Phase 5a 残テンプレで thumbnail_path カラムが空 / Storage に未保存の個体救済。 */}
          {status === 'ready' && !template.signedThumbUrl && (
            <div className="absolute inset-0 bg-gray-100 flex items-center justify-center text-gray-400">
              <FileTextIcon size={32} />
            </div>
          )}

          {status === 'failed' && (
            <div className="absolute inset-0 bg-gray-100 flex items-center justify-center text-gray-400">
              <FileTextIcon size={32} />
              <span
                className="absolute bottom-2 right-2 bg-red-500 text-white text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center"
                title="サムネ生成に失敗しました"
              >
                !
              </span>
            </div>
          )}

          {status === 'skipped' && (
            <div className="absolute inset-0 bg-gray-100 flex items-center justify-center text-gray-400">
              <FileTextIcon size={32} />
              <span className="absolute bottom-2 right-2 bg-gray-200 text-gray-700 text-xs font-medium rounded px-2 py-0.5">
                docx
              </span>
            </div>
          )}
        </div>

        <div className="px-3 py-3 text-center space-y-1">
          <p className="text-sm font-bold text-[#1F2937] truncate">
            {template.name}
          </p>
          <p className="text-xs text-[#9CA3AF]">
            {variant === 'sample' ? '内蔵' : formatDate(template.created_at)}
          </p>
        </div>
      </Link>

      {/* ⑥サムネ再生成ボタン（PY2-2・failed×custom×manage のみ・Link 外オーバーレイ）。 */}
      {showRegen && (
        <div className="absolute left-2 bottom-12 z-10">
          <button
            type="button"
            onClick={handleRegenerate}
            disabled={regenerating}
            className="text-xs font-medium px-2.5 py-1 rounded bg-white/95 border border-gray-300 text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50"
          >
            {regenerating ? '生成中…' : 'サムネ再生成'}
          </button>
          {regenError && (
            <span className="block mt-1 text-[10px] text-red-600 bg-white/90 rounded px-1">
              失敗しました
            </span>
          )}
        </div>
      )}

      {/* 3点メニュー（編集/削除）。select(CTA経由)でも custom なら表示する
          （スマホは manage 導線が無く、CTA からだと編集/削除できない致命傷の解消）。
          ⚠ select モードはカード全体が選択リンク。メニュー自体は Link の**外側**（兄弟）に置くため
          通常は選択遷移を誤発火しないが、保険で各ハンドラに stopPropagation/preventDefault を付け、
          メニュー操作中にカード選択遷移を起こさない。 */}
      {variant === 'custom' && (
        <div
          ref={menuRef}
          className="absolute top-2 right-2 z-30"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label="テンプレメニュー"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 text-[#6B7280]"
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute top-10 right-0 bg-white border border-gray-200 rounded-lg shadow-lg w-32 py-1 z-20"
            >
              <Link
                role="menuitem"
                href={`/templates/${template.id}`}
                onClick={(e) => {
                  // 編集は /templates/[id] への別遷移。カード選択リンクへ伝播させない。
                  e.stopPropagation()
                  setMenuOpen(false)
                }}
                className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                編集
              </Link>
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setMenuOpen(false)
                  setDeleteOpen(true)
                }}
                className="block w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50"
              >
                削除
              </button>
            </div>
          )}
        </div>
      )}

      {variant === 'custom' && (
        <DeleteTemplateModal
          templateId={template.id}
          templateName={template.name}
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
        />
      )}
    </div>
  )
}
