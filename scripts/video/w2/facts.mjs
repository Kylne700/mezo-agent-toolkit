// Every fact the Wave 2 video shows or says, read from a repo file or from a free local run. Nothing is typed in except words.
// Writes media/w2/raw/facts.json. No key, no signing, no send: the MCP server is started with a clean environment and no wallet.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { RAW, ROOT, REPO_URL, run } from './common.mjs'

const file = (p) => readFileSync(join(ROOT, p), 'utf8')
const lines = (p) => file(p).split('\n')
const need = (v, what) => { if (v === undefined || v === null || v === '') throw new Error(`facts: ${what} not found`); return v }
const answer = (p) => JSON.parse(file(p).split('\n').slice(1).join('\n')) // first line is "--- tool args, tool answer:"

/** One short MCP session over stdio: the tool names, and optionally one call. Clean environment, so no wallet and no key file. */
async function session(extraEnv, call) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp.ts'], cwd: ROOT, env: { ...getDefaultEnvironment(), ...extraEnv }, stderr: 'pipe' })
  const client = new Client({ name: 'w2-video', version: '0.0.0' })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    let called
    if (call) {
      try { const r = await client.callTool(call); called = { isError: !!r.isError, text: r.content?.[0]?.text ?? '' } } catch (e) { called = { isError: true, text: String(e.message ?? e) } }
    }
    return { names: tools.map((t) => t.name), called }
  } finally { await client.close().catch(() => {}) }
}

