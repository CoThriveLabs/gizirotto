/**
 * 既知 商用ロゴ DB。
 *
 * 各エントリは「ロゴ画像 + メタ情報」のメタデータ。
 * 画像ファイル本体は `app/src/lib/copyright/known-logos/<id>.png` として
 * 開発者 / ビルド時に取得する想定（git 管理外、ライセンス再配布回避）。
 *
 * 重要:
 *   - 本 DB は **検出 → 警告 → ユーザー確認** のみに使用、自動拒否しない
 *   - 運用追加: 削除リクエスト / 誤検出ユーザー報告を契機に追記
 *   - 各エントリの "出典" は公開情報として明示
 *
 * 検出方式（L1 + L2 ハイブリッド）:
 *   - L1: perceptual hash (pHash) で 8x8 ダウンサンプル後の DCT 一致を判定
 *   - L2: Claude Vision で「会社ロゴ / 商用テンプレートウォーターマーク」を確認
 *
 * 画像ファイル取得方針:
 *   - 現状は「メタデータ + 検出キーワード辞書」のみで動作確認
 *   - 実画像 pHash 照合は画像ファイルを別途配置できた時に有効化
 *   - 画像ファイルなしでも Claude Vision (L2) は動作可能
 */

export interface KnownLogoEntry {
  /** 一意 ID（snake_case） */
  id: string
  /** 提供元（公開情報、ベンダー名 / サイト名） */
  vendor: string
  /** カテゴリ */
  category: 'paid_template_marketplace' | 'corporate_template_vendor' | 'stock_pdf_provider'
  /** 検出時にユーザー警告に含めるラベル（日本語、専門用語禁止） */
  warningLabel: string
  /** 出典 URL（運用ログ / 監査のため） */
  sourceUrl: string
  /** ロゴに含まれる典型的キーワード（L2 Claude Vision に hint として渡す） */
  keywordHints: string[]
}

/**
 * 初期 10 件（運用しながら追加していく方針）。
 *
 * 選定基準:
 *   - 主要有償議事録テンプレ販売サイト
 *   - 会社議事録テンプレ印刷物ベンダー
 *   - 上位検索ヒットする商用ロゴ
 */
export const KNOWN_COMMERCIAL_LOGOS: KnownLogoEntry[] = [
  {
    id: 'bizocean',
    vendor: 'ビズオーシャン (bizocean)',
    category: 'paid_template_marketplace',
    warningLabel: 'ビズオーシャン（有償テンプレ販売）',
    sourceUrl: 'https://www.bizocean.jp/',
    keywordHints: ['bizocean', 'ビズオーシャン'],
  },
  {
    id: 'bizroute',
    vendor: 'ビズルート',
    category: 'paid_template_marketplace',
    warningLabel: 'ビズルート（有償テンプレ販売）',
    sourceUrl: 'https://bizroute.net/',
    keywordHints: ['bizroute', 'ビズルート'],
  },
  {
    id: 'all_different',
    vendor: 'All-different.jp',
    category: 'paid_template_marketplace',
    warningLabel: 'All-different.jp（有償テンプレ販売）',
    sourceUrl: 'https://all-different.jp/',
    keywordHints: ['all-different', 'オールディファレント'],
  },
  {
    id: 'template_box',
    vendor: 'テンプレートBOX',
    category: 'paid_template_marketplace',
    warningLabel: 'テンプレートBOX（有償テンプレ販売）',
    sourceUrl: 'https://template-box.com/',
    keywordHints: ['template-box', 'テンプレートbox', 'テンプレートBOX'],
  },
  {
    id: 'kingsoft',
    vendor: 'KINGSOFT (WPS)',
    category: 'stock_pdf_provider',
    warningLabel: 'KINGSOFT WPS（テンプレ集）',
    sourceUrl: 'https://www.kingsoft.jp/',
    keywordHints: ['kingsoft', 'wps', 'キングソフト'],
  },
  {
    id: 'microsoft_create',
    vendor: 'Microsoft Create',
    category: 'stock_pdf_provider',
    warningLabel: 'Microsoft Create（公式テンプレ集）',
    sourceUrl: 'https://create.microsoft.com/',
    keywordHints: ['microsoft create', 'microsoft', '©microsoft'],
  },
  {
    id: 'canva',
    vendor: 'Canva',
    category: 'paid_template_marketplace',
    warningLabel: 'Canva（有償テンプレ含む）',
    sourceUrl: 'https://www.canva.com/',
    keywordHints: ['canva', 'designed in canva', 'made with canva'],
  },
  {
    id: 'envato',
    vendor: 'Envato (GraphicRiver)',
    category: 'paid_template_marketplace',
    warningLabel: 'Envato GraphicRiver（有償素材）',
    sourceUrl: 'https://graphicriver.net/',
    keywordHints: ['envato', 'graphicriver'],
  },
  {
    id: 'kokuyo',
    vendor: 'コクヨ',
    category: 'corporate_template_vendor',
    warningLabel: 'コクヨ（印刷物ベンダー）',
    sourceUrl: 'https://www.kokuyo.co.jp/',
    keywordHints: ['kokuyo', 'コクヨ', '©kokuyo'],
  },
  {
    id: 'plus_corp',
    vendor: 'PLUS',
    category: 'corporate_template_vendor',
    warningLabel: 'PLUS（オフィス用品ベンダー）',
    sourceUrl: 'https://www.plus.co.jp/',
    keywordHints: ['plus', 'プラス株式会社'],
  },
]

/** ID で 1 件取得 */
export function getKnownLogoById(id: string): KnownLogoEntry | undefined {
  return KNOWN_COMMERCIAL_LOGOS.find(l => l.id === id)
}

/** 全エントリの keywordHints をフラットに返す */
export function getAllKeywordHints(): string[] {
  return KNOWN_COMMERCIAL_LOGOS.flatMap(l => l.keywordHints)
}
