/**
 * End-to-end verification against a freshly booted harness, with authentication.
 *
 * The shell is fenced by a launch token printed in the URL, so an
 * unauthenticated request 401s and the plugin bundle 404s behind that fence —
 * which is exactly what made earlier probes look like a plugin failure. This
 * captures the URL `dsh web` prints, exchanges its token for the signed cookie,
 * and then checks the bundle and the delete route through the same authenticated
 * session the browser uses.
 *
 * `DSH_E2E_HOME` is required and becomes the child's `DSH_HOME`. Without it the
 * child would inherit the caller's home — a real one — and the run would test
 * whichever build happens to be installed there instead of the one under test.
 * That is not a hypothetical: it silently exercised a production home's older
 * plugin copy and reported its bugs as this run's results.
 *
 * @module dsh-session-cleanup/scripts/e2e-auth
 */

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env['DSH_E2E_HOME']
if (home === undefined || home === '') {
  console.error('e2e-auth: set DSH_E2E_HOME to a throwaway harness home (its web profile must have this plugin installed)')
  process.exit(2)
}

const port = Number(process.env['DSH_E2E_PORT'] ?? '3094')
const base = `http://127.0.0.1:${String(port)}`
const cli = join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

// The child's own output is the only place its launch URL appears, so it is
// captured live and mirrored into the test home for post-mortem reading.
const outFile = join(home, 'e2e-auth-server.log')
writeFileSync(outFile, '', 'utf8')

const child = spawn(process.execPath, [cli, 'web', '--port', String(port), '--no-open'], {
  env: {
    ...process.env,
    DSH_HOME: home,
    PATH: `${join(process.env['APPDATA'] ?? '', 'npm')};${process.env['PATH'] ?? ''}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
child.stdout.on('data', (chunk) => {
  output += String(chunk)
})
child.stderr.on('data', (chunk) => {
  output += String(chunk)
})

const failures = []
const report = (condition, message) => {
  if (!condition) failures.push(message)
}

try {
  let token
  for (let attempt = 0; attempt < 120 && token === undefined; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/.exec(output)
    if (match !== null) token = match[1]
  }
  writeFileSync(outFile, output, 'utf8')
  console.log(token === undefined ? 'no launch URL captured' : `captured launch token (${String(token.length)} chars)`)
  console.log(`harness home: ${home}; server output: ${outFile}`)

  if (token === undefined) {
    console.log(`child output so far: ${output.slice(0, 400)}`)
    report(false, 'dsh web printed no launch URL')
  } else {
    // Exchange the token for the signed browser cookie, exactly as the browser does.
    const exchange = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
    const setCookie = exchange.headers.get('set-cookie') ?? ''
    const cookie = setCookie.split(';')[0]
    report(cookie.length > 0, 'the token exchange set no cookie')
    console.log(`token exchange -> ${String(exchange.status)}; cookie: ${cookie === '' ? 'none' : 'present'}`)

    const auth = { cookie }

    // ① The shell renders, and the boot roster names the plugin.
    const shell = await fetch(`${base}/`, { headers: auth })
    const html = await shell.text()
    report(shell.status === 200, `authenticated shell returned ${String(shell.status)}`)
    report(html.includes('dsh-session-cleanup'), 'the boot roster does not name the plugin')
    console.log(`authenticated / -> ${String(shell.status)}; roster names plugin: ${String(html.includes('dsh-session-cleanup'))}`)

    // ② The client bundles the shell advertises, fetched exactly as the page
    //    does. The route serves revisioned combo URLs (`/plugins/??<id>/client.js
    //    ,…&rev=…`); a bare `/plugins/<id>/client.js` is not an address at all,
    //    and the href is HTML-escaped, so `&amp;rev=` must be decoded or the
    //    exact-match lookup correctly 404s.
    const hrefs = [...html.matchAll(/href="(\/plugins\/\?\?[^"]*)"/g)].map((match) =>
      match[1].replaceAll('&amp;', '&'),
    )
    report(hrefs.length > 0, 'the shell advertises no client module URL')
    let served = ''
    for (const href of hrefs) {
      const bundle = await fetch(`${base}${href}`, { headers: auth })
      report(bundle.status === 200, `client modules at ${href.slice(0, 48)}… returned ${String(bundle.status)}`)
      served += await bundle.text()
    }
    report(served.includes('dsh-session-cleanup'), 'the served client modules do not register this plugin')
    // The settings section id proves the bundle carries the page, not just the
    // plugin's name in the boot roster.
    report(served.includes('archived-sessions'), 'the client bundle does not register the settings section')
    console.log(`client modules -> ${String(hrefs.length)} combo url(s), ${String(served.length)} bytes served`)

    // ④ The delete route, authenticated.
    const notPost = await fetch(`${base}/plugins/dsh-session-cleanup/delete`, { headers: auth })
    report(notPost.status === 405, `GET on delete route returned ${String(notPost.status)}`)

    const empty = await fetch(`${base}/plugins/dsh-session-cleanup/delete`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{"ids":[]}',
    })
    report(empty.status === 400, `empty ids returned ${String(empty.status)}`)

    const ghost = await fetch(`${base}/plugins/dsh-session-cleanup/delete`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['session-00000000-0000-0000-0000-000000000000'] }),
    })
    const ghostBody = await ghost.json()
    report(ghost.status === 200, `ghost delete returned ${String(ghost.status)}`)
    report(ghostBody.missing?.length === 1, 'a nonexistent session was not reported missing')
    report(ghostBody.removed?.length === 0, 'a nonexistent session was reported removed')
    // The failure this catches: the route answered 200 and reported the id as
    // "missing", so only `failed` reveals that the archive-set write threw —
    // which is how a delete could remove a log and still leave the id archived.
    report(
      Array.isArray(ghostBody.failed) && ghostBody.failed.length === 0,
      `the delete route reported failures: ${JSON.stringify(ghostBody.failed)}`,
    )
    console.log(`delete route -> GET ${String(notPost.status)}, empty ${String(empty.status)}, ghost ${String(ghost.status)} ${JSON.stringify(ghostBody)}`)
  }
} finally {
  child.kill()
  // Give the child's stdio teardown a turn: killing it and exiting in the same
  // tick trips a libuv assertion on Windows.
  await new Promise((resolve) => setTimeout(resolve, 500))
}

if (failures.length > 0) {
  console.error('e2e-auth FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('e2e-auth ok: shell serves the plugin, bundle is fetchable, delete route validates')
