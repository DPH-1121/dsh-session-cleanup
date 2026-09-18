/**
 * Smoke-check the built bundles without a browser.
 *
 * Catches the two failures that a passing build does not: the client bundle
 * failing to parse, and the factory failing to expose `apply` / `inject` /
 * `name`. A plugin whose factory registers but exports nothing loads cleanly
 * and then simply never renders, which is the expensive version of this bug.
 *
 * @module dsh-session-cleanup/scripts/smoke
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

/** Minimal React stand-in: enough to construct elements, nothing more. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
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
run(windowStub, (specifier) => {
  if (specifier === 'react' || specifier === 'react/jsx-runtime') return reactStub
  throw new Error(`client bundle required unknown specifier "${specifier}"`)
}, moduleStub, moduleStub.exports)

if (registrations.length !== 1) {
  failures.push(`expected exactly one __ModuleLoader__.load call, saw ${String(registrations.length)}`)
} else {
  const registration = registrations[0]
  if (registration.id !== 'dsh-session-cleanup') {
    failures.push(`client bundle registered id "${String(registration.id)}"`)
  }
  const exported = registration.factory((specifier) => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') return reactStub
    throw new Error(`factory required unknown specifier "${specifier}"`)
  })
  if (typeof exported.apply !== 'function') failures.push('client bundle exports no apply()')
  if (!Array.isArray(exported.inject)) failures.push('client bundle exports no inject array')
  if (exported.name !== 'dsh-session-cleanup') failures.push('client bundle exports the wrong name')
  for (const service of ['slots', 'locale', 'uiWorkspace', 'sessions']) {
    if (!exported.inject?.includes(service)) failures.push(`client inject omits "${service}"`)
  }
}

// The host half must import cleanly and expose the same identity plus apply().
const host = await import(new URL('../lib/index.js', import.meta.url).href)
if (typeof host.apply !== 'function') failures.push('host half exports no apply()')
if (host.name !== 'dsh-session-cleanup') failures.push('host half exports the wrong name')

// Encoding parity with the persistence backend: a mismatch here would make
// deletion address a directory that never exists, which looks like "not found"
// rather than a bug.
const cases = [
  ['D:\\deepseek', '--D-deepseek--'],
  ['C:\\Users\\Administrator\\Documents\\ponytail', '--C-Users-Administrator-Documents-ponytail--'],
  ['/home/runner/work/deepseek-harness', '--home-runner-work-deepseek-harness--'],
]
for (const [input, expected] of cases) {
  const actual = host.projectKey(input)
  if (actual !== expected) failures.push(`projectKey(${input}) = ${actual}, expected ${expected}`)
}

if (host.encodeSegment('session-fdd2cee6-5a42-4171-ad7b-fb8df6d14e24') !== 'session-fdd2cee6-5a42-4171-ad7b-fb8df6d14e24') {
  failures.push('encodeSegment altered a plain session id')
}
if (host.encodeSegment('..') !== '~002E~002E') failures.push('encodeSegment did not escape ".."')

if (failures.length > 0) {
  console.error('smoke FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('smoke ok: bundles parse, exports are complete, path encoding matches the backend')
