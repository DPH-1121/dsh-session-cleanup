/**
 * Decide whether the throwaway instance actually serves the web surface.
 *
 * Every route 404s — including bundles that shipped before this change — while
 * the plugin's own host route answers. That combination means the process is
 * listening but the web surface never composed. This prints the raw response
 * for `/` and the CLI's own startup output, captured through an inherited file
 * descriptor (piped children are refused by the sandbox).
 *
 * @module dsh-session-cleanup/scripts/diagnose-web
 */

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { join } from 'node:path'

const port = 3098
const cli = join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const logPath = process.env['DSH_DIAG_LOG'] ?? join(process.cwd(), 'diagnose.log')
const fd = openSync(logPath, 'a')

const child = spawn(process.execPath, [cli, 'web', '--port', String(port), '--no-open'], {
  env: { ...process.env, PATH: `${join(process.env['APPDATA'] ?? '', 'npm')};${process.env['PATH'] ?? ''}` },
  stdio: ['ignore', fd, fd],
})
console.log(`child pid ${String(child.pid)}, logging to ${logPath}`)

let up = false
for (let attempt = 0; attempt < 60 && !up; attempt++) {
  try {
    await fetch(`http://127.0.0.1:${String(port)}/`)
    up = true
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

if (!up) {
  console.log('never came up')
} else {
  for (const path of ['/', '/plugins', '/plugins/dsh-session-cleanup/client.js']) {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`)
    const text = await response.text()
    console.log(`${path} -> ${String(response.status)} :: ${text.slice(0, 200).replace(/\n/g, ' ')}`)
  }
}

child.kill()
