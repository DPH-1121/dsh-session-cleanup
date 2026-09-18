/**
 * Archived-session cleanup — host half.
 *
 * DSH has no session-deletion capability: the Workspace controller exposes only
 * archive/unarchive, the Session controller has no delete command, and the
 * persistence layer is append-only. This host half therefore owns the whole
 * destructive path, and it is deliberately the only writer in this plugin.
 *
 * Deleting one archived session is two ordered steps:
 *
 *   1. remove the session's durable log directory from disk;
 *   2. drop its id from the Workspace archive set.
 *
 * The order is the safety property, not an implementation detail. The archive
 * set holds an id until step 2, so a crash between the steps leaves an archived
 * row whose log is gone — which the settings page already renders as
 * "unrestorable" and which unarchive still clears. The reverse order would
 * leave a live session whose log was deleted, i.e. a session the sidebar shows
 * and cannot open.
 *
 * Both steps must therefore be able to run. Step 2 writes through a Cordis
 * service, and a service is only reachable from a context that declares it:
 * reading `ctx.workspaceRegistry` from a context that did not inject it throws
 * `cannot get property "workspaceRegistry" without inject`. The route is
 * mounted from an injected scope for exactly that reason — see {@link apply}.
 *
 * @module dsh-session-cleanup
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Plugin name, as the loader row declares it. */
export const name = 'dsh-session-cleanup'

/**
 * Nothing is required at apply time: the route registers lazily once both
 * services it writes through exist, and a profile that mounts neither (a
 * headless one) simply never mounts it.
 */
export const inject = []

/**
 * Resolve the harness home directory the same way the rest of DSH does.
 * @returns the absolute `DSH_HOME` path (`~/.dsh` by default).
 */
export function dshHome() {
  const configured = process.env['DSH_HOME']
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

/**
 * Escape one path segment exactly as the JSONL persistence backend does, so a
 * deletion addresses the same directory the writer created. Kept byte-for-byte
 * in step with `encodeSegment` in `@deepseek-ai/dsh-session-persistence-jsonl`;
 * a `.` or `..` segment is escaped because neither is a legal session id.
 * @param raw - the session id to encode.
 * @returns one filesystem-safe path segment.
 */
export function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Build the readable project directory key for a session's working directory.
 * Mirrors `projectKey` in the JSONL backend: separators collapse to a single
 * `-`, unsafe code units use `~XXXX`, and the result is bounded and wrapped in
 * `--`. The mapping is intentionally lossy in the same places, because a
 * deletion must land on the directory the backend actually wrote.
 * @param cwd - the session's absolute working directory.
 * @returns the project directory name beneath the session root.
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Locate a session's directory on disk without trusting a stored `cwd`.
 *
 * A session directory is `<root>/<project-key>/<encoded-id>/`. The project key
 * is derived from the session's working directory, which the archive set does
 * not carry, so the directory is found by scanning the (small, one-per-project)
 * set of project directories for one containing the encoded id. This is what
 * makes deletion work for compressed logs, where the header cannot be read
 * cheaply.
 * @param root - the session root (`<DSH_HOME>/sessions`).
 * @param sessionId - the session to locate.
 * @returns the absolute session directory, or `undefined` when absent.
 */
async function locateSessionDir(root, sessionId) {
  const segment = encodeSegment(sessionId)
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, segment)
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    } catch {
      // Absent in this project: the normal case for every other project.
    }
  }
  return undefined
}

/**
 * Delete one session's durable log directory.
 *
 * Refuses any target outside the session root, so a malformed id can never turn
 * into a filesystem-wide delete.
 * @param root - the session root (`<DSH_HOME>/sessions`).
 * @param sessionId - the session whose log directory is removed.
 * @returns whether a directory was found and removed.
 */
