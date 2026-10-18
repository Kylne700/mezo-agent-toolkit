// Fails if the value of either throwaway key appears anywhere git could publish it: tracked files, untracked files that
// are not ignored, the index, and every object in history. Prints file names and counts only, never a value.
// Pattern fallback (no key files, e.g. a fresh clone): looks for private-key blocks and "private key = <64 hex>" assignments.
// Pass --strict to make a skipped exact-value check a failure. Key files: MEZO_KEY_FILE, MEZO_PAYEE_KEY_FILE.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const strict = process.argv.includes('--strict')
const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const keyFiles = [process.env.MEZO_KEY_FILE ?? here('../../keys/mezo-testnet-ops.key'), process.env.MEZO_PAYEE_KEY_FILE ?? here('../.secrets/payee.key')]
const git = (args, opts = {}) => execFileSync('git', args, { cwd: here('../'), maxBuffer: 1 << 30, ...opts })

const needles = []
for (const f of keyFiles) {
  if (!existsSync(f)) continue
  const raw = readFileSync(f, 'utf8').trim().toLowerCase()
  if (raw.length >= 32) needles.push(raw, raw.replace(/^0x/, '')) // with and without the 0x prefix
}
const patterns = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /(private[_ -]?key|secret[_ -]?key|mnemonic|seed[_ -]?phrase)["']?\s*[:=]\s*["']?(0x)?[0-9a-f]{64}\b/i]

const corpus = [] // [label, lower-cased text]
const add = (label, buf) => { if (buf.length && buf.length < 20_000_000) corpus.push([label, buf.toString('latin1')]) }
const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean)
for (const f of files) { const p = here('../' + f); if (existsSync(p) && statSync(p).isFile()) add(f, readFileSync(p)) } // working tree
if (existsSync(here('../.git'))) {
  // Staged versions and every object ever stored (blobs and commit messages), parsed from `git cat-file --batch`.
  const all = git(['cat-file', '--batch-all-objects', '--batch'])
  for (let i = 0; i < all.length;) {
    const nl = all.indexOf(10, i); const [oid, type, size] = all.toString('latin1', i, nl).split(' '); const n = Number(size)
    if (type === 'blob' || type === 'commit' || type === 'tag') add(`git object ${oid.slice(0, 10)} (${type})`, all.subarray(nl + 1, nl + 1 + n))
    i = nl + 1 + n + 1
  }
}

let bad = 0
const hit = (label, what) => { bad++; console.log(`LEAK ${what} in ${label}`) }
for (const [label, text] of corpus) {
  const lower = text.toLowerCase()
  for (const n of needles) if (lower.includes(n)) hit(label, 'key value')
  for (const p of patterns) if (p.test(text)) hit(label, 'key-like pattern')
}
const checked = needles.length ? `${keyFiles.filter(existsSync).length} key file(s) checked by exact value` : 'exact-value check NOT RUN (no key files found; set MEZO_KEY_FILE / MEZO_PAYEE_KEY_FILE)'
console.log(`secret scan: ${bad ? bad + ' problem(s)' : 'clean'}; ${corpus.length} items scanned; ${checked}; pattern check ran`)
process.exit(bad || (strict && !needles.length) ? 1 : 0)
