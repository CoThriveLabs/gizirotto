/**
 * CloudConvert API クライアント。
 *
 * docx → blank PDF 化の 1 回限りパイプ。Free tier 10 conv/day（月 300 conv）想定で、
 * 本案件は数家族 × 月 1 テンプレ程度のため余裕がある。
 *
 * 実装方針: SDK 非依存の素の fetch ベース（Edge Runtime / Node どちらでも動くように）。
 */

const CLOUDCONVERT_API_BASE = 'https://api.cloudconvert.com/v2'

type CloudConvertTask = {
  id: string
  name: string
  status: 'waiting' | 'processing' | 'finished' | 'error'
  result?: { form?: { url: string; parameters: Record<string, string> }; files?: Array<{ url: string }> }
  message?: string
}

type JobResponse = { data: { id: string; status: string; tasks: CloudConvertTask[] } }

const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 5 * 60 * 1000 // Free tier 5 min job timeout 整合

/**
 * docx Buffer を blank PDF Buffer に変換。
 * 失敗時は throw（呼出側で擬人化エラー表示 + blank_pdf_status='failed' UPDATE）。
 */
export async function convertDocxToBlankPdf(
  docxBuffer: Buffer | Uint8Array,
  filename: string,
  options?: { signal?: AbortSignal },
): Promise<Buffer> {
  const apiKey = process.env.CLOUDCONVERT_API_KEY
  if (!apiKey) throw new Error('CLOUDCONVERT_API_KEY_MISSING')

  // 1. Job 作成 (import/upload → convert → export/url)
  const jobRes = await fetch(`${CLOUDCONVERT_API_BASE}/jobs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tasks: {
        'import-docx': { operation: 'import/upload' },
        'convert-pdf': {
          operation: 'convert',
          input: 'import-docx',
          output_format: 'pdf',
          engine: 'libreoffice',
        },
        'export-pdf': {
          operation: 'export/url',
          input: 'convert-pdf',
        },
      },
    }),
    signal: options?.signal,
  })
  if (!jobRes.ok) throw new Error(`CLOUDCONVERT_JOB_CREATE_FAILED:${jobRes.status}`)
  const job: JobResponse = await jobRes.json()

  const importTask = job.data.tasks.find((t) => t.name === 'import-docx')
  if (!importTask?.result?.form) throw new Error('CLOUDCONVERT_IMPORT_TASK_MISSING')

  // 2. import-upload: docxBuffer をアップロード
  const form = new FormData()
  for (const [k, v] of Object.entries(importTask.result.form.parameters)) {
    form.append(k, v)
  }
  const bytes = toUint8(docxBuffer)
  const fileBlob = new Blob([bytes.slice().buffer], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
  form.append('file', fileBlob, filename)
  const uploadRes = await fetch(importTask.result.form.url, {
    method: 'POST',
    body: form,
    signal: options?.signal,
  })
  if (!uploadRes.ok) throw new Error(`CLOUDCONVERT_UPLOAD_FAILED:${uploadRes.status}`)

  // 3. polling for convert + export 完了
  const exportTask = await pollTaskFinished(job.data.id, 'export-pdf', apiKey, options)
  const pdfUrl = exportTask.result?.files?.[0]?.url
  if (!pdfUrl) throw new Error('CLOUDCONVERT_EXPORT_URL_MISSING')

  // 4. PDF ダウンロード
  const pdfRes = await fetch(pdfUrl, { signal: options?.signal })
  if (!pdfRes.ok) throw new Error(`CLOUDCONVERT_PDF_FETCH_FAILED:${pdfRes.status}`)
  const arrayBuf = await pdfRes.arrayBuffer()
  return Buffer.from(arrayBuf)
}

async function pollTaskFinished(
  jobId: string,
  taskName: string,
  apiKey: string,
  options?: { signal?: AbortSignal },
): Promise<CloudConvertTask> {
  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await fetch(`${CLOUDCONVERT_API_BASE}/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: options?.signal,
    })
    if (!res.ok) throw new Error(`CLOUDCONVERT_JOB_POLL_FAILED:${res.status}`)
    const job: JobResponse = await res.json()
    const target = job.data.tasks.find((t) => t.name === taskName)
    if (target?.status === 'finished') return target
    if (target?.status === 'error') {
      throw new Error(`CLOUDCONVERT_TASK_ERROR:${target.message ?? 'unknown'}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('CLOUDCONVERT_POLL_TIMEOUT')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toUint8(buf: Buffer | Uint8Array): Uint8Array {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf)
}
