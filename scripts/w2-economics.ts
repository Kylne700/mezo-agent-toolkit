// What the Wave 2 transactions cost and who paid us, read from the chain itself: no key, no transaction, only reads from the Mezo testnet RPC.
// Part 1: for every line of evidence/w2/receipts.jsonl (our own ledger) it reads the receipt and prints gasUsed x effectiveGasPrice, so the BTC each leg cost
//   and who paid it. The three older groups of legs must add up to the totals already committed in evidence/w2/*-agreement.txt, which were computed another way.
//   Each claim -> repay cycle (rebase claim, fee claim, repay) is then set against the MUSD it claimed, read from the Transfer in the claim's receipt.
// Part 2: it counts every MUSD transfer to the demo payee of wrangler.toml since FROM_BLOCK and splits them into our wallet and everyone else.
// Only hashes of our own ledger are fetched; no explorer or indexer is asked for anything. The exit code is 1 on any FAIL.
// Usage: npx tsx scripts/w2-economics.ts [--from <block>]
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { formatEther, getAddress, parseAbiItem, type Address, type Hex } from 'viem'
import { priceFeedAbi } from '../src/abis.ts'
import { publicClient } from '../src/clients.ts'
import { ADDRESSES, CHAIN_ID, RPC_URL } from '../src/config.ts'
import { withRetry } from '../src/lens.ts'
import { receiptOf } from './lib/receipts.ts'
import { createReport } from './lib/report.ts'

type Line = { at: string; name: string; from: Address; hash: Hex; musd: string; buyer?: Address }
const root = fileURLToPath(new URL('../', import.meta.url))
// The first x402 payment cannot be older than the swap that funded the buyer (block 16229223, evidence/swap.json); this starts a little before it.
const fromArg = process.argv.indexOf('--from')
const FROM_BLOCK = BigInt(fromArg > 0 ? process.argv[fromArg + 1] : 16_200_000)
const WINDOW = 9_500n // the public RPC refuses log queries over 10,000 blocks
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
// Totals of the first three runs, written by their own checks in another way (the BTC spent minus the BTC moved, or the net BTC change).
const EARLIER = [
  { what: 'veBTC approve + lock + vote', names: ['ve_approve_btc', 've_lock', 've_vote'], wei: 159_924_604n, file: 'evidence/w2/ve-agreement.txt (total spent 0.004000000159924604)' },
  { what: 'trove open + add collateral + repay', names: ['trove_open', 'trove_add_coll', 'trove_repay'], wei: 189_847_888n, file: 'evidence/w2/trove-agreement.txt (spent 0.045300000189847888)' },
  { what: 'pool approve + deposit + liquidate', names: ['sp_approve_musd', 'sp_deposit', 'trove_liquidate'], wei: 86_716_992n, file: 'evidence/w2/a3-agreement.txt (gas 0.000000000086716992)' },
]