export async function deleteSessionFiles(root, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('session-cleanup: a session id is required')
  }
  const dir = await locateSessionDir(root, sessionId)
  if (dir === undefined) return false
  const fence = resolve(root) + (process.platform === 'win32' ? '\\' : '/')
  if (!resolve(dir).startsWith(fence)) {
    // Unreachable today (the id is escaped and joined under the root), but a
    // recursive delete is exactly the operation that must not rely on that.
    throw new Error('session-cleanup: refusing to delete outside the session root')
  }
  await rm(dir, { recursive: true, force: true })
  return true
}

/**
 * Whether a mutation request is well formed.
 * @param body - the decoded request body.
 * @returns the session ids to act on.
 */
function requestedIds(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('a JSON object body is required')
  }
  const raw = body['ids']
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('"ids" must be a non-empty array of session ids')
  }
  const ids = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry === '') {
      throw new Error('every entry of "ids" must be a non-empty string')
    }
    ids.push(entry)
  }
  return ids
}

/** Write one JSON response with an explicit length and no caching. */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

/**
 * Whether a request arrived over the loopback interface.
 *
 * Deletion is destructive and unauthenticated beyond this fence, so it stays
 * reachable only from the machine running the harness — the same fence the
 * WorkBuddy quota plugin's usage route uses.
 * @param req - the incoming request.
 * @returns true for a loopback peer.
 */
function loopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Read a bounded JSON request body. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Build the delete handler over the Workspace registry.
 *
 * `ctx` must be a context that has `workspaceRegistry` injected — the scope
 * {@link apply} mounts the route from. Handing this handler a context that
 * merely *has* the service somewhere up the tree is not enough: Cordis resolves
 * a service property only through the caller's own inject declaration, so an
 * undeclared read throws and every id would land in `failed` after its log was
 * already gone. That is the failure this scope closes.
 *
 * The registry write goes through `ctx.workspaceRegistry.unarchiveSession`,
 * which rewrites only the global archive set and therefore broadcasts to every
 * surface the page's own state came from. Removing ids one at a time is
 * deliberate: the registry serializes its mutations, and a single-id call is
 * the only shape its API offers.
 * @param ctx - a context with the Workspace registry injected.
 * @param home - the harness home directory.
 * @returns an HTTP handler.
 */
export function cleanupHandler(ctx, home) {
  const root = join(home, 'sessions')
  return async (req, res) => {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      writeJson(res, 403, { error: 'request-not-trusted' })
      return
    }
    let ids
    try {
      ids = requestedIds(await readBody(req))
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    const removed = []
    const missing = []
    const failed = []
    for (const id of ids) {
      try {
        const existed = await deleteSessionFiles(root, id)
        if (existed) removed.push(id)
        else missing.push(id)
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : String(error) })
        // A failed unlink leaves the id archived on purpose: the row stays
        // visible so the operator can retry instead of silently losing a
        // session the harness still accounts for.
        continue
      }
      try {
        await ctx.workspaceRegistry.unarchiveSession(id)
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    writeJson(res, 200, { removed, missing, failed })
  }
}

/**
 * Mount the delete route beside the web server.
 *
 * The route needs two services, so it is mounted from a scope that injects
 * both: `webServer` answers the request, and `workspaceRegistry` performs step
 * 2 of a deletion. Injecting the registry here — rather than reading it off the
 * plugin's own context inside the handler — is what makes the archive-set write
 * reachable at all; a context that did not declare it throws on the property
 * read, which would leave every deleted session's id archived forever.
 *
 * Injection also makes the mount conditional on both services being available:
 * a profile with no Workspace registry gets no delete route, instead of one
 * that deletes logs and then fails to unarchive them.
 * @param ctx - the host context.
 */
export function apply(ctx) {
  const home = dshHome()
  ctx.inject(['webServer', 'workspaceRegistry'], (routeCtx) => {
    routeCtx.effect(() => {
      const disposeCleanup = routeCtx.webServer.register({
        // Exact, not prefix: this plugin owns exactly one pathname and must not
        // shadow anything beneath it.
        kind: 'exact',
        path: '/plugins/dsh-session-cleanup/delete',
        handler: cleanupHandler(routeCtx, home),
      })
      return () => {
        disposeCleanup()
      }
    }, 'dsh-session-cleanup: delete route')
  })
}
