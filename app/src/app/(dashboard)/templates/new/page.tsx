import UploadTemplateForm from './upload-form'

export default function NewTemplatePage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      <h1 className="text-2xl font-serif text-gizirotto-blue-900">テンプレを覚える</h1>
      <p className="text-sm text-gray-600">
        いつも使っている議事録のひな型（Word または PDF）をアップロードしてください。
        項目構造を読み取って、次回からそのままお使いいただけます。
      </p>
      <p className="text-xs text-gray-500">
        ※ アップロードされたファイルはご家族専用として保存され、AI の学習には使われません。
      </p>
      <UploadTemplateForm />
    </div>
  )
}