const pub = publicClient()
const r = createReport()
const iso = (s: bigint) => new Date(Number(s) * 1000).toISOString()
const ledger = readFileSync(root + 'evidence/w2/receipts.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Line)
const head = await withRetry(() => pub.getBlock(), 8, 300)
const chainId = await pub.getChainId()
r.log(`Wave 2 economics: ${new URL(RPC_URL).origin}, chain ${chainId}, head block ${head.number} (${iso(head.timestamp)})`)
if (!r.check(chainId === CHAIN_ID, `eth_chainId is ${CHAIN_ID}`)) process.exit(1)

// ---- Part 1: gas per leg -------------------------------------------------------------------------------------------------------------------
r.log(`\n# Gas of the ${ledger.length} legs in evidence/w2/receipts.jsonl: gasUsed x effectiveGasPrice from each receipt`)
r.log('leg                time (UTC)            block      gasUsed   wei/gas  fee (wei)     fee (BTC)               paid by')
const wallet = getAddress(ledger[0].from)
const fee = new Map<Hex, bigint>()
const receipts = new Map<Hex, NonNullable<Awaited<ReturnType<typeof receiptOf>>>>()
for (const l of ledger) {
  const rc = await receiptOf(pub, l.hash)
  if (!rc) throw new Error(`no receipt for ${l.name} ${l.hash} after 15 tries`)
  receipts.set(l.hash, rc)
  const f = rc.gasUsed * rc.effectiveGasPrice
  fee.set(l.hash, f)
  const payer = getAddress(rc.from) === wallet ? 'our wallet' : 'the facilitator (' + rc.from.slice(0, 8) + ')'
  r.log(`${l.name.padEnd(19)}${l.at.slice(0, 19).padEnd(22)}${String(rc.blockNumber).padEnd(11)}${String(rc.gasUsed).padEnd(10)}${String(rc.effectiveGasPrice).padEnd(9)}${String(f).padEnd(14)}${formatEther(f).padEnd(24)}${payer}`)
}
const own = ledger.filter((l) => getAddress(receipts.get(l.hash)!.from) === wallet)
const sum = (ls: Line[]) => ls.reduce((a, l) => a + fee.get(l.hash)!, 0n)
r.log(`\nlegs sent and paid by our wallet: ${own.length}, ${sum(own)} wei = ${formatEther(sum(own))} BTC`)
r.log(`legs paid by the facilitator: ${ledger.length - own.length}, ${sum(ledger) - sum(own)} wei = ${formatEther(sum(ledger) - sum(own))} BTC`)

r.log('\n# The first three runs: the same method must give the totals their own checks wrote down')
for (const g of EARLIER) {
  const legs = g.names.map((n) => ledger.find((l) => l.name === n && l.at < '2026-11-01'))
  const ok = legs.every(Boolean) && sum(legs as Line[]) === g.wei
  r.check(ok, `${g.what}: ${legs.every(Boolean) ? sum(legs as Line[]) : '?'} wei, expected ${g.wei}`, [g.file])
}

// ---- cycles: claim rebase, claim fees, repay -----------------------------------------------------------------------------------------------
const cycles: Line[][] = []
for (const l of ledger) {
  const open = cycles.at(-1)
  if (l.name === 've_claim_rebase') cycles.push([l])
  else if (open && open.length < 3 && l.name === (open.length === 1 ? 've_claim_rewards' : 'trove_repay')) open.push(l)
}
for (const [i, c] of cycles.entries()) {
  r.log(`\n# Claim -> repay cycle ${i + 1}: ${c.map((l) => l.name).join(', ')}`)
  const [, claim, repay] = c
  const gas = sum(c)
  const claimed = receipts.get(claim.hash)!.logs.filter((lg) => lg.address.toLowerCase() === ADDRESSES.musd.toLowerCase() && lg.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' && lg.topics[2] && getAddress('0x' + lg.topics[2].slice(26)) === wallet)
    .reduce((a, lg) => a + BigInt(lg.data), 0n)
  r.check(claimed === BigInt(repay.musd), `MUSD that the fee claim sent to the wallet (${formatEther(claimed)}) equals the MUSD the repay paid (${formatEther(BigInt(repay.musd))})`)
  r.log(`gas of the cycle: ${gas} wei = ${formatEther(gas)} BTC; gasUsed ${c.reduce((a, l) => a + receipts.get(l.hash)!.gasUsed, 0n)}`)
  r.log(`MUSD claimed: ${formatEther(claimed)}`)
  // The PriceFeed at the repay block turns the BTC gas into dollars; a pruned state only drops this one line.
  const block = receipts.get(repay.hash)!.blockNumber
  const p = await withRetry(() => pub.readContract({ address: ADDRESSES.priceFeed, abi: priceFeedAbi, functionName: 'fetchPrice', blockNumber: block }), 8, 300).catch(() => undefined)
  r.log(p === undefined ? `the BTC price at block ${block} could not be read (state pruned?)` : `PriceFeed at block ${block}: ${formatEther(p)} USD per BTC; the cycle's gas = ${formatEther((gas * p) / 10n ** 18n)} USD`)
}

// ---- Part 2: who paid the demo payee ---------------------------------------------------------------------------------------------------------
const payee = getAddress(readFileSync(root + 'wrangler.toml', 'utf8').match(/PAYEE_ADDRESS\s*=\s*"(0x[0-9a-fA-F]{40})"/)![1])
const mine = new Set(ledger.flatMap((l) => [l.buyer, own.includes(l) ? l.from : undefined]).filter(Boolean).map((a) => getAddress(a!)))
r.log(`\n# MUSD transfers to the demo payee ${payee} (PAYEE_ADDRESS of wrangler.toml), blocks ${FROM_BLOCK} to ${head.number}`)
const logs: { from: Address; value: bigint; block: bigint }[] = []
for (let from = FROM_BLOCK; from <= head.number; from += WINDOW + 1n) {
  const to = from + WINDOW < head.number ? from + WINDOW : head.number
  const got = await withRetry(() => pub.getLogs({ address: ADDRESSES.musd, event: transfer, args: { to: payee }, fromBlock: from, toBlock: to }), 8, 400)
  for (const lg of got) logs.push({ from: getAddress(lg.args.from!), value: lg.args.value!, block: lg.blockNumber })
}
const bySender = new Map<Address, { n: number; total: bigint }>()
const byAmount = new Map<bigint, number>()
for (const t of logs) {
  const s = bySender.get(t.from) ?? { n: 0, total: 0n }
  bySender.set(t.from, { n: s.n + 1, total: s.total + t.value })
  byAmount.set(t.value, (byAmount.get(t.value) ?? 0) + 1)
}
const total = logs.reduce((a, t) => a + t.value, 0n)
r.log(`${logs.length} transfers, ${formatEther(total)} MUSD in all; first at block ${logs[0]?.block}, last at block ${logs.at(-1)?.block}`)
for (const [a, v] of byAmount) r.log(`  ${v} transfers of ${formatEther(a)} MUSD`)
for (const [a, s] of bySender) r.log(`  from ${a}${mine.has(a) ? ' (our wallet)' : ' (NOT in our ledger)'}: ${s.n} transfers, ${formatEther(s.total)} MUSD`)
// When each payment was mined, by UTC date (logs run oldest first). SUBMISSION.md says 39 up to 2026-10-19; the Wave 1 review counted 41 on 2026-10-30.
const day = new Map<bigint, string>()
for (const b of new Set(logs.map((t) => t.block))) day.set(b, iso((await withRetry(() => pub.getBlock({ blockNumber: b }), 8, 300)).timestamp).slice(0, 10))
const perDay = new Map<string, number>()
for (const t of logs) perDay.set(day.get(t.block)!, (perDay.get(day.get(t.block)!) ?? 0) + 1)
let sofar = 0
for (const [d, n] of perDay) r.log(`  mined on ${d}: ${n} transfers (${(sofar += n)} so far)`)
const outside = [...bySender].filter(([a]) => !mine.has(a))
r.check(outside.length === 0, `every transfer to the demo payee came from our wallet: outside payers ${outside.length}, outside transfers ${outside.reduce((a, [, s]) => a + s.n, 0)}`, outside.map(([a, s]) => `${a}: ${s.n} transfers`))

r.log(`\nresult: ${r.failures()} FAIL`)
process.exit(r.failures() ? 1 : 0)
