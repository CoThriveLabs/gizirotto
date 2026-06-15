import Link from 'next/link'
import { FileTextIcon } from './FileTextIcon'

export function EmptyCustomTemplates() {
  return (
    <section className="bg-white border border-[#E5E7EB] rounded-xl p-8 text-center space-y-4">
      <div
        aria-hidden="true"
        className="mx-auto w-16 h-16 rounded-full bg-gizirotto-blue-50 flex items-center justify-center text-gizirotto-blue-500"
      >
        <FileTextIcon size={28} />
      </div>
      <div className="space-y-1">
        <p className="text-base font-bold text-[#1F2937]">
          まだテンプレがありません
        </p>
        <p className="text-sm text-[#6B7280]">
          サンプルから始めるか、ご家庭のテンプレを覚えさせてください
        </p>
      </div>
      <div className="space-y-2 max-w-xs mx-auto">
        <Link
          href="?section=sample"
          className="block w-full bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white text-sm font-medium py-2.5 rounded"
        >
          サンプルから始める
        </Link>
        <Link
          href="/templates/new"
          className="block w-full border border-gizirotto-blue-500 text-gizirotto-blue-700 hover:bg-gizirotto-blue-50 text-sm font-medium py-2.5 rounded"
        >
          ＋ 覚える
        </Link>
      </div>
    </section>
  )
}
