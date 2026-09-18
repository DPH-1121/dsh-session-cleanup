/**
 * Boot a throwaway dsh web instance and capture its startup log to a file.
 *
 * `stdio: 'ignore'` hides exactly the errors this needs to see, and a piped
 * child is refused by the sandbox — so the child writes to an inherited file
 * descriptor, which is neither.
 *
 * @module dsh-session-cleanup/scripts/e2e-log
 */

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { join } from 'node:path'

const port = 3099
const logPath = process.env['DSH_E2E_LOG'] ?? join(process.cwd(), 'e2e-server.log')
const cli = join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const fd = openSync(logPath, 'a')
const child = spawn(process.execPath, [cli, 'web', '--port', String(port), '--no-open'], {
  env: { ...process.env, PATH: `${join(process.env['APPDATA'] ?? '', 'npm')};${process.env['PATH'] ?? ''}` },
  stdio: ['ignore', fd, fd],
})

console.log(`started pid ${String(child.pid)} on port ${String(port)}, log ${logPath}`)

let answered = false
for (let attempt = 0; attempt < 60 && !answered; attempt++) {
  try {
    await fetch(`http://127.0.0.1:${String(port)}/`, { method: 'HEAD' })
    answered = true
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

console.log(answered ? 'server answered' : 'server never answered')
child.kill()
