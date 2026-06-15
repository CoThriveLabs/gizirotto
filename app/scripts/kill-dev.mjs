import { execSync } from 'node:child_process'

try {
  const out = execSync('netstat -ano -p TCP', { encoding: 'utf8' })
  const lines = out.split('\n').filter((l) => l.includes(':3000') && l.includes('LISTENING'))
  const pids = new Set()
  for (const line of lines) {
    const parts = line.trim().split(/\s+/)
    const pid = parts[parts.length - 1]
    if (/^\d+$/.test(pid)) pids.add(pid)
  }
  if (pids.size === 0) {
    console.log('no listener on :3000')
  } else {
    for (const pid of pids) {
      try {
        execSync('taskkill /F /T /PID ' + pid, { stdio: 'inherit' })
        console.log('killed pid=' + pid)
      } catch (e) {
        console.log('failed pid=' + pid + ' err=' + e.message)
      }
    }
  }
} catch (e) {
  console.error('error: ' + e.message)
  process.exit(1)
}
