/**
 * Exercise the host half's destructive path against a fixture session tree.
 *
 * The real `~/.dsh/sessions` is never touched: the fixture reproduces the
 * backend's layout (project key directory, encoded session directory, log
 * artifact) so the test proves the two things that matter — that a session
 * under a *different* project directory is still found, and that deletion
 * removes exactly one session and nothing else.
 *
 * The request path is driven through `apply()`, not by handing the handler a
 * plain object, because that is where this plugin has actually failed before:
 * `apply()` mounted the route from a scope that injected only `webServer` and
 * then passed that scope's *parent* to the handler, so the archive-set write
 * threw `cannot get property "workspaceRegistry" without inject` on every
 * request — after the log directory had already been removed. The `fakeApp`
 * below reproduces that Cordis rule (an undeclared service property throws;
 * only the injected scope exposes it), so a regression to the old wiring fails
 * here instead of in a user's archive.
 *
 * @module dsh-session-cleanup/scripts/host-verify
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const host = await import(new URL('../lib/index.js', import.meta.url).href)

const failures = []
/**
 * Record a failed expectation.
 * @param condition - whether the expectation held.
 * @param message - the description to report when it did not.
 */
function check(condition, message) {
  if (!condition) failures.push(message)
}

/**
 * Build the smallest context pair that reproduces Cordis's service rules.
 *
 * `inject` mounts its callback only when every named service is provided, and
 * the scope it passes exposes exactly those names. Reading any other service
 * off either context throws the error Cordis throws, which is the property the
 * plugin's wiring must respect; `effect()` runs its factory like a real fiber
 * effect so a registration mistake is still observable.
 * @param services - the provided services, by name.
 * @returns the root context plus the routes registered through it.
 */
function fakeApp(services) {
  const routes = []
  const missing = (prop) => {
    throw new Error(`cannot get property "${prop}" without inject`)
  }
  /**
   * Wrap one exposed surface so undeclared service reads throw.
   * @param exposed - the names this context may resolve, plus its own members.
   * @returns the context double.
   */
  const context = (exposed) =>
    new Proxy(exposed, {
      has: () => true,
      get: (target, prop) => {
        if (typeof prop === 'symbol') return target[prop]
        if (prop in target) return target[prop]
        missing(prop)
      },
    })

  const rootCtx = context({
    /** Run one effect immediately, as a real fiber does on apply. */
    effect: (factory) => factory(),
    /** Provide the injected scope when every dependency exists. */
    inject: (names, callback) => {
      const deps = Array.isArray(names) ? names : [names]
      if (!deps.every((name) => name in services)) return undefined
      const scope = {}
      for (const name of deps) scope[name] = services[name]
      scope.effect = (factory) => factory()
      scope.get = (name) => services[name]
      return callback(context(scope))
    },
  })
  services.webServer = {
    register: (route) => {
      routes.push(route)
      return () => {
        routes.splice(routes.indexOf(route), 1)
      }
    },
  }
  return { ctx: rootCtx, routes }
}

// Build a fixture root that mirrors the real layout: two project directories,
// each holding sessions, with one session carrying a sibling artifact to prove
// the delete is directory-scoped rather than file-scoped.
const fixture = await mkdtemp(join(tmpdir(), 'dsh-cleanup-'))
const sessionsRoot = join(fixture, 'sessions')
const projectA = join(sessionsRoot, host.projectKey('D:\\deepseek'))
const projectB = join(sessionsRoot, host.projectKey('C:\\Users\\Administrator\\Documents\\ponytail'))
const targetId = 'session-aaaa1111-2222-3333-4444-555566667777'
const otherId = 'session-bbbb1111-2222-3333-4444-555566667777'
const nestedId = 'session-cccc1111-2222-3333-4444-555566667777'

for (const [dir, id] of [
  [projectA, targetId],
  [projectA, otherId],
  [projectB, nestedId],
]) {
  await mkdir(join(dir, host.encodeSegment(id)), { recursive: true })
  await writeFile(join(dir, host.encodeSegment(id), 'session.v3.jsonl.zstd'), 'payload', 'utf8')
}
// A stray file beside the project directories must survive: it is not a session.
await writeFile(join(sessionsRoot, 'README.txt'), 'not a session', 'utf8')

check((await host.deleteSessionFiles(sessionsRoot, targetId)) === true, 'delete reported no directory removed')
check(
  !(await readdir(projectA)).includes(host.encodeSegment(targetId)),
  'the target session directory survived deletion',
)
check((await readdir(projectA)).includes(host.encodeSegment(otherId)), 'deletion removed an unrelated sibling session')
check(
  (await readdir(projectB)).includes(host.encodeSegment(nestedId)),
  'deletion reached into an unrelated project directory',
)
check((await readdir(sessionsRoot)).includes('README.txt'), 'deletion removed a non-session file')

