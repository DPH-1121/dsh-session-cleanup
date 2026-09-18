/**
 * Run the dsh CLI's `--dump-config` for a profile and report the assembly tree.
 *
 * `--dump-config` prints the composed loader tree per bundle without importing
 * anything. It proves the plugin row is present and that the upstream page was
 * disabled, but it cannot prove the modules import — `verify-start.mjs` does
 * that by actually booting.
 *
 * @module dsh-session-cleanup/scripts/dump-config
 */

import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const profile = 'web'
const cli = join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const result = spawnSync(process.execPath, [cli, '--profile', profile, '--dump-config'], {
  encoding: 'utf8',
  // Piped, because the sandbox's restriction applies to PowerShell's own
  // redirection of this process rather than to this child: Node captures the
  // CLI's output here and writes the filtered result itself.
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PATH: `${join(process.env['APPDATA'] ?? '', 'npm')};${process.env['PATH'] ?? ''}` },
})

if (result.error !== undefined) {
  console.error(String(result.error))
  process.exit(1)
}

const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
const wanted = text
  .split('\n')
  .filter((line) => /^# == /.test(line) || /session-cleanup/.test(line) || /unarchive-sessions/.test(line))
  .join('\n')

const outFile = process.env['DSH_DUMP_OUT']
if (outFile !== undefined) {
  await writeFile(outFile, text, 'utf8')
  console.log(`wrote ${outFile} (${String(result.status ?? -1)})`)
  console.log(wanted)
} else {
  console.log(wanted)
}
process.exit(result.status ?? 0)
