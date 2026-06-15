import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Next.js の `server-only` パッケージは require 時に throw する仕様だが、
      // vitest 環境では import 自体が解決できないため空 stub に差し替える。
      // server-only モジュールの import 自体は副作用のみ（クライアントから
      // import されると build エラーになる）なので空モジュール扱いで足りる。
      'server-only': path.resolve(__dirname, './tests/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'node_modules/**', '.next/**'],
  },
})
