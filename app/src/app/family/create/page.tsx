import { CreateFamilyForm } from './_form'
import { sanitizeRelativeNext } from '@/lib/safe-next'

export const metadata = {
  title: '家族を作る',
  robots: { index: false, follow: false },
}

export default async function FamilyCreatePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  // next はサーバ側で検証してから client component へ渡す（未検証の searchParams を直接使わない）。
  const safeNext = sanitizeRelativeNext(next)

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-8">
      <div className="max-w-md w-full space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-serif text-gizirotto-blue-900">家族を作る</h1>
          <p className="text-sm text-gray-700">
            家族名と、ご家族内で表示するあなたの名前を入力してください。
          </p>
        </div>
        <CreateFamilyForm next={safeNext} />
      </div>
    </main>
  )
}
