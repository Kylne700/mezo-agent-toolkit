// Writes evidence/take-facts.json, the facts the deck shows (scripts/deck/build.mjs): the day of the take, its two payments with their blocks, the lens walk
// and the test count of a fresh `npm test` (offline, nothing is spent). Reads media/raw/take.json (take.ts writes it); calls no network.
//   node scripts/video/facts.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RAW, ROOT } from './config.mjs'
import { run } from './lib.mjs'

const take = JSON.parse(readFileSync(join(RAW, 'take.json'), 'utf8'))
const test = await run('npm', ['test'], { cwd: ROOT, ok: [0, 1] })
const out = (test.stdout + test.stderr).replace(/\x1b\[[0-9;]*m/g, '')
const files = out.match(/Test Files\s+(\d+) passed \((\d+)\)/)
const tests = out.match(/Tests\s+(\d+) passed \((\d+)\)/)
if (test.code !== 0 || !files || !tests || files[1] !== files[2] || tests[1] !== tests[2]) throw new Error('npm test did not pass in full; no facts written')
const facts = {
  date: take.day,
  explorerTx: 'https://explorer.test.mezo.org/tx/',
  tests: { passed: Number(tests[1]), files: Number(files[1]) },
  lens: { stepsWalked: take.lens.stepsWalked, listSize: take.lens.listSize },
  txs: [
    { label: 'x402 buyer, one paid call', hash: take.plain.tx, block: Number(take.explorer.plain.block) },
    { label: 'MCP pay_and_fetch, one paid call', hash: take.mcp.paid.tx, block: Number(take.explorer.mcp.block) },
  ],
}
writeFileSync(join(ROOT, 'evidence/take-facts.json'), JSON.stringify(facts, null, 1) + '\n')
console.log(`facts: ${facts.tests.passed} tests in ${facts.tests.files} files, lens ${facts.lens.stepsWalked} of ${facts.lens.listSize}, ${facts.txs.length} transactions (${facts.date}) -> evidence/take-facts.json`)
