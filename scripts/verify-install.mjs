/**
 * Verify the plugin's registration in the composed profile without spawning.
 *
 * The sandbox forbids a piped child process, so `dsh --dump-config` cannot be
 * captured from here. This re-derives the same two facts from the files the
 * loader reads: the profile manifest lists the bundle row, and the plugin's own
 * patch disables the upstream page and inserts its replacement.
 *
 * @module dsh-session-cleanup/scripts/verify-install
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', 'web')

const failures = []
/**
 * Record a failed expectation.
 * @param condition - whether the expectation held.
 * @param message - the description to report when it did not.
 */
function check(condition, message) {
  if (!condition) failures.push(message)
}

const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
const bundles = manifest.dsh?.profile?.bundles ?? []
check(bundles.includes(pkg.name), `profile bundles does not list ${pkg.name}`)
check(bundles.indexOf(pkg.name) === bundles.length - 1, `${pkg.name} is not the last bundle row`)

const dependency = manifest.dependencies?.[pkg.name]
check(typeof dependency === 'string', `${pkg.name} has no dependency entry`)
check(!dependency?.includes('.tmp'), `${pkg.name} still points at a temporary path: ${String(dependency)}`)

const linked = join(profileDir, 'node_modules', pkg.name)
check(existsSync(linked), `${pkg.name} is not linked into the profile's node_modules`)
for (const file of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'package.json']) {
  check(existsSync(join(linked, file)), `installed package is missing ${file}`)
}

// The client bundle must be reachable through the export the module system
// resolves, and its registered id must match the row name.
const installedPkg = JSON.parse(readFileSync(join(linked, 'package.json'), 'utf8'))
const clientExport = installedPkg.exports?.['./client']
check(typeof clientExport === 'string', `installed package exports no "./client"`)
const clientSource = readFileSync(join(linked, 'lib', 'client.js'), 'utf8')
check(clientSource.includes(`id: ${JSON.stringify(pkg.name)}`), 'client bundle registers a different id')
check(
  clientSource.includes("settings.section") && clientSource.includes("archived-sessions"),
  'client bundle does not register the archived-sessions settings section',
)
check(
  installedPkg.dsh?.bundle?.patch === './cordis.patch.yml',
  'installed package does not declare dsh.bundle.patch',
)

// The patch must disable the upstream page: two sections sharing one id render
// two navigation entries for the same page.
const patch = readFileSync(join(linked, 'cordis.patch.yml'), 'utf8')
check(/id:\s*ui-settings-unarchive-sessions\s*\n\s*disabled:\s*true/.test(patch), 'patch does not disable the upstream page')
check(new RegExp(`name:\\s*${pkg.name}`).test(patch), 'patch does not insert the plugin row')

if (failures.length > 0) {
  console.error('verify-install FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`verify-install ok: ${pkg.name} is bundled, linked, and replaces the upstream page`)
