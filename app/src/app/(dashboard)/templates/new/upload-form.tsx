'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { uploadTemplate } from '@/server/templates'
import { previewTemplateAsGuest } from '@/server/templates'
import ErrorNotice from '@/components/error-notice'
import WhiteoutModal from './whiteout-modal'
import { LimitModal } from '@/components/usage/limit-modal'
import { ResourceLimitError } from '@/lib/db-error-mapper'
import { useFormCache } from '@/lib/hooks/use-form-cache'
import { isAuthRequiredError } from '@/lib/errors/auth-required'
import { TurnstileWidget } from '@/components/auth/TurnstileWidget'

const formSchema = z.object({
  name: z
    .string()
    .min(1, 'テンプレ名を入力してください')
    .max(40, '40 文字以内で入力してください'),
})

type FormValues = z.infer<typeof formSchema>
type InputPath = 'A' | 'B'

const ACCEPT =
  '.docx,.pdf,.jpg,.jpeg,.png,.webp,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,image/jpeg,image/png,image/webp'
const MAX_FILE_BYTES = 10 * 1024 * 1024

type PickFormatResult =
  | { format: 'docx'; imageMime?: undefined }
  | { format: 'pdf'; imageMime?: undefined }
  | { format: 'image'; imageMime: 'image/jpeg' | 'image/png' | 'image/webp' }
  | { format: null; imageMime?: undefined; heicError?: true }

function pickFormat(file: File): PickFormatResult {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.docx')) return { format: 'docx' }
  if (lower.endsWith('.pdf')) return { format: 'pdf' }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return { format: 'image', imageMime: 'image/jpeg' }
  if (lower.endsWith('.png')) return { format: 'image', imageMime: 'image/png' }
  if (lower.endsWith('.webp')) return { format: 'image', imageMime: 'image/webp' }
  if (lower.endsWith('.heic') || lower.endsWith('.heif')) return { format: null, heicError: true }
  return { format: null }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') return reject(new Error('READ_FAILED'))
      const idx = result.indexOf('base64,')
      if (idx < 0) return reject(new Error('READ_FAILED'))
      resolve(result.slice(idx + 'base64,'.length))
    }
    reader.onerror = () => reject(reader.error ?? new Error('READ_FAILED'))
    reader.readAsDataURL(file)
  })
}

interface GuestPreviewResult {
  fields: { name: string; label: string }[]
  thumbnailDataUrl: string | null
}

interface Props {
  isGuest?: boolean
}

