import { JoinFamilyForm } from './_form'

export const metadata = {
  title: '家族に参加する',
  robots: { index: false, follow: false },
}

export default async function FamilyJoinPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>
}) {
  const { code } = await searchParams
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-8">
      <div className="max-w-md w-full space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-serif text-gizirotto-blue-900">家族に参加する</h1>
          <p className="text-sm text-gray-700">
            ご家族から共有された招待コードと、ご家族内で表示するあなたの名前を入力してください。
          </p>
        </div>
        <JoinFamilyForm initialCode={code ?? ''} />
      </div>
    </main>
  )
}
