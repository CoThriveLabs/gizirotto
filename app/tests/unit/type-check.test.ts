import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import path from 'node:path'

/**
 * `tsc --noEmit` 相当の型チェックを Vitest 経由で実行する。
 * - tsconfig.json を読み込み、Compiler API で全 .ts/.tsx をチェック
 * - エラーがあればテスト失敗 + 詳細出力
 */
describe('TypeScript type check (tsc --noEmit equivalent)', () => {
  it('has zero type errors across project', () => {
    const cwd = path.resolve(__dirname, '..', '..')
    const cfgPath = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json')
    expect(cfgPath, 'tsconfig.json must exist').toBeDefined()

    const cfg = ts.readConfigFile(cfgPath!, ts.sys.readFile)
    expect(cfg.error, 'tsconfig.json must be valid').toBeUndefined()

    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, cwd)
    // createProgram 経由では incremental + noEmit の組み合わせで TS5074 が出るので
    // 型チェック実行時のみ抑制（実際の build 設定には影響なし）
    const options: ts.CompilerOptions = {
      ...parsed.options,
      incremental: false,
      tsBuildInfoFile: undefined,
    }
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options,
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)

    if (diagnostics.length > 0) {
      const host: ts.FormatDiagnosticsHost = {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => cwd,
        getNewLine: () => ts.sys.newLine,
      }
      const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, host)
      // eslint-disable-next-line no-console
      console.error('Type errors detected:\n' + formatted)
    }

    expect(diagnostics.length, 'expected zero type errors').toBe(0)
  }, 60_000)
})
