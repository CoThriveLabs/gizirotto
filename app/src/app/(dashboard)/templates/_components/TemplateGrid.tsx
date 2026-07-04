import { TemplateSection } from './TemplateSection'
import { EmptyCustomTemplates } from './EmptyCustomTemplates'
import type { TemplateCardData, TemplateCardMode } from './TemplateCard'

interface Props {
  samples: TemplateCardData[]
  customs: TemplateCardData[]
  mode: TemplateCardMode
  intent: 'ai' | 'manual'
  /** SP 用: 'all' = 0件時のみ、'sample' = サンプル単独、'custom' = 読み込み済単独 */
  spSection: 'all' | 'sample' | 'custom'
  /**
   * false のとき「読み込み済」セクションを非表示にし、テンプレ追加 CTA を
   * /login?next=/templates/new へのリンクに差し替える。
   */
  isAuthenticated?: boolean
}

export function TemplateGrid({
  samples,
  customs,
  mode,
  intent,
  spSection,
  isAuthenticated = true,
}: Props) {
  // PC は両セクション常時表示 (spec §1-6 / design v1.6 §19)。
  // SP は spSection でタブ排他切替し、md 以上は両方とも表示する。
  const customsEmpty = customs.length === 0
  const spShowSample = spSection === 'sample' || spSection === 'all'
  const spShowCustom = spSection === 'custom' || spSection === 'all'

  // 未ログイン時は「読み込み済」セクションと「テンプレ追加」CTA を非表示にし、
  // 代わりにログイン誘導リンクを「テンプレ追加」の位置に表示する。
  const addTemplateHref = isAuthenticated ? '/templates/new' : '/login?next=/templates/new'
  const addTemplateLabel = isAuthenticated ? '＋ 新しく覚える' : undefined

  return (
    <div className="space-y-8">
      {isAuthenticated && !customsEmpty && (
        <div className={spShowCustom ? 'block' : 'hidden md:block'}>
          <TemplateSection
            title="読み込み済"
            subtitle="ご家族で使っているテンプレを覚えさせられます"
            templates={customs}
            variant="custom"
            mode={mode}
            intent={intent}
            actionLabel={addTemplateLabel}
            actionHref={addTemplateHref}
            sectionToggle={{ label: 'サンプル →', href: '?section=sample' }}
          />
        </div>
      )}

      {isAuthenticated && customsEmpty && spShowCustom && (
        <div className="block md:hidden">
          <EmptyCustomTemplates />
        </div>
      )}
      {isAuthenticated && customsEmpty && (
        <div className="hidden md:block">
          <EmptyCustomTemplates />
        </div>
      )}

      <div className={spShowSample ? 'block' : 'hidden md:block'}>
        <TemplateSection
          title="サンプル"
          subtitle="最初から用意されているテンプレです"
          templates={samples}
          variant="sample"
          mode={mode}
          intent={intent}
          sectionToggle={
            isAuthenticated && !customsEmpty
              ? { label: '← 読み込み済', href: '?' }
              : undefined
          }
          actionLabel={!isAuthenticated ? '＋ テンプレを追加する' : undefined}
          actionHref={!isAuthenticated ? addTemplateHref : undefined}
        />
      </div>
    </div>
  )
}
