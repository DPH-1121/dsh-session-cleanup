/**
 * Exercise the browser half's settings page without a browser.
 *
 * The page is reached the way the module system reaches it — through `apply()`
 * into a fake client context — so the injected face and the slot registration
 * are covered too, not just the component in isolation. Rendering runs on a
 * minimal React stand-in that keeps elements inspectable, which is enough to
 * assert the two things this page has actually got wrong or could:
 *
 *   - an archived entry whose session log is already gone still gets a row
 *     (hiding it is what made such entries unclearable: the archive set has no
 *     other surface, so the row was the only way to retire the id);
 *   - only entries that still have a log offer a delete button.
 *
 * @module dsh-session-cleanup/scripts/client-verify
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
/**
 * Record a failed expectation.
 * @param condition - whether the expectation held.
 * @param message - the description to report when it did not.
 */
function check(condition, message) {
  if (!condition) failures.push(message)
}

/** Minimal React stand-in: constructs inspectable elements and inert hooks. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useMemo: (factory) => factory(),
  useState: (initial) => [initial, () => {}],
}

const registrations = []
const windowStub = {
  __ModuleLoader__: {
    load: (registration) => {
      registrations.push(registration)
    },
  },
}
const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
const run = new Function('window', 'require', 'module', 'exports', source)
const moduleStub = { exports: {} }
/** Resolve the only specifiers this bundle may require. */
const requireStub = (specifier) => {
  if (specifier === 'react' || specifier === 'react/jsx-runtime') return reactStub
  throw new Error(`client bundle required unknown specifier "${specifier}"`)
}
run(windowStub, requireStub, moduleStub, moduleStub.exports)

check(registrations.length === 1, `expected one module registration, saw ${String(registrations.length)}`)
const client = registrations.length === 1 ? registrations[0].factory(requireStub) : {}

// ---- a client context, with the same strictness the host half's test uses ----
const unarchived = []
let refreshed = 0
const dictionaries = new Map()
const sections = []
/** Substitute `{name}` placeholders the way the platform translator does. */
function translate(namespace, key, params = {}) {
  const dict = dictionaries.get(namespace) ?? {}
  const template = dict[key]
  if (template === undefined) throw new Error(`missing ${namespace}.${key}`)
  return template.replace(/\{(\w+)\}/g, (_whole, name) => String(params[name] ?? `{${name}}`))
}
const clientCtx = {
  effect: (factory) => factory(),
  locale: {
    register: (namespace, dicts) => {
      dictionaries.set(namespace, dicts.zh)
    },
    bind: (namespace) => (key, params) => translate(namespace, key, params),
  },
  slots: {
    inject: (_name, callback) => callback(),
    register: (options, component) => {
      sections.push({ options, component })
    },
  },
  uiWorkspace: {
    unarchiveSession: async (id) => {
      unarchived.push(id)
    },
  },
  sessions: {
    refresh: () => {
      refreshed += 1
      return Promise.resolve()
    },
  },
}
check(Array.isArray(client.inject), 'client half exports no inject array')
check(client.inject?.includes('sessions'), 'client inject omits "sessions"')
client.apply?.(clientCtx)

check(sections.length === 1, `apply() registered ${String(sections.length)} sections, expected 1`)
const section = sections[0]
check(section?.options?.id === 'archived-sessions', 'the section registered under an unexpected id')
check(typeof section?.component === 'function', 'the section registration carries no component')

// ---- render with one live archived session and one whose log is gone ----
const liveId = 'session-11111111-1111-4111-8111-111111111111'
const staleId = 'session-22222222-2222-4222-8222-222222222222'
const injected = section.options.inject?.() ?? {}
check(typeof injected.unarchive === 'function', 'the injected face exposes no unarchive()')
check(typeof injected.refresh === 'function', 'the injected face exposes no refresh()')
const t = clientCtx.locale.bind(section.options.locale ?? 'settings.archivedSessions')
const sessionsState = {
  phase: 'ready',
  ids: [liveId],
  byId: { [liveId]: { id: liveId, displayTitle: 'live session', updatedAt: Date.now() - 60_000 } },
}
const workspacesState = {
  items: [{ id: 'w1', title: 'deepseek', sessionIds: [liveId, staleId] }],
  archivedSessionIds: [liveId, staleId],
}
const tree = section.component({
  ...injected,
  t,
  useSessions: (selector) => selector(sessionsState),
  useWorkspaces: (selector) => selector(workspacesState),
})

/** Flatten one element tree into a list of elements and text, dropping nulls. */
function flatten(node) {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(flatten)
  if (typeof node === 'object' && 'type' in node) return [node, ...flatten(node.children)]
  return []
}
const nodes = flatten(tree)
const texts = nodes.filter((node) => typeof node === 'string')
const buttons = nodes.filter((node) => node.type === 'button')

check(texts.includes('live session'), 'the archived session with a log did not render a row')
check(
  texts.includes('会话记录已不在磁盘上'),
  'an archived entry whose log is gone did not render a row',
)
check(
  texts.some((text) => text === '共 2 个已归档会话'),
  `the count did not include the entry with no log: ${JSON.stringify(texts.filter((text) => text.includes('已归档会话')))}`,
)
check(
  texts.some((text) => text.includes('记录已删除')),
  `the row for an entry with no log did not say the log is gone: ${JSON.stringify(texts)}`,
)
const deleteButtons = buttons.filter((node) => String(node.props['aria-label'] ?? '').startsWith('删除 '))
const unarchiveButtons = buttons.filter((node) => String(node.props['aria-label'] ?? '').startsWith('取消归档 '))
check(unarchiveButtons.length === 2, `expected an unarchive button per row, saw ${String(unarchiveButtons.length)}`)
check(
  deleteButtons.length === 1,
  `expected a delete button only for the row with a log, saw ${String(deleteButtons.length)}`,
)

if (failures.length > 0) {
  console.error('client-verify FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('client-verify ok: section wiring holds, stale archive entries stay visible and clearable')
