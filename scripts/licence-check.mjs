// Reads package-lock.json (and node_modules for entries without a licence field) and fails on any GPL/LGPL/AGPL package,
// on an unknown licence, or on weak copyleft (MPL-2.0) in a production dependency. An "A OR B" expression passes if any option passes.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const lock = JSON.parse(readFileSync(root + 'package-lock.json', 'utf8'))
const OK = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0', 'Unlicense', 'CC0-1.0', 'Python-2.0'])
const DEV_ONLY = new Set(['MPL-2.0']) // file-level copyleft: fine in a test tool, not shipped
const licenceOf = (path, v) => {
  if (v.license) return typeof v.license === 'string' ? v.license : v.license.type
  const p = root + path + '/package.json'
  if (!existsSync(p)) return null
  const j = JSON.parse(readFileSync(p, 'utf8'))
  return typeof j.license === 'string' ? j.license : j.license?.type ?? j.licenses?.map((l) => l.type).join(' OR ') ?? null
}
const allowed = (expr, dev) => expr.split(/\s+OR\s+/).some((alt) => alt.replace(/[()]/g, '').split(/\s+AND\s+/).every((id) => OK.has(id.trim()) || (dev && DEV_ONLY.has(id.trim()))))
const seen = {}; const problems = []
for (const [path, v] of Object.entries(lock.packages)) {
  if (!path) continue
  const expr = licenceOf(path, v)
  const key = (expr ?? 'UNKNOWN') + (v.dev ? ' (dev)' : '')
  seen[key] = (seen[key] ?? 0) + 1
  if (!expr) problems.push(`${path}: no licence found`)
  else if (/(^|[^L])GPL|LGPL|AGPL/.test(expr) && !allowed(expr, v.dev)) problems.push(`${path}: ${expr}`)
  else if (!allowed(expr, !!v.dev)) problems.push(`${path}: ${expr}${v.dev ? '' : ' (not allowed in production)'}`)
}
console.log('licences found:', JSON.stringify(seen))
if (problems.length) { console.log(`licence check: ${problems.length} problem(s)`); problems.forEach((p) => console.log('  ' + p)); process.exit(1) }
console.log(`licence check: clean (${Object.values(seen).reduce((a, b) => a + b, 0)} packages, no GPL/LGPL/AGPL)`)
