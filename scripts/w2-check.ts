// Checks that every link and every transaction hash on the pages a Wave 2 reader opens first still resolves: docs/WAVE2.md, evidence/w2/INDEX.md
// and the top of README.md (everything before "## Where each judging criterion is answered"). Read-only: it reads the Mezo testnet RPC and fetches
// public pages; it holds no key and sends no transaction.
//   - a link to a file in this repo: the file exists; a #L12 or #L12-L14 part must lie inside the file; any other #part must be a heading of that .md file
//   - a 64-hex transaction hash, or an explorer /tx/ link: the RPC returns its receipt (the RPC nodes often answer "not found" for a mined tx, so it asks again)
//   - an explorer /address/ link: the RPC shows code or use at that address (the explorer is a single-page app, so its HTML says nothing)
//   - a github.com link to this repo's commit or file: PENDING-PUSH while the commit or path is only in the local main, not yet in origin/main; otherwise a 200
//   - any other http(s) link: a 200 after redirects
// One PASS, FAIL or PENDING-PUSH line per link. The exit code is 1 on any FAIL; PENDING-PUSH does not fail (push, then run it again).
// Usage: npm run w2:check [-- file.md ...]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Address, Hex } from 'viem'
import { publicClient } from '../src/clients.ts'
import { createReport } from './lib/report.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const REPO = 'github.com/Kylne700/mezo-agent-toolkit'
const README_TOP_ENDS = '## Where each judging criterion is answered'
const targets = process.argv.slice(2).length ? process.argv.slice(2).map((p) => resolve(p)) : ['docs/WAVE2.md', 'evidence/w2/INDEX.md', 'README.md'].map((p) => resolve(root, p))

const pub = publicClient()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The text of a file that this check covers; for the README only the top. */
function pageText(file: string): string {
  const text = readFileSync(file, 'utf8')
  if (basename(file) !== 'README.md') return text
  const cut = text.indexOf(README_TOP_ENDS)
  return cut < 0 ? text : text.slice(0, cut)
}

/** GitHub's heading anchors: lower case, markup and punctuation dropped, spaces to hyphens, a repeated heading gets -1, -2. */
function anchors(file: string): Set<string> {
  const seen = new Map<string, number>()
  const out = new Set<string>()
  let fenced = false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced
    const m = !fenced && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const slug = m[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*~]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/ /g, '-')
    const n = seen.get(slug) ?? 0
    seen.set(slug, n + 1)
    out.add(n ? `${slug}-${n}` : slug)
  }
  return out
}

interface Found { kind: 'file' | 'http' | 'hash'; target: string }

