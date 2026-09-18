/**
 * Boot a throwaway dsh web instance and verify the plugin's two runtime halves.
 *
 * This is the only check that proves modules import: a bundle can be on disk,
 * listed in the profile, and still fail to load because of a bad export or an
 * import the module table cannot answer. It binds a non-default port so the
 * running GUI is untouched, then asks the server for (a) the client bundle the
 * module system would fetch and (b) the plugin's own delete route.
 *
 * @module dsh-session-cleanup/scripts/e2e-verify
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'

const port = 3099
const cli = join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

// The child's output is discarded rather than piped: a piped stdio child is
// what the confined sandbox denies with EPERM, and this check reads the server
// over HTTP instead of through its log.
const child = spawn(process.execPath, [cli, 'web', '--port', String(port), '--no-open'], {
  env: { ...process.env, PATH: `${join(process.env['APPDATA'] ?? '', 'npm')};${process.env['PATH'] ?? ''}` },
  stdio: 'ignore',
  detached: false,
})

/**
 * Wait for the server to answer on its port.
 * @returns true once any HTTP response arrives.
 */
async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${String(port)}/`, { method: 'HEAD' })
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  return false
}

const failures = []
const report = (condition, message) => {
  if (!condition) failures.push(message)
}

try {
  const up = await waitForServer()
  if (!up) {
    failures.push('the throwaway server never answered')
  } else {
    // ① The bundle route the module system advertises must serve our client half.
    const bundle = await fetch(`http://127.0.0.1:${String(port)}/plugins/dsh-session-cleanup/client.js`)
    report(bundle.status === 200, `client bundle route returned ${String(bundle.status)}`)
    const text = bundle.ok ? await bundle.text() : ''
    report(text.includes('dsh-session-cleanup'), 'client bundle does not register the expected id')
    report(text.includes('archived-sessions'), 'client bundle does not register the settings section')

    // ② The host route must exist and refuse anything but a loopback POST.
    const get = await fetch(`http://127.0.0.1:${String(port)}/plugins/dsh-session-cleanup/delete`)
    report(get.status === 405, `GET on the delete route returned ${String(get.status)}, expected 405`)

    const empty = await fetch(`http://127.0.0.1:${String(port)}/plugins/dsh-session-cleanup/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"ids":[]}',
    })
    report(empty.status === 400, `an empty ids array returned ${String(empty.status)}, expected 400`)

    // A nonexistent session must be reported as missing, never as removed, and
    // must not touch the real archive set.
    const ghost = await fetch(`http://127.0.0.1:${String(port)}/plugins/dsh-session-cleanup/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['session-00000000-0000-0000-0000-000000000000'] }),
    })
    const ghostBody = await ghost.json()
    report(ghost.status === 200, `deleting a ghost session returned ${String(ghost.status)}`)
    report(
      Array.isArray(ghostBody.missing) && ghostBody.missing.length === 1,
      'a nonexistent session was not reported in the missing list',
    )
    report(
      Array.isArray(ghostBody.removed) && ghostBody.removed.length === 0,
      'a nonexistent session was reported as removed',
    )

    // The plugin must appear in the boot roster the shell composes.
    const home = await fetch(`http://127.0.0.1:${String(port)}/`)
    if (home.status === 200) {
      const html = await home.text()
      report(html.includes('dsh-session-cleanup'), 'the served shell does not list the plugin')
    }
  }
} finally {
  child.kill()
}

if (failures.length > 0) {
  console.error('e2e-verify FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('e2e-verify ok: bundle served, delete route mounted and validating, plugin in the boot roster')
