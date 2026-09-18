/**
 * Run the web profile exactly as the launcher does and report the raw outcome.
 *
 * The child has been exiting with no output and no listener, which hides the
 * cause. This runs it synchronously with piped output and prints everything,
 * so the failure is visible instead of inferred.
 *
 * @module dsh-session-cleanup/scripts/run-once
 */

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { join } from 'node:path'

const cli = join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const logPath = process.env['DSH_DIAG_LOG'] ?? join(process.cwd(), 'run-once.log')
const fd = openSync(logPath, 'a')

// `--help` first: proves the parser accepts the subcommand at all.
const help = spawn(process.execPath, [cli, 'web', '--help'], { stdio: ['ignore', fd, fd] })
await new Promise((resolve) => help.on('exit', resolve))

// Then the real boot, held open briefly so startup output is captured.
const boot = spawn(process.execPath, [cli, 'web', '--port', '3097', '--no-open'], {
  env: { ...process.env, PATH: `${join(process.env['APPDATA'] ?? '', 'npm')};${process.env['PATH'] ?? ''}` },
  stdio: ['ignore', fd, fd],
})
console.log(`boot pid ${String(boot.pid)}`)
let code = null
boot.on('exit', (value) => {
  code = value
})
await new Promise((resolve) => setTimeout(resolve, 12000))
console.log(`exit after 12s: ${String(code)}`)
boot.kill()
await new Promise((resolve) => setTimeout(resolve, 500))
