/**
 * Determine whether the 404 shell predates this plugin, without touching the
 * real profile.
 *
 * The throwaway instance serves the plugin's own host route while `/` and every
 * client bundle 404, including packages that shipped long before this change.
 * This composes a second profile directory that is a copy of the real one with
 * the plugin's bundle row removed, and boots that, so the only difference
 * between the two runs is this plugin.
 *
 * @module dsh-session-cleanup/scripts/baseline-check
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const cli = join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const logPath = process.env['DSH_DIAG_LOG'] ?? join(process.cwd(), 'baseline.log')
const fd = openSync(logPath, 'a')

const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
const source = join(home, 'profiles', 'web')
const target = join(home, 'profiles', 'web-baseline')

mkdirSync(target, { recursive: true })
for (const file of ['cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
  if (existsSync(join(source, file))) cpSync(join(source, file), join(target, file))
}
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== 'dsh-session-cleanup')
writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
// Reuse the installed packages rather than re-resolving them.
const modules = join(target, 'node_modules')
if (!existsSync(modules)) {
  try {
    symlinkSync(join(source, 'node_modules'), modules, 'junction')
  } catch {
    cpSync(join(source, 'node_modules'), modules, { recursive: true, dereference: false })
  }
}

const port = 3095
// `--profile` is a parent flag and the `web` subcommand rejects parent flags,
// so the parent form is the one that can name a non-default profile.
const child = spawn(process.execPath, [cli, '--profile', 'web-baseline', '--port', String(port), '--no-open'], {
  env: { ...process.env, PATH: `${join(process.env['APPDATA'] ?? '', 'npm')};${process.env['PATH'] ?? ''}` },
  stdio: ['ignore', fd, fd],
})
console.log(`baseline pid ${String(child.pid)} on ${String(port)}`)

let exited = null
child.on('exit', (code) => {
  exited = code
})

let up = false
for (let attempt = 0; attempt < 90 && !up; attempt++) {
  if (exited !== null) {
    console.log(`child exited early: ${String(exited)}`)
    process.exit(1)
  }
  try {
    await fetch(`http://127.0.0.1:${String(port)}/`)
    up = true
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

if (up) {
  for (const path of ['/', '/plugins/dsh-workbuddy-quota/client.js', '/plugins/dsh-session-cleanup/delete']) {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`)
    console.log(`${path} -> ${String(response.status)}`)
  }
} else {
  console.log('never came up')
}

child.kill()
