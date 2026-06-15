'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { uploadTemplate } from '@/server/templates'
import ErrorNotice from '@/components/error-notice'
import WhiteoutModal from './whiteout-modal'
import { LimitModal } from '@/components/usage/limit-modal'
import { ResourceLimitError } from '@/lib/db-error-mapper'

const formSchema = z.object({
  name: z
    .string()
    .min(1, 'テンプレ名を入力してください')
    .max(40, '40 文字以内で入力してください'),
})

type FormValues = z.infer<typeof formSchema>
type InputPath = 'A' | 'B'

const ACCEPT =
  '.docx,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf'
const MAX_FILE_BYTES = 10 * 1024 * 1024

function pickFormat(file: File): 'docx' | 'pdf' | null {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.pdf')) return 'pdf'
  return null
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') return reject(new Error('READ_FAILED'))
      // data:application/...;base64,XXXX
      const idx = result.indexOf('base64,')
      if (idx < 0) return reject(new Error('READ_FAILED'))
      resolve(result.slice(idx + 'base64,'.length))
    }
    reader.onerror = () => reject(reader.error ?? new Error('READ_FAILED'))
    reader.readAsDataURL(file)
  })
}

export default function UploadTemplateForm() {
  const router = useRouter()
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '' },
  })
  const [file, setFile] = useState<File | null>(null)
  const [inputPath, setInputPath] = useState<InputPath>('A')
  // ローカル入力チェックの文言（既に素人向け日本語・そのまま表示）。
  const [serverError, setServerError] = useState<string | null>(null)
  // サーバ/アップロードが投げた生エラーコード（表示時に humanizeErrorCode で日本語化）。
  const [submitErrorCode, setSubmitErrorCode] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // パス B のとき、アップロード完了後に開く白塗りモーダル
  const [whiteoutTarget, setWhiteoutTarget] = useState<{
    templateId: string
  } | null>(null)
  // テンプレ累積上限到達時の LimitModal 表示状態
  const [limitOpen, setLimitOpen] = useState(false)

  const currentFormat = file ? pickFormat(file) : null
  const showPathChoice = currentFormat === 'pdf'

  async function onSubmit(values: FormValues) {
    setServerError(null)
    setSubmitErrorCode(null)
    if (!file) {
      setServerError('ファイルを選択してください。')
      return
    }
    if (file.size === 0) {
      setServerError('ファイルが空のようです。')
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      setServerError('ファイルが大きすぎます（10MB まで）。')
      return
    }
    const format = pickFormat(file)
    if (!format) {
      setServerError('Word (.docx) または PDF (.pdf) を選択してください。')
      return
    }
    setSubmitting(true)
    try {
      const fileBase64 = await fileToBase64(file)
      const created = await uploadTemplate({
        name: values.name,
        format,
        fileBase64,
        inputPathType: format === 'pdf' ? inputPath : undefined,
      })
      if (format === 'pdf' && inputPath === 'B') {
        // パス B: 白塗りモーダルを開く。モーダル完了後に詳細ページへ遷移する
        setWhiteoutTarget({ templateId: created.id })
      } else {
        router.push(`/templates/${created.id}`)
        router.refresh()
      }
    } catch (e) {
      // テンプレ累積上限 (ResourceLimitError) は LimitModal で出し分け。
      if (isResourceLimitTemplates(e)) {
        setLimitOpen(true)
        return
      }
      // サーバ/アップロード由来は生コードを保持し、表示時に日本語化（ErrorNotice）。
      setSubmitErrorCode(e instanceof Error ? e.message : 'unknown error')
    } finally {
      setSubmitting(false)
    }
  }

  function handleWhiteoutDone(templateId: string) {
    setWhiteoutTarget(null)
    router.push(`/templates/${templateId}`)
    router.refresh()
  }

  return (
    <>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label className="block text-sm text-gray-700 mb-1">テンプレ名</label>
          <input
            type="text"
            {...register('name')}
            placeholder="例: 家族会議"
            className="w-full border border-gray-300 rounded px-3 py-2"
          />
          {errors.name && (
            <p className="text-xs text-red-600 mt-1">{errors.name.message}</p>
          )}
        </div>

        <div>
          <label className="block text-sm text-gray-700 mb-1">
            ひな型ファイル（Word / PDF）
          </label>
          <input
            type="file"
            accept={ACCEPT}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm"
          />
        </div>

        {showPathChoice && (
          <div className="space-y-2 rounded border border-gray-200 bg-gray-50 p-3">
            <p className="text-sm text-gray-700 font-medium">
              このファイルの状態を教えてください
            </p>
            <label className="flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
              <input
                type="radio"
                name="inputPath"
                value="A"
                checked={inputPath === 'A'}
                onChange={() => setInputPath('A')}
                className="mt-1"
              />
              <span>
                <span className="block font-medium">
                  未記入のテンプレート（推奨）
                </span>
                <span className="block text-xs text-gray-500">
                  まだ何も書かれていない、まっさらなひな型です。
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
              <input
                type="radio"
                name="inputPath"
                value="B"
                checked={inputPath === 'B'}
                onChange={() => setInputPath('B')}
                className="mt-1"
              />
              <span>
                <span className="block font-medium">
                  書き込み済みのファイル → 自動で空白に戻す
                </span>
                <span className="block text-xs text-gray-500">
                  すでに記入されている PDF です。次の画面で白く塗りたい場所を選んでください。
                </span>
              </span>
            </label>
          </div>
        )}

        {serverError && <p className="text-sm text-red-600">{serverError}</p>}
        {submitErrorCode && (
          <ErrorNotice code={submitErrorCode} prefix="アップロードできませんでした" />
        )}

        {submitting && (
          <p className="text-sm text-gizirotto-blue-700">テンプレを読んでいます…</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium px-4 py-2 rounded disabled:opacity-50"
        >
          {submitting ? '読んでいます…' : '覚えてもらう'}
        </button>
      </form>

      {whiteoutTarget && (
        <WhiteoutModal
          templateId={whiteoutTarget.templateId}
          onDone={handleWhiteoutDone}
          onClose={() => setWhiteoutTarget(null)}
        />
      )}

      {/* テンプレ累積上限 LimitModal */}
      <LimitModal
        open={limitOpen}
        resource="templates"
        onClose={() => setLimitOpen(false)}
      />
    </>
  )
}

function isResourceLimitTemplates(e: unknown): boolean {
  if (e instanceof ResourceLimitError) return e.resource === 'templates'
  if (e instanceof Error) {
    const maybe = e as Error & { resource?: unknown }
    if (
      e.name === 'ResourceLimitError' &&
      e.message === 'RESOURCE_LIMIT_EXCEEDED' &&
      maybe.resource === 'templates'
    ) {
      return true
    }
  }
  return false
}
