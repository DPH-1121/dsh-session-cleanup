/**
 * Identify the harness processes still running, without killing anything.
 *
 * Repeated `D:\tools` node processes keep appearing and one of them holds the
 * atomic-write lock, so this reports what each one actually is — its command
 * line and parent — before anything is stopped.
 *
 * @module dsh-session-cleanup/scripts/ps-report
 */

import { execFileSync } from 'node:child_process'

/**
 * Query process metadata through CIM, which is available without a pipe.
 * @returns the parsed process rows.
 */
function rows() {
  try {
    const json = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: 'utf8', windowsHide: true },
    )
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch (error) {
    console.error(`query failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

for (const row of rows()) {
  const cmd = typeof row.CommandLine === 'string' ? row.CommandLine : ''
  const short = cmd.replace(/^.*node\.exe"?\s*/i, '').slice(0, 160)
  console.log(`pid ${String(row.ProcessId)} parent ${String(row.ParentProcessId)} :: ${short}`)
}
