import Link from 'next/link'

/**
 * ログイン済みだが家族グループ未作成のユーザー向けにホーム画面へ常設する案内カード。
 * 同意モーダル成功時の自動誘導（/family/setup への replace）は「同意した瞬間」しか発火しないため、
 * 既に同意済みのまま家族を作らず離脱したユーザーの受け皿としてこのカードを恒久的に表示する。
 * 表示条件（呼び出し側）はログイン済みかつ family 未参加のみ。ゲストには出さない。
 */
export function FamilySetupNotice() {
  return (
    <section className="max-w-md mx-auto w-full">
      <div className="bg-white border border-gizirotto-blue-200 rounded-lg p-6 space-y-3 text-center">
        <h2 className="text-base font-serif text-gizirotto-blue-900">
          まずはご家族グループを作りましょう
        </h2>
        <p className="text-sm text-gray-700">
          議事録を保存するには、ご家族のグループが必要です。グループのメンバーだけが議事録を見られます。
        </p>
        <Link
          href="/family/setup"
          className="block w-full bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white text-sm font-medium py-2.5 rounded-lg text-center"
        >
          家族をつくる・参加する
        </Link>
      </div>
    </section>
  )
}