// A second delete of the same id is a no-op that reports "not found" rather
// than throwing: the endpoint treats it as already-satisfied.
check((await host.deleteSessionFiles(sessionsRoot, targetId)) === false, 're-deleting a missing session did not report missing')

// A traversal-shaped id must not escape the root.
let escaped = false
try {
  await host.deleteSessionFiles(sessionsRoot, '..')
} catch {
  escaped = false
}
check(!escaped, 'a traversal-shaped id threw instead of being handled')
check((await readdir(sessionsRoot)).includes('README.txt'), 'a traversal-shaped id deleted outside the session directory')

/** The archive set the fake registry mutates, and every id it was asked to drop. */
const unarchived = []
/** Whether an id was still archived when the registry was asked to drop it. */
const archivedWhenDropped = []
const archived = new Set([nestedId, targetId, otherId])
const registry = {
  unarchiveSession: async (id) => {
    archivedWhenDropped.push({
      id,
      stillArchived: archived.has(id),
      // The safety property, observed from inside the write: by the time the id
      // leaves the archive set, its log directory must already be gone.
      logRemoved: !existsSync(join(projectA, host.encodeSegment(id))),
    })
    archived.delete(id)
    unarchived.push(id)
  },
}

/**
 * Invoke one route handler with a synthetic request and capture the response.
 * @param handler - the registered route handler.
 * @param options - request method, peer address, and raw body.
 * @returns the status and parsed JSON body.
 */
async function call(handler, options) {
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body, 'utf8')]
  const req = {
    method: options.method ?? 'POST',
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  let status = 0
  let text = ''
  const res = {
    writeHead: (code) => {
      status = code
    },
    end: (value) => {
      text = value
    },
  }
  await handler(req, res)
  return { status, body: JSON.parse(text) }
}

// Mount the plugin exactly as the loader does, through apply(). `apply()`
// resolves the session root from DSH_HOME, so the fixture must be that home
// before the route is built — otherwise this test would aim the destructive
// path at the real `~/.dsh/sessions`.
process.env['DSH_HOME'] = fixture
check(host.dshHome() === fixture, 'dshHome() ignored a configured DSH_HOME')
const app = fakeApp({ workspaceRegistry: registry })
host.apply(app.ctx)
check(app.routes.length === 1, `apply() registered ${String(app.routes.length)} routes, expected 1`)
const route = app.routes[0]
check(route?.kind === 'exact', 'the delete route is not registered as an exact path')
check(
  route?.path === '/plugins/dsh-session-cleanup/delete',
  `the delete route registered at ${String(route?.path)}`,
)
check(typeof route?.handler === 'function', 'the delete route carries no handler')

if (typeof route?.handler !== 'function') {
  console.error('host-verify FAILED: no route to exercise')
  process.exit(1)
}

check((await call(route.handler, { method: 'GET' })).status === 405, 'a non-POST request was not rejected')
check((await call(route.handler, { address: '10.0.0.5' })).status === 403, 'a non-loopback request was not rejected')
check((await call(route.handler, { body: '{}' })).status === 400, 'a body without ids was not rejected')
check((await call(route.handler, { body: '{"ids":[]}' })).status === 400, 'an empty ids array was not rejected')
check((await call(route.handler, { body: '{"ids":[""]}' })).status === 400, 'an empty id was not rejected')

// One archived session whose log exists and one whose log is already gone: the
// second is the state a half-finished deletion leaves behind, and clearing it
// is the whole reason the archive-set write must not be skippable.
const removed = await call(route.handler, { body: JSON.stringify({ ids: [nestedId, targetId] }) })
check(removed.status === 200, 'a valid delete did not return 200')
check(
  removed.body.failed.length === 0,
  `the delete reported failures: ${JSON.stringify(removed.body.failed)}`,
)
check(
  removed.body.removed.length === 1 && removed.body.removed[0] === nestedId,
  'the removed list did not name only the session that existed',
)
check(
  removed.body.missing.length === 1 && removed.body.missing[0] === targetId,
  'the missing list did not name the already-deleted session',
)
check(
  unarchived.length === 2 && unarchived.includes(nestedId) && unarchived.includes(targetId),
  'the archive set was not cleared for every id in the request',
)
check(
  archivedWhenDropped.every((entry) => entry.stillArchived && entry.logRemoved),
  'an id left the archive set before its log directory was removed',
)

// A registry failure must be reported as a failure, not swallowed.
const failingApp = fakeApp({
  workspaceRegistry: {
    unarchiveSession: async () => {
      throw new Error('registry unavailable')
    },
  },
})
host.apply(failingApp.ctx)
await mkdir(join(projectA, host.encodeSegment(otherId)), { recursive: true })
const failingCall = await call(failingApp.routes[0].handler, { body: JSON.stringify({ ids: [otherId] }) })
check(failingCall.body.failed.length === 1, 'a registry failure was not reported in the failed list')

await rm(fixture, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('host-verify FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('host-verify ok: apply() wires the registry, deletion is scoped, traversal refused, outcomes reported')