export async function gather() {
  // 1. the claim -> repay chain (Proof 1, 2026-11-05)
  const fees = answer('evidence/w2/claim1-fees.txt')
  const rebase = answer('evidence/w2/claim1-rebase.txt')
  const repay = answer('evidence/w2/claim1-repay.txt')
  const prove = lines('evidence/w2/claim1-w2-prove.txt')
  const at = prove.findIndex((l) => l.startsWith('PASS') && l.includes(repay.hash)) // the debt line of this repay, not the earlier one of 2026-10-31
  const dl = at + prove.slice(at).findIndex((l) => /debt [0-9.]+ -> [0-9.]+ MUSD: down by the [0-9.]+ repaid/.test(l))
  if (at < 0 || dl < at) throw new Error('facts: the repay PASS block is not in claim1-w2-prove.txt')
  const [, debtBefore, debtAfter, repaid] = need(prove[dl]?.match(/debt ([0-9.]+) -> ([0-9.]+) MUSD: down by the ([0-9.]+) repaid/), 'the debt line in claim1-w2-prove.txt')
  const claimedRaw = BigInt(fees.expected[0].raw)
  const claimed = (claimedRaw / 10n ** 18n).toString() + '.' + (claimedRaw % 10n ** 18n).toString().padStart(18, '0')
  if (claimed.replace(/0+$/, '') !== repaid.replace(/0+$/, '')) throw new Error(`facts: claimed ${claimed} is not the amount repaid ${repaid}`)
  if (JSON.parse(file('evidence/w2/claim1-repay.txt').split('\n')[0].replace(/^--- trove_repay /, '').replace(/, tool answer:$/, '')).amountMusd !== repaid) throw new Error('facts: the repay call amount differs from the debt line')
  for (const t of [fees, rebase, repay]) if (!t.sent || t.status !== 'success') throw new Error('facts: a Proof 1 transaction is not a success')
  const chain = {
    claim: { hash: fees.hash, block: fees.blockNumber, url: fees.explorer },
    rebase: { hash: rebase.hash, block: rebase.blockNumber },
    repay: { hash: repay.hash, block: repay.blockNumber, url: repay.explorer },
    debtBefore, debtAfter, claimed, debtLine: dl + 1,
    shortClaimed: Number(claimed).toFixed(2), shortBefore: Number(debtBefore).toFixed(2), shortAfter: Number(debtAfter).toFixed(2),
  }
  if (Math.abs(Number(debtBefore) - Number(debtAfter) - Number(claimed)) > 0.001) throw new Error('facts: debt before minus after is not the claimed amount')

  // 2. the tool list and a refused write, from a real stdio session of src/mcp.ts
  const call = { name: 'trove_repay', arguments: { amountMusd: '1' } } // a write the default server does not have; nothing can be sent
  const off = await session({}, call)
  const on = await session({ MEZO_WRITE_ENABLE: 'testnet' })
  const writes = on.names.filter((n) => !off.names.includes(n))
  const reads = off.names.filter((n) => n !== 'pay_and_fetch')
  if (!off.called?.isError) throw new Error('facts: a write call with writes off was not refused')
  if (reads.length !== 13 || writes.length !== 14 || !off.names.includes('pay_and_fetch')) throw new Error(`facts: expected 13 reads + pay_and_fetch + 14 writes, got ${reads.length} / ${writes.length}`)
  const tools = { reads, paid: 'pay_and_fetch', writes, call, refusal: off.called, writeEnv: 'MEZO_WRITE_ENABLE=testnet' }

  // 3. the three review fixes: commits from the review, test results from a vitest run (offline)
  const review = file('docs/SECURITY-REVIEW-W2.md')
  const sev = Object.fromEntries([...review.matchAll(/^\| (R[123]) \| (High|Medium) \|/gm)].map((m) => [m[1], m[2]]))
  const commit = Object.fromEntries([...review.matchAll(/\*\*(R[123]) \(`([0-9a-f]{7})`\)/g)].map((m) => [m[1], m[2]]))
  const want = [
    ['R1', 'test/write.test.ts', 'a second writer on the same receipts file is refused while a send is in flight, then sees its line', 'One writer at a time: a lock next to the receipts file'],
    ['R2', 'test/pay.test.ts', 'refuses plain http except to this machine, where nobody on the network path can rewrite the 402', 'https only: plain http only to this machine'],
    ['R3', 'test/keys.test.ts', 'warns, without the path or the key, when other accounts can read the key file, and still loads it', 'Key file: a warning when other accounts can read it'],
  ]
  const vj = join(RAW, 'vitest.json')
  await run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...want.map((w) => w[1]), '--reporter=json', `--outputFile=${vj}`], { cwd: ROOT, ok: [0, 1] })
  const vr = JSON.parse(readFileSync(vj, 'utf8'))
  const results = vr.testResults.flatMap((f) => f.assertionResults.map((a) => ({ file: f.name, title: a.title, status: a.status })))
  const fixes = want.map(([id, tf, title, label]) => {
    if (!file(tf).includes(title)) throw new Error(`facts: test title not in ${tf}`)
    const r = results.find((x) => x.file.endsWith(tf) && x.title === title)
    if (!r || r.status !== 'passed') throw new Error(`facts: ${id} test did not pass (${r?.status})`)
    return { id, severity: need(sev[id], `${id} severity`), commit: need(commit[id], `${id} commit`), test: title, testFile: tf, label, status: r.status }
  })
  const vitest = { files: want.length, tests: results.length, passed: results.filter((x) => x.status === 'passed').length }

  // 4. payments on chain (economics-2026-11-11.txt L35-L44) and the same count on WAVE2.md
  const eco = lines('evidence/w2/economics-2026-11-11.txt')
  const block = eco.slice(34, 44)
  const count = Number(need(block[0].match(/^(\d+) transfers/), 'payment count line')[1])
  const outside = Number(need(block[9].match(/outside payers (\d+)/), 'outside payers line')[1])
  if (!file('docs/WAVE2.md').includes(`Payments to the demo payee: ${count} of`)) throw new Error('facts: WAVE2.md does not carry the same payment count')
  const payments = { count, outside, block, first: 35, last: 44, source: 'evidence/w2/economics-2026-11-11.txt' }

  // 5. the "Not done" list of WAVE2.md (the bold lead of each bullet); the line marked for the next editor is not part of this video
  const w2 = lines('docs/WAVE2.md')
  const nd = w2.findIndex((l) => l.trim() === '## Not done')
  const notDone = w2.slice(nd + 1).filter((l) => l.startsWith('- **')).map((l) => need(l.match(/^- \*\*(.+?)\*\*/), 'bullet')[1].replace(/`/g, ''))
  if (notDone.length < 8) throw new Error(`facts: only ${notDone.length} Not done bullets`)

  // 6. end card
  const disclosure = need(file('README.md').split('\n').find((l) => l.startsWith('Built with Claude Code')), 'README disclosure')
  const facts = {
    chain, tools, fixes, vitest, payments, notDone, disclosure, repoUrl: REPO_URL,
    status: 'Mezo hackathon, Track 2 Access and Distribution, Wave 2. Testnet only: the mechanics, no real users or mainnet collateral claimed.',
    voiceNote: 'Voice: AI text-to-speech (Cloudflare Workers AI).',
  }
  writeFileSync(join(RAW, 'facts.json'), JSON.stringify(facts, null, 2) + '\n')
  return facts
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const f = await gather()
  console.log(`facts ok: claim ${f.chain.claim.hash.slice(0, 10)} repay ${f.chain.repay.hash.slice(0, 10)} debt ${f.chain.shortBefore}->${f.chain.shortAfter} claimed ${f.chain.shortClaimed}; tools ${f.tools.reads.length}+1+${f.tools.writes.length}; fixes ${f.fixes.map((x) => x.id + ':' + x.commit).join(' ')}; vitest ${f.vitest.passed}/${f.vitest.tests}; payments ${f.payments.count} outside ${f.payments.outside}; notDone ${f.notDone.length}`)
  console.log(`refusal: ${f.tools.refusal.text.slice(0, 200)}`)
}
