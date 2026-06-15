// 型チェックを TypeScript Compiler API で実行する。
// `tsc --noEmit` 起動が環境的にブロックされる場合の代替。
const ts = require('typescript')

const cfgPath = ts.findConfigFile('./', ts.sys.fileExists, 'tsconfig.json')
if (!cfgPath) {
  console.error('tsconfig.json not found')
  process.exit(2)
}
const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile)
if (cfg.error) {
  console.error(ts.flattenDiagnosticMessageText(cfg.error.messageText, '\n'))
  process.exit(2)
}
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, './')

const program = ts.createProgram(parsed.fileNames, parsed.options)
const diagnostics = ts.getPreEmitDiagnostics(program)

if (diagnostics.length === 0) {
  console.log('Type check: 0 errors')
  process.exit(0)
}

console.log('Type check: ' + diagnostics.length + ' error(s)')
const host = {
  getCanonicalFileName: (f) => f,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine,
}
process.stdout.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, host))
process.exit(1)
