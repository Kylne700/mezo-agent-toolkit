// Bundles the stdio MCP server and every library it uses into one file, dist/mcp.js, so `npx -y <release tarball URL>` has nothing else to install.
// esbuild is already in node_modules as a dependency of tsx. Usage: npm run build:mcp
// It also writes THIRD_PARTY_NOTICES: the licence text of every package that puts code into the bundle, taken from the esbuild metafile and node_modules.
import { build } from 'esbuild'
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const outfile = root + 'dist/mcp.js'

const { metafile } = await build({
  absWorkingDir: root, // the module comments in the bundle then read src/..., not a path from wherever the build was started
  entryPoints: [root + 'src/cli.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'eof', // keeps the licence notices of the bundled libraries at the end of the file
  banner: { js: '#!/usr/bin/env node' },
  metafile: true,
  logLevel: 'warning',
})
chmodSync(outfile, 0o755)
console.log(`built dist/mcp.js (${Math.round(statSync(outfile).size / 1024)} kB)`)

// ---- THIRD_PARTY_NOTICES ----------------------------------------------------------------------------------------------------------------------
// Only files that put bytes into the output count: esbuild also reads packages whose code is dropped again (ws, @scure/*), and those are not in dist/mcp.js.
const lf = (s) => s.replaceAll('\r\n', '\n').trimEnd() + '\n'
const dirs = [...new Set(Object.values(metafile.outputs).flatMap((o) => Object.entries(o.inputs).filter(([, v]) => v.bytesInOutput > 0).map(([f]) => f)).flatMap((f) => {
  const i = f.lastIndexOf('node_modules/')
  if (i < 0) return []
  const [a, b] = f.slice(i + 13).split('/')
  return [f.slice(0, i + 13) + (a.startsWith('@') ? `${a}/${b}` : a)]
}))].sort()

const APACHE = 'node_modules/detect-libc/LICENSE' // the stock Apache-2.0 text, for packages that name the licence but ship no file
const apache = lf(readFileSync(root + APACHE, 'utf8'))
if (!apache.includes('Apache License') || !apache.includes('Version 2.0, January 2004')) throw new Error(`${APACHE} is not the Apache-2.0 text`)

const entries = dirs.map((dir) => {
  const p = JSON.parse(readFileSync(root + dir + '/package.json', 'utf8'))
  const license = typeof p.license === 'string' ? p.license : (p.license?.type ?? 'see the text below')
  const source = (typeof p.repository === 'string' ? p.repository : (p.repository?.url ?? p.homepage ?? '')).replace(/^git\+/, '').replace(/\.git$/, '')
  const files = readdirSync(root + dir).filter((n) => /^(licen[cs]e|copying|notice)/i.test(n) && statSync(`${root}${dir}/${n}`).isFile()).sort()
  const texts = files.map((n) => [n, lf(readFileSync(`${root}${dir}/${n}`, 'utf8'))])
  if (!texts.length && license === 'Apache-2.0') texts.push([`the standard Apache-2.0 text (this package ships no licence file; copied from ${APACHE})`, apache])
  if (!texts.length) throw new Error(`${p.name}@${p.version} (${license}) ships no licence file, so THIRD_PARTY_NOTICES cannot hold its text`)
  return { id: `${p.name}@${p.version}`, license, source, texts }
})
// Packages with the same licence text share one section (the three x402 packages, a package that sits in two folders at one version).
const groups = new Map()
for (const e of entries) {
  const g = groups.get(JSON.stringify(e.texts)) ?? { texts: e.texts, packages: new Map() }
  groups.set(JSON.stringify(e.texts), g)
  g.packages.set(e.id, e)
}
const byId = (a, b) => (a < b ? -1 : 1)
const sections = [...groups.values()].map((g) => ({ ...g, ids: [...g.packages.keys()].sort(byId) })).sort((a, b) => byId(a.ids[0], b.ids[0]))
const ids = [...new Set(entries.map((e) => e.id))].sort(byId)

const rule = '-'.repeat(80)
const notices =
  `THIRD-PARTY NOTICES for mezo-agent-toolkit\n\n` +
  `dist/mcp.js is one file that holds code from the ${ids.length} third-party packages listed here (found in ${dirs.length} folders of node_modules). Each is used under its own\n` +
  `licence; the licence files of each are copied below, unchanged. scripts/build-mcp.mjs writes this file from the esbuild metafile of the build: do not edit it by hand.\n\n` +
  ids.map((id) => `  ${id}  ${entries.find((e) => e.id === id).license}\n`).join('') +
  sections.map((g) => `\n${rule}\n${g.ids.map((id) => { const e = g.packages.get(id); return `${id}\nLicense: ${e.license}\n${e.source ? `Source: ${e.source}\n` : ''}` }).join('')}${g.texts.map(([n, t]) => `\n[${n}]\n\n${t}`).join('')}`).join('')
writeFileSync(root + 'THIRD_PARTY_NOTICES', notices)
console.log(`wrote THIRD_PARTY_NOTICES (${ids.length} packages, ${dirs.length} folders)`)
