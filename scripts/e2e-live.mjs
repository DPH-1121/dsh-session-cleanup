/**
 * Boot a throwaway server and probe its routes while it is still alive.
 *
 * Two earlier attempts failed for environmental reasons rather than plugin
 * reasons: one probed the auth-gated live GUI instead of the throwaway, and one
 * probed after the child had already exited. This keeps the child alive for the
 * whole probe and reports its exit code, so a dead server is distinguishable
 * from a missing route.
 *
 * `DSH_E2E_HOME` is required and becomes the child's `DSH_HOME`: without it the
 * child would inherit the caller's home and probe whatever build is installed
 * there rather than the one under test.
 *
 * @module dsh-session-cleanup/scripts/e2e-live
 */

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env['DSH_E2E_HOME']
if (home === undefined || home === '') {
  console.error('e2e-live: set DSH_E2E_HOME to a throwaway harness home (its web profile must have this plugin installed)')
  process.exit(2)
}

const port = Number(process.env['DSH_E2E_PORT'] ?? '3096')
const base = `http://127.0.0.1:${String(port)}`
const logPath = process.env['DSH_E2E_LOG'] ?? join(process.cwd(), 'e2e-server.log')
const cli = join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const fd = openSync(logPath, 'a')
const child = spawn(process.execPath, [cli, 'web', '--port', String(port), '--no-open'], {
  env: {
    ...process.env,
    DSH_HOME: home,
    PATH: `${join(process.env['APPDATA'] ?? '', 'npm')};${process.env['PATH'] ?? ''}`,
  },
  stdio: ['ignore', fd, fd],
})

let exited = null
child.on('exit', (code) => {
  exited = code
})

const failures = []
const report = (condition, message) => {
  if (!condition) failures.push(message)
}

/**
 * Probe one route and report its status.
 * @param path - the path to request.
 * @param init - optional fetch options.
 * @returns the response, or undefined when the request failed.
 */
async function probe(path, init) {
  try {
    return await fetch(`${base}${path}`, init)
  } catch (error) {
    console.log(`  ${path} -> ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

let answered = false
for (let attempt = 0; attempt < 90 && !answered; attempt++) {
  if (exited !== null) {
    console.log(`child exited early with code ${String(exited)}; log: ${logPath}`)
    process.exit(1)
  }
  const response = await probe('/')
  // A connection refusal means nothing is listening yet; any HTTP status means
  // this child's server is up, including a 404 from a surface still composing.
  if (response !== undefined) {
    answered = true
    console.log(`GET / -> ${String(response.status)} (server is up)`)
  } else {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

if (!answered) {
  console.log(`server never answered; exit=${String(exited)}; log: ${logPath}`)
  child.kill()
  process.exit(1)
}

console.log(`exit so far: ${String(exited)}`)

// The shell and every plugin bundle, unauthenticated.
for (const path of ['/', '/plugins/dsh-session-cleanup/client.js', '/plugins/dsh-workbuddy-quota/client.js']) {
  const response = await probe(path)
  if (response !== undefined) console.log(`  ${path} -> ${String(response.status)} ${response.headers.get('content-type') ?? ''}`)
}

// The plugin's delete route.
for (const [label, init] of [
  ['GET', undefined],
  ['POST empty', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ids":[]}' }],
  ['POST ghost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ids":["session-00000000-0000-0000-0000-000000000000"]}' }],
]) {
  const response = await probe('/plugins/dsh-session-cleanup/delete', init)
  if (response === undefined) continue
  const body = await response.text()
  console.log(`  delete ${label} -> ${String(response.status)} ${body.slice(0, 160)}`)
  if (label === 'GET') report(response.status === 405, `GET on delete route returned ${String(response.status)}`)
  if (label === 'POST empty') report(response.status === 400, `empty ids returned ${String(response.status)}`)
  if (label === 'POST ghost') report(response.status === 200, `ghost delete returned ${String(response.status)}`)
}

// The client bundle content the module system would fetch.
const bundle = await probe('/plugins/dsh-session-cleanup/client.js')
if (bundle?.ok === true) {
  const text = await bundle.text()
  report(text.includes('dsh-session-cleanup'), 'client bundle does not register the plugin id')
  report(text.includes('archived-sessions'), 'client bundle does not register the settings section')
}

console.log(`exit after probes: ${String(exited)}`)
child.kill()

if (failures.length > 0) {
  console.error('e2e FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('e2e ok: server stayed up, bundle served, delete route mounted and validating')
