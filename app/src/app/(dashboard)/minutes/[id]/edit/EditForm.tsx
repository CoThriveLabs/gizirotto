'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { updateMinute } from '@/server/minutes'
import { ordinalLabel } from '@/lib/utils/ordinal-label'

export type TemplateField = {
  name: string
  label: string
  multiline: boolean
}

interface Props {
  id: string
  initialTitle: string
  initialMeetingDate: string
  initialContent: Record<string, unknown>
  fields: TemplateField[]
}

export function EditForm({
  id,
  initialTitle,
  initialMeetingDate,
  initialContent,
  fields,
}: Props) {
  const router = useRouter()
  const [title, setTitle] = useState(initialTitle)
  const [meetingDate, setMeetingDate] = useState(initialMeetingDate)
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    const knownNames = new Set(fields.map((f) => f.name))
    for (const f of fields) {
      const v = initialContent[f.name]
      init[f.name] = stringifyValue(v)
    }
    for (const [k, v] of Object.entries(initialContent)) {
      if (!knownNames.has(k)) init[k] = stringifyValue(v)
    }
    return init
  })
  const [saving, setSaving] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  function onChange(name: string, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }))
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) {
      setErrorMsg('タイトルを入力してください')
      return
    }
    setSaving(true)
    setErrorMsg(null)
    try {
      await updateMinute({
        id,
        title: title.trim(),
        meetingDate,
        content: values,
      })
      router.push(`/minutes/${id}`)
    } catch {
      setErrorMsg('保存に失敗しました。少し時間を置いて再度お試しください。')
      setSaving(false)
    }
  }

  const extraEntries = Object.entries(values).filter(
    ([k]) => !fields.some((f) => f.name === k),
  )

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div>
        <label className="text-xs text-gray-700">タイトル</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={100}
          className="w-full mt-1 border border-gizirotto-blue-200 rounded px-3 py-2 text-base"
          required
        />
      </div>
      <div>
        <label className="text-xs text-gray-700">開催日</label>
        <input
          type="date"
          value={meetingDate}
          onChange={(e) => setMeetingDate(e.target.value)}
          className="mt-1 border border-gizirotto-blue-200 rounded px-3 py-2 text-base"
          required
        />
      </div>

      {fields.map((f) => (
        <div key={f.name}>
          <label className="text-xs text-gray-700">{f.label}</label>
          {f.multiline ? (
            <textarea
              value={values[f.name] ?? ''}
              onChange={(e) => onChange(f.name, e.target.value)}
              className="w-full mt-1 border border-gizirotto-blue-200 rounded px-3 py-2 text-base min-h-[6rem]"
            />
          ) : (
            <input
              type="text"
              value={values[f.name] ?? ''}
              onChange={(e) => onChange(f.name, e.target.value)}
              className="w-full mt-1 border border-gizirotto-blue-200 rounded px-3 py-2 text-base"
            />
          )}
        </div>
      ))}

      {extraEntries.length > 0 && (
        <details className="text-xs">
          <summary className="text-gray-500 cursor-pointer">
            その他の項目（テンプレ定義外、{extraEntries.length} 件）
          </summary>
          <div className="space-y-3 mt-2">
            {extraEntries.map(([name, value], i) => (
              // G1-⑤案2: 英語 snake_case の name を利用者に見せず「その他の項目①…」連番総称で隠す。
              // key / onChange / value は英語 name のまま維持し、保存時の content キーも英語 name を保つ。
              <div key={name}>
                <label className="text-xs text-gray-600">
                  その他の項目{ordinalLabel(i + 1)}
                </label>
                <textarea
                  value={value}
                  onChange={(e) => onChange(name, e.target.value)}
                  className="w-full mt-1 border border-gizirotto-blue-100 rounded px-2 py-1 text-sm min-h-[3rem]"
                />
              </div>
            ))}
          </div>
        </details>
      )}

      {errorMsg && (
        <p className="text-sm text-red-600" role="alert">
          {errorMsg}
        </p>
      )}

      <div className="flex justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={() => router.back()}
          disabled={saving}
          className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
        >
          キャンセル
        </button>
        <button
          type="submit"
          disabled={saving}
          className="bg-gizirotto-blue-700 text-white px-5 py-2 rounded hover:bg-gizirotto-blue-800 disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  )
}

function stringifyValue(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(stringifyValue).join('\n')
  return JSON.stringify(v)
}
