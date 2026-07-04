// Supabase Storage signed URL を next/image で許可するため
// NEXT_PUBLIC_SUPABASE_URL から hostname を動的取得して remotePatterns に登録する。
// 環境変数が未設定の場合（ローカル / CI の一部）は *.supabase.co ワイルドカードに fallback。
const supabaseHost = (() => {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!raw) return undefined
  try {
    return new URL(raw).hostname
  } catch {
    return undefined
  }
})()

const supabaseRemotePatterns = supabaseHost
  ? [
      {
        protocol: 'https',
        hostname: supabaseHost,
        pathname: '/storage/v1/object/**',
      },
    ]
  : [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/**',
      },
    ]

// ============================================================
// セキュリティヘッダ定義
// 全レスポンスに付与する HTTP セキュリティヘッダ。next.config の
// headers() フックで /:path* に一括適用する。
//
// CSP は Report-Only モードで導入する（運用しながら violations を
// Console 監視 → 別 PR で Content-Security-Policy へ昇格）。
//
// Why next.config.mjs:
//   middleware は認証 / IP burst / cookie 処理などの動的処理が走るため
//   静的セキュリティヘッダの責務を混ぜない。next.config.headers() なら
//   build 時最適化と整合性が取れる。
// ============================================================

const CSP_DIRECTIVES = [
  "default-src 'self'",
  // Next.js App Router の inline runtime script + Turnstile widget JS
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  // Tailwind runtime + React style prop
  "style-src 'self' 'unsafe-inline'",
  // next/image (data:/blob:) + Supabase Storage signed URL
  "img-src 'self' data: blob: https://*.supabase.co",
  // system フォント + data URI フォント
  "font-src 'self' data:",
  // Supabase REST / Realtime(WSS) / Edge Functions + Turnstile siteverify
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://challenges.cloudflare.com",
  // Turnstile invisible widget iframe
  "frame-src https://challenges.cloudflare.com",
  // 任意の iframe 埋め込み拒否
  "frame-ancestors 'none'",
  // POST 先は同一 origin のみ
  "form-action 'self'",
  // base タグ書換攻撃防止
  "base-uri 'self'",
  // <object> / <embed> / <applet> 拒否
  "object-src 'none'",
  // http 含む混在コンテンツを https に昇格
  'upgrade-insecure-requests',
].join('; ')

export const SECURITY_HEADERS = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains',
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value:
      'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  // Report-Only で運用 → 一定期間 violations 観測後に別 PR で Content-Security-Policy へ昇格
  { key: 'Content-Security-Policy-Report-Only', value: CSP_DIRECTIVES },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  images: {
    remotePatterns: supabaseRemotePatterns,
  },
  // B-3 inline 化対応 (2026-05-28): worker code 内で動的 import する pdfjs-dist と
  // @napi-rs/canvas を webpack バンドル対象から外す。@napi-rs/canvas は .node native binary
  // を含むため、factory の side-effect import 経由で webpack に bundle されると
  // "Module parse failed: Unexpected character" で build fail する。
  // serverExternalPackages 指定で webpack はバンドルせず runtime で require()、
  // outputFileTracingIncludes の静的トレースは引き続き node_modules を Function bundle に含める。
  // Next.js 15 で experimental.serverComponentsExternalPackages からトップレベル昇格済。
  // N-13 真因対策 (2026-05-29): tesseract.js も serverExternalPackages へ追加。
  // createWorker → spawnWorker → new Worker(workerPath) が __dirname ベースの動的 path で
  // worker-script/node/index.js を解決するため webpack static trace で追えず、Vercel
  // /var/task バンドルに同梱されない (MODULE_NOT_FOUND → recognize hang → 60s timeout)。
  // pdfjs と同じく runtime require 経路へ逃がし、outputFileTracingIncludes で
  // node_modules ごと Function bundle に含めさせる。
  serverExternalPackages: ['@napi-rs/canvas', 'pdfjs-dist', 'tesseract.js'],
  outputFileTracingIncludes: {
    '/*': [
      './src/lib/workers/**/*',
      './node_modules/pdfjs-dist/standard_fonts/**',
      './node_modules/pdfjs-dist/legacy/build/**',
      './assets/fonts/**',
      // N-13: tesseract.js worker entry + 周辺 (constants/utils を index.js が require)。
      // node/ 配下だけだと別ファイル要求で再発するため worker-script 全体 + src 全体を同梱。
      './node_modules/tesseract.js/src/**',
      './node_modules/tesseract.js/src/worker-script/**',
      // wasm バリアント (SIMD/relaxed/lstm) は runtime で CPU 機能検出して選択するため全部同梱。
      './node_modules/tesseract.js-core/**',
      // jpn.traineddata は app/ 直下 → /var/task 直下に展開 (langPath: process.cwd() + '/')。
      './jpn.traineddata',
    ],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: SECURITY_HEADERS,
      },
    ]
  },
};

export default nextConfig;
