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
};

export default nextConfig;