export default function UploadTemplateForm({ isGuest = false }: Props) {
  const router = useRouter()
  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '' },
  })
  const [file, setFile] = useState<File | null>(null)
  const [inputPath, setInputPath] = useState<InputPath>('A')
  const [showRestoredNotice, setShowRestoredNotice] = useState(false)

  const { saveSnapshot, clearSnapshot } = useFormCache<{
    name: string
    inputPath: InputPath
  }>('templates:new', {
    onRestore: (v) => {
      setValue('name', v.name)
      setInputPath(v.inputPath)
      setShowRestoredNotice(true)
    },
  })

  const [serverError, setServerError] = useState<string | null>(null)
  const [submitErrorCode, setSubmitErrorCode] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [whiteoutTarget, setWhiteoutTarget] = useState<{ templateId: string } | null>(null)
  const [limitOpen, setLimitOpen] = useState(false)

  // Guest-only state
  const [turnstileToken, setTurnstileToken] = useState<string>('')
  const [guestPreview, setGuestPreview] = useState<GuestPreviewResult | null>(null)
  const [guestLimitHit, setGuestLimitHit] = useState(false)

  const handleTurnstileToken = useCallback((t: string) => {
    setTurnstileToken(t)
  }, [])

  const pickResult = file ? pickFormat(file) : null
  const currentFormat = pickResult?.format ?? null
  const showPathChoice = currentFormat === 'pdf' && !isGuest
  const showImageNotice = currentFormat === 'image'

  async function onSubmitGuest(values: FormValues) {
    setServerError(null)
    setSubmitErrorCode(null)
    setGuestPreview(null)
    setGuestLimitHit(false)

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
    const picked = pickFormat(file)
    if (!picked.format) {
      if (picked.heicError) {
        setServerError('iPhone の写真は JPG か PNG に変換してからお試しください。')
      } else {
        setServerError('Word (.docx)、PDF (.pdf)、または画像 (.jpg / .png / .webp) を選択してください。')
      }
      return
    }

    setSubmitting(true)
    try {
      const fileBase64 = await fileToBase64(file)
      const result = await previewTemplateAsGuest({
        format: picked.format,
        fileBase64,
        imageMime: picked.format === 'image' ? picked.imageMime : undefined,
        turnstileToken,
      })
      setGuestPreview(result)
    } catch (e) {
      const code = e instanceof Error ? e.message : 'unknown error'
      if (code === 'TEMPLATE_LIMIT_GUEST') {
        setGuestLimitHit(true)
        saveSnapshot({ name: values.name, inputPath })
        return
      }
      if (code === 'TURNSTILE_FAILED') {
        setServerError('bot 確認に失敗しました。ページを再読み込みして再度お試しください。')
        return
      }
      if (code === 'TOO_MANY_REQUESTS') {
        setServerError('アクセスが集中しています。少し時間を置いて再度お試しください。')
        return
      }
      setSubmitErrorCode(code)
    } finally {
      setSubmitting(false)
    }
  }

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
    const picked = pickFormat(file)
    if (!picked.format) {
      if (picked.heicError) {
        setServerError('iPhone の写真は JPG か PNG に変換してからお試しください。')
      } else {
        setServerError('Word (.docx)、PDF (.pdf)、または画像 (.jpg / .png / .webp) を選択してください。')
      }
      return
    }
    setSubmitting(true)
    try {
      const fileBase64 = await fileToBase64(file)
      const created = await uploadTemplate({
        name: values.name,
        format: picked.format,
        fileBase64,
        inputPathType: picked.format === 'pdf' ? inputPath : undefined,
        imageMime: picked.format === 'image' ? picked.imageMime : undefined,
      })
      clearSnapshot()
      if (picked.format === 'pdf' && inputPath === 'B') {
        setWhiteoutTarget({ templateId: created.id })
      } else {
        router.push(`/templates/${created.id}`)
        router.refresh()
      }
    } catch (e) {
      if (isAuthRequiredError(e)) {
        saveSnapshot({ name: values.name, inputPath })
        const next = encodeURIComponent('/templates/new')
        router.push(`/login?next=${next}`)
        return
      }
      if (isResourceLimitTemplates(e)) {
        setLimitOpen(true)
        return
      }
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

  function handleGuestSaveClick() {
    const name = getValues('name')
    saveSnapshot({ name, inputPath })
    const next = encodeURIComponent('/templates/new')
    router.push(`/login?next=${next}`)
  }

  function handleGuestLimitLogin() {
    const next = encodeURIComponent('/templates/new')
    router.push(`/login?next=${next}`)
  }

  if (guestLimitHit) {
    return (
      <div className="space-y-4">
        <div className="rounded border border-amber-200 bg-amber-50 p-4 space-y-2">
          <p className="text-sm text-amber-800 font-medium">お試し回数（2回）に達しました</p>
          <p className="text-sm text-amber-700">
            テンプレの読み込みはアカウント登録後に無制限でご利用いただけます。
          </p>
        </div>
        <button
          type="button"
          onClick={handleGuestLimitLogin}
          className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium px-4 py-2 rounded"
        >
          ログイン / 新規登録して保存する
        </button>
      </div>
    )
  }

  if (guestPreview) {
    return (
      <div className="space-y-6">
        <div className="rounded border border-gizirotto-blue-200 bg-gizirotto-blue-50 p-4 space-y-3">
          <p className="text-sm font-medium text-gizirotto-blue-900">読み取り結果（お試しプレビュー）</p>

          {guestPreview.thumbnailDataUrl && (
            <div className="flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={guestPreview.thumbnailDataUrl}
                alt="テンプレプレビュー"
                className="max-w-full max-h-64 rounded border border-gray-200 shadow-sm"
              />
            </div>
          )}

          {guestPreview.fields.length > 0 ? (
            <div>
              <p className="text-xs text-gray-600 mb-2">検出された項目：</p>
              <ul className="space-y-1">
                {guestPreview.fields.map((f) => (
                  <li key={f.name} className="text-sm text-gray-800 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-gizirotto-blue-400 shrink-0" />
                    {f.label}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-gray-600">項目が検出されませんでした。</p>
          )}

          {!guestPreview.thumbnailDataUrl && (
            <p className="text-xs text-gray-500">
              Word ファイルはプレビュー画像を表示できません。項目の一覧のみ確認できます。
            </p>
          )}
        </div>

        <div className="rounded border border-gray-200 bg-gray-50 p-4 space-y-2">
          <p className="text-sm text-gray-700">
            このテンプレを保存してくり返し使うにはログインが必要です。
          </p>
          <button
            type="button"
            onClick={handleGuestSaveClick}
            className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium px-4 py-2 rounded"
          >
            ログイン / 新規登録して保存する
          </button>
        </div>
      </div>
    )
  }

  const handleFormSubmit = isGuest ? handleSubmit(onSubmitGuest) : handleSubmit(onSubmit)

  return (
    <>
      <form onSubmit={handleFormSubmit} className="space-y-4">
        {showRestoredNotice && (
          <div
            role="status"
            className="bg-gizirotto-blue-50 border border-gizirotto-blue-200 rounded p-3 text-sm text-gizirotto-blue-900 flex items-start justify-between gap-3"
          >
            <span>
              以前入力していた内容を復元しました。ファイルだけもう一度選んでください。
            </span>
            <button
              type="button"
              onClick={() => setShowRestoredNotice(false)}
              aria-label="復元通知を閉じる"
              className="shrink-0 text-gizirotto-blue-700 hover:text-gizirotto-blue-900"
            >
              ×
            </button>
          </div>
        )}
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
            ひな型ファイル（Word / PDF / 画像）
          </label>
          <input
            type="file"
            accept={ACCEPT}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">
            対応形式: .docx / .pdf / .jpg .jpeg .png .webp（各 10MB まで）
          </p>
        </div>

        {showImageNotice && (
          <div className="rounded border border-amber-200 bg-amber-50 p-3 space-y-1">
            <p className="text-sm text-amber-800">
              写真は文字の読み取りが不安定なことがあります。読み取り後、画面で位置や項目を直せます。
            </p>
            <p className="text-xs text-amber-700">
              1 枚（1 ページ）のみ対応です。複数ページのテンプレートは現在ご利用いただけません。
            </p>
          </div>
        )}

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
          {submitting
            ? '読んでいます…'
            : isGuest
              ? 'お試しで読み込む'
              : '覚えてもらう'}
        </button>

        {isGuest && <TurnstileWidget onToken={handleTurnstileToken} />}
      </form>

      {whiteoutTarget && (
        <WhiteoutModal
          templateId={whiteoutTarget.templateId}
          onDone={handleWhiteoutDone}
          onClose={() => setWhiteoutTarget(null)}
        />
      )}

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
