/**
 * End-to-end deletion against a real harness.
 *
 * `host-verify` proves the handler's logic against a fixture; this proves the
 * whole path a user actually takes — a booted `dsh web`, the mounted route, the
 * real Workspace registry, and the real `workspace.json` write — because the
 * bug this covers lived in the wiring between them, not in either half.
 *
 * The fixture reproduces both states a deletion meets:
 *
 *   - a session whose log directory is still on disk → must be `removed`;
 *   - a session whose log is already gone while its id is still archived →
 *     must be `missing`, and its archive entry must still be cleared. That is
 *     the residue the old wiring left behind: the log was removed, the write
 *     that drops the id threw, and the id stayed archived forever.
 *
 * `DSH_E2E_HOME` must name a throwaway harness home whose `web` profile has
 * this plugin installed; the script seeds `sessions/` and `storages/` in it and
 * refuses to run against a home that already holds a workspace registry, so it
 * can never aim this destructive path at a real `~/.dsh`.
 *
 * @module dsh-session-cleanup/scripts/e2e-delete
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const host = await import(new URL('../lib/index.js', import.meta.url).href)

const home = process.env['DSH_E2E_HOME']
if (home === undefined || home === '') {
  console.error('e2e-delete: set DSH_E2E_HOME to a throwaway harness home (its web profile must have this plugin installed)')
  process.exit(2)
}

const port = Number(process.env['DSH_E2E_PORT'] ?? '3097')
const base = `http://127.0.0.1:${String(port)}`
const cli = join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const project = 'D:\\deepseek'

const liveId = 'session-11111111-1111-4111-8111-111111111111'
const ghostId = 'session-22222222-2222-4222-8222-222222222222'
const workspaceId = '33333333-3333-4333-8333-333333333333'

const workspaceState = join(home, 'storages', 'workspace.json')
if (existsSync(workspaceState)) {
  console.error(`e2e-delete: ${workspaceState} already exists; point DSH_E2E_HOME at a fresh home`)
  process.exit(2)
}

// Seed the fixture. The log *directory* is all step 1 addresses, so the live
// session carries a marker file rather than a session log: persistence skips a
// directory with no recognized artifact, which keeps the fixture honest about
// what the delete touches without inventing a log format.
const projectDir = join(home, 'sessions', host.projectKey(project))
const liveDir = join(projectDir, host.encodeSegment(liveId))
mkdirSync(liveDir, { recursive: true })
writeFileSync(join(liveDir, 'payload.txt'), 'session fixture', 'utf8')
mkdirSync(join(home, 'storages'), { recursive: true })
const now = new Date().toISOString()
writeFileSync(
  workspaceState,
  JSON.stringify(
    {
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        workspaceIds: [workspaceId],
        // Ghost first: it is the entry the old wiring could never clear.
        archivedSessionIds: [ghostId, liveId],
      },
      tables: {
        workspaces: {
          [workspaceId]: {
            path: project,
            title: 'deepseek',
            sessionIds: [liveId, ghostId],
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    },
    null,
    2,
  ),
  'utf8',
)

const failures = []
const report = (condition, message) => {
  if (!condition) failures.push(message)
}

const logPath = join(home, 'e2e-delete-server.log')
writeFileSync(logPath, '', 'utf8')

// The child prints its launch URL; it is read from the inherited pipes rather
// than from a log file because the URL is the only place the token appears.
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

/**
 * Read the archived ids the harness has durably committed.
 * @returns the current archive set, or undefined while the file still holds the seed.
 */
function committedArchive() {
  try {
    return JSON.parse(readFileSync(workspaceState, 'utf8')).global.archivedSessionIds
  } catch {
    return undefined
  }
}

try {
  let token
  for (let attempt = 0; attempt < 120 && token === undefined; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/.exec(output)
    if (match !== null) token = match[1]
  }
  if (token === undefined) {
    console.log(`child output: ${output.slice(0, 1200)}`)
    report(false, 'dsh web printed no launch URL')
  } else {
    writeFileSync(logPath, output, 'utf8')
    console.log(`captured launch token (${String(token.length)} chars) on ${base}`)

    const exchange = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
    const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0]
    report(cookie.length > 0, 'the token exchange set no cookie')
    const auth = { cookie, 'content-type': 'application/json' }

    /**
     * Ask the route to delete the given ids.
     * @param ids - the session ids to delete.
     * @returns the status and parsed body.
     */
    const remove = async (ids) => {
      const response = await fetch(`${base}/plugins/dsh-session-cleanup/delete`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ ids }),
      })
      return { status: response.status, body: await response.json() }
    }

    const first = await remove([liveId, ghostId])
    console.log(`delete -> ${String(first.status)} ${JSON.stringify(first.body)}`)
    report(first.status === 200, `delete returned ${String(first.status)}`)
    report(
      first.body.removed?.length === 1 && first.body.removed[0] === liveId,
      `the removed list did not name only the session whose log existed: ${JSON.stringify(first.body.removed)}`,
    )
    report(
      first.body.missing?.length === 1 && first.body.missing[0] === ghostId,
      `the missing list did not name the already-deleted session: ${JSON.stringify(first.body.missing)}`,
    )
    report(
      Array.isArray(first.body.failed) && first.body.failed.length === 0,
      `the archive set was not cleared for every id: ${JSON.stringify(first.body.failed)}`,
    )

    // Step 1 on disk, and the step-2 write the harness had to commit durably.
    report(!existsSync(liveDir), 'the deleted session directory is still on disk')
    report(existsSync(projectDir), 'deletion removed the project directory itself')
    for (let attempt = 0; attempt < 20; attempt++) {
      const committed = committedArchive()
      if (committed !== undefined && committed.length === 0) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const committed = committedArchive()
    report(
      Array.isArray(committed) && committed.length === 0,
      `the durable archive set still holds ${JSON.stringify(committed)}`,
    )

    // Repeating the request against the now-cleared state must stay clean: no
    // failure, and nothing left to retire.
    const second = await remove([liveId, ghostId])
    console.log(`repeat -> ${String(second.status)} ${JSON.stringify(second.body)}`)
    report(
      Array.isArray(second.body.failed) && second.body.failed.length === 0,
      `a repeat delete reported failures: ${JSON.stringify(second.body.failed)}`,
    )
    report(second.body.removed?.length === 0, 'a repeat delete reported a removal that could not happen')
  }
} finally {
  child.kill()
  await new Promise((resolve) => setTimeout(resolve, 500))
}

if (failures.length > 0) {
  console.error('e2e-delete FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error(`server output: ${logPath}`)
  process.exit(1)
}
console.log('e2e-delete ok: route removed the log, cleared every archive entry, and stayed clean on repeat')
