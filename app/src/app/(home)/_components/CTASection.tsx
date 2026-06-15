import Link from 'next/link'

export function CTASection() {
  return (
    <section className="space-y-3 w-full max-w-md mx-auto">
      <Link
        href="/templates?from=cta&intent=ai"
        className="block w-full bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white text-base font-medium py-3 rounded-lg text-center shadow-sm"
      >
        ＋ AI と一緒に議事録をつくる
      </Link>
      <Link
        href="/templates?from=cta&intent=manual"
        className="block w-full border border-gizirotto-blue-500 text-gizirotto-blue-700 hover:bg-gizirotto-blue-50 text-base font-medium py-3 rounded-lg text-center"
      >
        自分で書く
      </Link>
    </section>
  )
}
