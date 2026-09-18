/**
 * Inspect what the running harness actually exposes for this plugin.
 *
 * The bundle route 404'd while the plugin itself loaded, which means the module
 * system did not adopt the package. This prints the boot roster and every
 * `/plugins/...` URL the served shell references, so the reason is visible
 * rather than guessed.
 *
 * @module dsh-session-cleanup/scripts/inspect-boot
 */

const port = Number(process.env['DSH_E2E_PORT'] ?? '3099')
const base = `http://127.0.0.1:${String(port)}`

const response = await fetch(`${base}/`)
console.log(`GET / -> ${String(response.status)}`)
const html = await response.text()

for (const match of html.matchAll(/\/plugins\/[^"'\s)<>]+/g)) {
  console.log(`plugin url: ${match[0]}`)
}
const boot = /__DSH_BOOT__\s*=\s*(\{[\s\S]*?\});/.exec(html)
if (boot !== null) {
  console.log('--- boot payload (truncated) ---')
  console.log(boot[1].slice(0, 2000))
} else {
  console.log('no __DSH_BOOT__ payload found in the shell')
}

for (const path of [
  '/plugins/dsh-session-cleanup/client.js',
  '/plugins/dsh-workbuddy-quota/client.js',
  '/plugins/??dsh-session-cleanup/client.js',
]) {
  const probe = await fetch(`${base}${path}`)
  console.log(`GET ${path} -> ${String(probe.status)}`)
}
