/**
 * Compare how two harness instances serve the SPA shell and plugin bundles.
 *
 * The throwaway instance on 3099 answers `/` with 404 while the live GUI on
 * 3080 serves it, so the difference is in how each was launched rather than in
 * the plugin. This prints both sides' status codes and headers side by side.
 *
 * @module dsh-session-cleanup/scripts/compare-servers
 */

/**
 * Probe one instance's routes and report status codes.
 * @param label - the instance label to print.
 * @param base - the origin to probe.
 */
async function probe(label, base) {
  console.log(`--- ${label} (${base}) ---`)
  for (const path of ['/', '/index.html', '/plugins/dsh-workbuddy-quota/client.js', '/api']) {
    try {
      const response = await fetch(`${base}${path}`, { redirect: 'manual' })
      const type = response.headers.get('content-type') ?? ''
      console.log(`  ${path} -> ${String(response.status)} ${type}`)
    } catch (error) {
      console.log(`  ${path} -> ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

await probe('live GUI', 'http://127.0.0.1:3080')
await probe('throwaway', `http://127.0.0.1:${process.env['DSH_E2E_PORT'] ?? '3099'}`)
