/**
 * Pack the plugin into a tarball using npm's programmatic API.
 *
 * The sandbox refuses `.cmd` shims and multi-argument program invocations, so
 * this drives `npm pack` from inside Node instead of shelling out.
 *
 * @module dsh-session-cleanup/scripts/pack
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const destination = process.argv[2]
if (destination === undefined) {
  console.error('usage: node scripts/pack.mjs <output-directory>')
  process.exit(2)
}
mkdirSync(destination, { recursive: true })

const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const result = spawnSync(
  process.execPath,
  [npmCli, 'pack', '--ignore-scripts', '--pack-destination', destination, '--cache', join(destination, '.npm-cache')],
  { cwd: root, encoding: 'utf8', stdio: 'inherit' },
)
process.exit(result.status ?? 1)
