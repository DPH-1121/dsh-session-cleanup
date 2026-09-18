/**
 * Start the throwaway server and, once it answers, run the boot inspector
 * against it before shutting it down.
 *
 * Keeping the server and the probe in one process avoids leaving a stray
 * listener behind between steps.
 *
 * @module dsh-session-cleanup/scripts/e2e-probe
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

let answered = false
for (let attempt = 0; attempt < 60 && !answered; attempt++) {
  try {
    await fetch(`http://127.0.0.1:${String(port)}/`, { method: 'HEAD' })
    answered = true
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

if (!answered) {
  console.log('server never answered; see ' + logPath)
  child.kill()
  process.exit(1)
}

process.env['DSH_E2E_PORT'] = String(port)
const probe = spawn(process.execPath, [join(import.meta.dirname, 'inspect-boot.mjs')], { stdio: 'inherit' })
await new Promise((resolve) => probe.on('exit', resolve))

child.kill()
