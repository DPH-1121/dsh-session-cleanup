/**
 * Build the plugin's two runtime halves into `lib/`.
 *
 * The host half is a plain ESM file and is copied verbatim: Node loads it
 * directly, so there is nothing to bundle.
 *
 * The client half must match the shape the harness's module system expects —
 * `window.__ModuleLoader__.load({ id, factory })` with every dependency pulled
 * through the factory's `require`, because the browser has no import map and
 * the platform supplies React and its own packages by name. The source file is
 * written as ordinary ESM, so it is transformed here rather than hand-written
 * in loader form: a hand-written wrapper is one rename away from a bundle that
 * silently registers the wrong id.
 *
 * @module dsh-session-cleanup/build
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = join(root, 'lib')

/** Read the plugin manifest for the id and declared client injections. */
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

/**
 * Turn the client source's ESM into a loader-registered factory body.
 *
 * Only the import/export forms this plugin actually uses are rewritten, and an
 * unrecognized form throws rather than passing through — a silently dropped
 * export would surface as "the plugin loaded but nothing renders".
 * @param source - the client source file contents.
 * @returns the factory body.
 */
function toFactoryBody(source) {
  const body = source.replace(/\bexport\s+async\s+function\s+/g, 'async function ')
  const withoutExports = body.replace(/\bexport\s+function\s+/g, 'function ')
  const withoutConsts = withoutExports.replace(/\bexport\s+const\s+/g, 'const ')
  if (/\bexport\b/.test(withoutConsts)) {
    throw new Error('client source uses an export form the builder does not rewrite')
  }
  return withoutConsts
}

/** Collect the module specifiers the client source imports. */
function importedSpecifiers(source) {
  const specs = []
  const pattern = /import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    const names = match[1]
      .split(',')
      .map((entry) => entry.trim().split(/\s+as\s+/))
      .map(([imported, local]) => [imported, local ?? imported])
    specs.push({ specifier: match[2], names })
  }
  return specs
}

/**
 * Rewrite one import statement into a `require` destructure.
 * @param source - the client source file contents.
 * @returns the source with imports replaced and the specifiers found.
 */
function rewriteImports(source) {
  const found = importedSpecifiers(source)
  const rewritten = source.replace(
    /import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"];?/g,
    (_whole, names, specifier) => {
      const parts = names
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        .map((entry) => {
          const [imported, local] = entry.split(/\s+as\s+/)
          return local === undefined || local === imported ? imported : `${imported}: ${local}`
        })
      return `const { ${parts.join(', ')} } = require(${JSON.stringify(specifier)});`
    },
  )
  return { source: rewritten, specifiers: found.map((entry) => entry.specifier) }
}

await mkdir(out, { recursive: true })

// Host half: copied as-is, with a header the loader does not need but a reader does.
const hostSource = await readFile(join(root, 'src', 'index.js'), 'utf8')
await writeFile(join(out, 'index.js'), hostSource, 'utf8')

// Client half: wrapped into the module-loader registration.
const clientSource = await readFile(join(root, 'src', 'client.js'), 'utf8')
const { source: rewritten, specifiers } = rewriteImports(clientSource)
const body = toFactoryBody(rewritten)

const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body
  .split('\n')
  .map((line) => (line === '' ? '' : `\t\t${line}`))
  .join('\n')}
\t\texports.apply = apply;
\t\texports.inject = inject;
\t\texports.name = name;
\t\treturn module.exports;
\t}
});
`

// The loader resolves packages by name through the factory's `require`, so an
// import the platform cannot answer would fail at runtime with a much less
// useful message than this one.
const known = new Set(['react', 'react/jsx-runtime'])
for (const specifier of specifiers) {
  if (!known.has(specifier) && !specifier.startsWith('@deepseek-ai/')) {
    throw new Error(`client source imports "${specifier}", which the browser module table does not provide`)
  }
}

await writeFile(join(out, 'client.js'), bundle, 'utf8')
console.log(`built ${pkg.name}: lib/index.js, lib/client.js`)
