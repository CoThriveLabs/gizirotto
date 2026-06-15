import { TemplateCard, type TemplateCardData, type TemplateCardMode } from './TemplateCard'
import Link from 'next/link'

interface Props {
  title: string
  subtitle?: string
  templates: TemplateCardData[]
  variant: 'sample' | 'custom'
  mode: TemplateCardMode
  intent: 'ai' | 'manual'
  actionLabel?: string
  actionHref?: string
  /** SP の section 切替リンク（モバイル時のみ表示） */
  sectionToggle?: { label: string; href: string }
}

const COLS_BY_VARIANT = {
  sample: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-3',
  custom: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
} as const

export function TemplateSection({
  title,
  subtitle,
  templates,
  variant,
  mode,
  intent,
  actionLabel,
  actionHref,
  sectionToggle,
}: Props) {
  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[#1F2937]">{title}</h2>
          {subtitle && <p className="text-xs text-[#6B7280] mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-3">
          {sectionToggle && (
            <Link
              href={sectionToggle.href}
              className="md:hidden text-sm text-gizirotto-blue-700 hover:underline"
            >
              {sectionToggle.label}
            </Link>
          )}
          {actionLabel && actionHref && (
            <Link
              href={actionHref}
              className="text-sm border border-gizirotto-blue-500 text-gizirotto-blue-700 hover:bg-gizirotto-blue-50 rounded px-3 py-1.5"
            >
              {actionLabel}
            </Link>
          )}
        </div>
      </header>
      <ul className={`grid gap-3 sm:gap-4 ${COLS_BY_VARIANT[variant]}`}>
        {templates.map((t) => (
          <li key={t.id}>
            <TemplateCard
              template={t}
              variant={variant}
              mode={mode}
              intent={intent}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}