/** Every relative link, every http(s) link (also inside code) and every 64-hex string of a page, once each. */
function linksOf(text: string): Found[] {
  const seen = new Set<string>()
  const out: Found[] = []
  const add = (kind: Found['kind'], target: string) => {
    if (seen.has(kind + target)) return
    seen.add(kind + target)
    out.push({ kind, target })
  }
  for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    if (!/^(https?:|mailto:)/.test(m[1])) add('file', m[1])
  }
  for (const m of text.matchAll(/https?:\/\/[^\s)\]>`"'|<]+/g)) add('http', m[0].replace(/[.,;:]+$/, ''))
  for (const m of text.matchAll(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g)) add('hash', m[0].toLowerCase())
  return out
}

/** A transaction receipt from the RPC. Several nodes sit behind the one URL and some answer "not found" for a mined tx, so ask up to 15 times. */
async function receiptOf(hash: Hex) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pub.getTransactionReceipt({ hash })
    } catch (e) {
      if (attempt >= 15) throw e
      await sleep(300 * Math.min(attempt, 4))
    }
  }
}

async function checkHash(hash: string): Promise<[boolean, string]> {
  try {
    const rc = await receiptOf(hash as Hex)
    return [true, `on chain, block ${rc.blockNumber}, status ${rc.status}`]
  } catch {
    return [false, 'the RPC has no receipt for it after 15 tries']
  }
}

async function checkAddress(address: string): Promise<[boolean, string]> {
  try {
    const code = await pub.getCode({ address: address as Address })
    if (code && code !== '0x') return [true, `contract code at the address (${(code.length - 2) / 2} bytes)`]
    const [nonce, balance] = await Promise.all([pub.getTransactionCount({ address: address as Address }), pub.getBalance({ address: address as Address })])
    return nonce > 0 || balance > 0n ? [true, `account in use (nonce ${nonce})`] : [false, 'no code, no transactions and no balance at the address']
  } catch (e) {
    return [false, `RPC error: ${(e as Error).message.split('\n')[0]}`]
  }
}

async function fetchOk(url: string): Promise<[boolean, string]> {
  let last = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(25_000), headers: { 'user-agent': 'mezo-agent-toolkit-w2-check' } })
      void res.body?.cancel()
      if (res.status === 200) return [true, 'HTTP 200']
      last = `HTTP ${res.status}`
      if (res.status < 500 && res.status !== 429) break
    } catch (e) {
      last = (e as Error).message.split('\n')[0]
    }
    await sleep(1000 * attempt)
  }
  return [false, last]
}

function gitOk(...args: string[]): boolean {
  try {
    execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
/** In the local repository but not in origin/main: the link will work once the lead pushes. A commit this repository does not know is checked over HTTP. */
const unpushed = (sha: string) => gitOk('rev-parse', '--verify', '--quiet', `${sha}^{commit}`) && !gitOk('merge-base', '--is-ancestor', sha, 'origin/main')
const pathIn = (ref: string, path: string) => gitOk('cat-file', '-e', `${ref}:${path}`)

type Verdict = ['PASS' | 'FAIL' | 'PENDING-PUSH', string]
const ok = ([good, note]: [boolean, string]): Verdict => [good ? 'PASS' : 'FAIL', note]

async function checkHttp(url: string): Promise<Verdict> {
  const u = new URL(url)
  if (u.hostname === 'explorer.test.mezo.org') {
    const tx = /^\/tx\/(0x[0-9a-fA-F]{64})$/.exec(u.pathname)
    if (tx) return ok(await checkHash(tx[1].toLowerCase()))
    const ad = /^\/address\/(0x[0-9a-fA-F]{40})$/.exec(u.pathname)
    if (ad) return ok(await checkAddress(ad[1]))
  }
  if (`${u.hostname}${u.pathname}`.startsWith(REPO)) {
    const rest = u.pathname.split('/').slice(3) // after /Kylne700/mezo-agent-toolkit
    if (rest[0] === 'commit' && rest[1]) {
      if (unpushed(rest[1])) return ['PENDING-PUSH', `commit ${rest[1]} is in the local repository, not in origin/main`]
      return ok(await fetchOk(url))
    }
    if ((rest[0] === 'blob' || rest[0] === 'tree') && rest[1] && rest[2]) {
      const path = decodeURIComponent(rest.slice(2).join('/'))
      if (rest[1] === 'main') {
        if (pathIn('origin/main', path)) return ok(await fetchOk(url))
        return pathIn('HEAD', path) ? ['PENDING-PUSH', `${path} is in the local main, not in origin/main`] : ['FAIL', `${path} is in neither origin/main nor the local main`]
      }
    }
  }
  return ok(await fetchOk(url))
}

function checkFile(from: string, target: string): Verdict {
  const [pathPart, frag = ''] = target.split('#') as [string, string?]
  const file = pathPart ? resolve(dirname(from), decodeURIComponent(pathPart)) : from
  if (!existsSync(file)) return ['FAIL', `no such file: ${relative(root, file)}`]
  if (!frag) return ['PASS', 'file exists']
  const lines = /^L(\d+)(?:-L?(\d+))?$/.exec(frag)
  if (lines) {
    const body = readFileSync(file, 'utf8')
    const count = body.split('\n').length - (body.endsWith('\n') ? 1 : 0)
    const last = Number(lines[2] ?? lines[1])
    return last <= count && Number(lines[1]) >= 1 ? ['PASS', `file exists, ${count} lines`] : ['FAIL', `line ${last} is past the end of the file (${count} lines)`]
  }
  if (!file.endsWith('.md')) return ['PASS', 'file exists (the #part of a non-markdown file is not checked)']
  return anchors(file).has(frag) ? ['PASS', 'file and heading exist'] : ['FAIL', `no heading with the anchor #${frag}`]
}

const r = createReport()
let pending = 0
let passed = 0
const txDone = new Map<string, Verdict>()
const queue: { page: string; found: Found }[] = []
for (const file of targets) {
  if (!existsSync(file)) {
    r.check(false, `${relative(root, file)}: the page itself is missing`)
    continue
  }
  for (const found of linksOf(pageText(file))) queue.push({ page: file, found })
}
// 64-hex hashes that also appear inside an explorer link are checked once, under the hash.
const hashes = new Set(queue.filter((q) => q.found.kind === 'hash').map((q) => q.found.target))
const work = queue.filter((q) => !(q.found.kind === 'http' && /explorer\.test\.mezo\.org\/tx\/0x[0-9a-fA-F]{64}$/.test(q.found.target) && hashes.has(q.found.target.slice(-66).toLowerCase())))

const results: [string, string, Verdict][] = new Array(work.length)
let next = 0
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < work.length) {
      const i = next++
      const { page, found } = work[i]
      let v: Verdict
      if (found.kind === 'file') v = checkFile(page, found.target)
      else if (found.kind === 'http') v = await checkHttp(found.target)
      else {
        v = txDone.get(found.target) ?? ok(await checkHash(found.target))
        txDone.set(found.target, v)
      }
      results[i] = [relative(root, page), found.target, v]
    }
  }),
)
for (const [page, target, [state, note]] of results) {
  if (state === 'PENDING-PUSH') {
    pending++
    r.log(`PENDING-PUSH  ${page}  ${target}\n        ${note}`)
  } else if (r.check(state === 'PASS', `${page}  ${target}`, [note])) {
    passed++
    r.log(`        ${note}`)
  }
}
r.log('')
r.log(`result: ${passed} PASS, ${r.failures()} FAIL, ${pending} PENDING-PUSH (${work.length} links and hashes on ${targets.length} pages)`)
process.exit(r.failures() > 0 ? 1 : 0)
