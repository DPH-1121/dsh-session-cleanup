/**
 * Install the packed tarball into the web profile and register its bundle row.
 *
 * `dsh plugin add` is a thin wrapper over pnpm, which the sandbox cannot spawn
 * through a `.cmd` shim. This performs the same three effects the command has:
 * a `file:` dependency in the profile manifest, the package linked into the
 * profile's `node_modules`, and the name appended to `dsh.profile.bundles`.
 *
 * @module dsh-session-cleanup/scripts/install-profile
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tarball = process.argv[2]
if (tarball === undefined) {
  console.error('usage: node scripts/install-profile.mjs <tarball> [profile]')
  process.exit(2)
}
const profile = process.argv[3] ?? 'web'
const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', profile)

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifestPath = join(profileDir, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

manifest.dependencies = manifest.dependencies ?? {}
manifest.dependencies[pkg.name] = `file:${tarball}`
const bundles = manifest.dsh?.profile?.bundles ?? []
if (!bundles.includes(pkg.name)) bundles.push(pkg.name)
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
manifest.dsh.profile.bundles = bundles
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

// pnpm performs the actual link. `--config.auto-install-peers=false` keeps the
// install from pulling peer packages the profile deliberately does not carry.
const pnpmCli = process.env['DSH_PNPM_CLI'] ?? 'pnpm'
const install = spawnSync(pnpmCli, ['install', '--config.auto-install-peers=false'], {
  cwd: profileDir,
  encoding: 'utf8',
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

// pnpm's linking can be skipped when it is unavailable, but the package must
// still be reachable at node_modules/<name> for the loader to resolve it.
const target = join(profileDir, 'node_modules', pkg.name)
if (!existsSync(target)) {
  mkdirSync(dirname(target), { recursive: true })
  cpSync(root, target, {
    recursive: true,
    filter: (source) => !source.includes(`${join('', 'node_modules')}`) && !source.endsWith('.git'),
  })
  console.log(`linked ${pkg.name} into the profile directly (pnpm exited ${String(install.status)})`)
} else {
  console.log(`linked ${pkg.name} via pnpm`)
}

console.log(`bundles: ${bundles.join(' -> ')}`)
