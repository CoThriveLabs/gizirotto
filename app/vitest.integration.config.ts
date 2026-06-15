import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Integration テスト用 Vitest 設定。
 * - 環境は node（jsdom ではない）
 * - ローカル Supabase 起動済を前提（外部依存あり）
 * - CI には含めない（GitHub Actions ランナー時間圧迫のため）。手動 `pnpm test:integration` で実行
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // setupFiles は使わない（jest-dom 不要）
  },
})
