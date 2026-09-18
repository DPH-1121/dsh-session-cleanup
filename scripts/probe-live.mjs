/**
 * Determine what the live GUI on 3080 actually serves and why it answers 401.
 *
 * The live instance is the one the user sees, so its behaviour is the ground
 * truth for "does the page exist". This prints status codes and the response
 * body for the shell, a plugin bundle, and the API, plus the trust headers the
 * server reports.
 *
 * @module dsh-session-cleanup/scripts/probe-live
 */

const base = process.env['DSH_LIVE_URL'] ?? 'http://127.0.0.1:3080'

for (const path of ['/', '/index.html', '/plugins/dsh-workbuddy-quota/client.js', '/api']) {
  const response = await fetch(`${base}${path}`)
  const text = await response.text()
  console.log(`${path} -> ${String(response.status)} ${response.headers.get('content-type') ?? ''}`)
  console.log(`   body: ${text.slice(0, 300).replace(/\s+/g, ' ')}`)
}

// Retry the shell as a browser would, with the conventional trust headers.
for (const [label, headers] of [
  ['referer', { referer: `${base}/`, origin: base }],
  ['host-only', { host: '127.0.0.1:3080' }],
]) {
  const response = await fetch(`${base}/`, { headers })
  const text = await response.text()
  console.log(`/ with ${label} -> ${String(response.status)} :: ${text.slice(0, 200).replace(/\s+/g, ' ')}`)
}
