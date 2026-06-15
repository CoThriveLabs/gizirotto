import Link from 'next/link'

export const metadata = {
  title: '家族を作る・参加する',
  robots: { index: false, follow: false },
}

export default function FamilySetupPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-8">
      <div className="max-w-md w-full space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-serif text-gizirotto-blue-900">
            ぎじろっとを始める
          </h1>
          <p className="text-sm text-gray-700">
            ご家族で議事録を共有するための「家族」を作るか、招待された家族に参加してください。
          </p>
        </div>
        <div className="space-y-3">
          <Link
            href="/family/create"
            className="block w-full text-center bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium py-3 rounded"
          >
            家族を作る
          </Link>
          <Link
            href="/family/join"
            className="block w-full text-center border border-gizirotto-blue-500 text-gizirotto-blue-700 hover:bg-gizirotto-blue-50 font-medium py-3 rounded"
          >
            家族に参加する
          </Link>
        </div>
      </div>
    </main>
  )
}
