// Runs the privacy denylist over every committable file and over commit metadata, and looks for home paths and emails.
// The denylist is read by grep only and is never printed. Path: PRIVACY_DENYLIST, else ../../tools/privacy-denylist.txt.
// Every count must be 0. --strict fails when the denylist is missing instead of skipping that part.
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const strict = process.argv.includes('--strict')
const root = fileURLToPath(new URL('../', import.meta.url))
const denylist = process.env.PRIVACY_DENYLIST ?? fileURLToPath(new URL('../../tools/privacy-denylist.txt', import.meta.url))
const git = (args) => execFileSync('git', args, { cwd: root, maxBuffer: 1 << 28 })
const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter((f) => f && existsSync(root + f))
const grepCount = (args, input) => {
  const r = spawnSync('grep', ['-c', '-i', '-F', '-f', denylist, ...args], { cwd: root, input, encoding: 'utf8' })
  return r.status === 2 ? NaN : Number((r.stdout || '0').trim())
}
let bad = 0
const hasList = existsSync(denylist)
if (hasList) {
  for (const f of files) { const n = grepCount([f]); if (n !== 0) { bad++; console.log(`DENYLIST ${Number.isNaN(n) ? 'unreadable' : n + ' line(s)'} in ${f}`) } }
  const log = spawnSync('git', ['log', '--all', '--format=%an%n%ae%n%cn%n%ce%n%B'], { cwd: root, encoding: 'utf8' }).stdout ?? ''
  const n = grepCount(['-'], log)
  if (n !== 0) { bad++; console.log(`DENYLIST ${n} line(s) in commit metadata`) }
}
const home = /(\/home\/[a-z]|\/Users\/[A-Za-z]|[A-Z]:\\Users\\)/
const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/g
const okEmail = (e) => e.endsWith('@users.noreply.github.com') || e === 'noreply@anthropic.com'
for (const f of files) {
  const text = readFileSync(root + f, 'latin1')
  if (home.test(text)) { bad++; console.log(`HOME PATH in ${f}`) }
  const emails = (text.match(email) ?? []).filter((e) => !okEmail(e))
  if (emails.length) { bad++; console.log(`EMAIL (${emails.length}) in ${f}`) }
}
const list = hasList ? 'denylist checked' : 'denylist NOT RUN (file not found; set PRIVACY_DENYLIST)'
console.log(`privacy check: ${bad ? bad + ' problem(s)' : 'clean'}; ${files.length} files + commit metadata; ${list}; home paths and emails checked`)
process.exit(bad || (strict && !hasList) ? 1 : 0)
