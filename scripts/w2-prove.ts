// Re-proves the Wave 2 testnet evidence from the chain itself: no key, no transaction, only reads from the Mezo testnet RPC.
// It takes every line of evidence/w2/receipts.jsonl (what the write core logged for each real transaction) plus the MezoLens deploy tx from
// deployments/testnet.json, fetches each transaction and its receipt, checks that the ledger agrees with the chain (sender, target, nonce, selector,
// gas, amounts) and then reads the state the leg claims at the receipt's block and at the block before it.
// One PASS, FAIL or SKIP line per leg. SKIP = the RPC no longer serves state at that old block (pruned); the receipt checks of that leg still ran and passed.
// The exit code is 1 on any FAIL. Only hashes of our own ledger and our own deploy are fetched; any other 64-hex string found in evidence/w2/*.txt is only counted.
// Usage: npm run w2:prove
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData, isAddressEqual, parseAbi, parseEventLogs, zeroAddress, type Abi, type Address, type Hex } from 'viem'
import deployment from '../deployments/testnet.json' with { type: 'json' }
import { borrowerOperationsAbi, erc20Abi, poolsVoterAbi, priceFeedAbi, stabilityPoolAbi, troveManagerAbi, veBtcAbi } from '../src/abis.ts'
import { publicClient } from '../src/clients.ts'
import { ADDRESSES, CHAIN_ID, RPC_URL } from '../src/config.ts'
import { TROVE_STATUS, fixed, percent, withRetry } from '../src/lens.ts'
import { ALLOW } from '../src/policy.ts'
import { createSp } from '../src/sp-actions.ts'
import { createReport } from './lib/report.ts'

type Line = { at: string; name: string; from: Address; to: Address; selector: Hex; nonce: number; hash: Hex; status: string; musd: string; btc: string; gas: string; maxFeePerGas: string }
type Tx = Awaited<ReturnType<ReturnType<typeof publicClient>['getTransaction']>>
type Receipt = Awaited<ReturnType<ReturnType<typeof publicClient>['getTransactionReceipt']>>
interface Ctx { line: Line; tx: Tx; rc: Receipt; block: bigint; ts: bigint; me: Address; facts: string[]; problems: string[] }

const pub = publicClient()
const r = createReport()
const dir = fileURLToPath(new URL('../evidence/w2/', import.meta.url))
const { stabilityPool: pool, musd, btc, veBTC, poolsVoter, troveManager, priceFeed } = ADDRESSES
const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])
const lensAbi = parseAbi(['function veBTC() view returns (address)'])
// 0.001 MUSD: the interest a trove accrues between two blocks (about 4 s) and a liquidation loss in the same block are far smaller than this.
const TOL = 10n ** 15n

const same = (a?: string | null, b?: string | null) => !!a && !!b && isAddressEqual(a as Address, b as Address)
const abs = (x: bigint) => (x < 0n ? -x : x)
const f = (x: bigint) => fixed(x, 18, 18)
const iso = (s: bigint) => new Date(Number(s) * 1000).toISOString()
const msg = (e: unknown) => String((e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : e)).slice(0, 200)
// The RPC is several nodes behind one URL and some of them answer "not found" for a transaction or block that exists (measured: about half the asks for our own hashes), so ask again.
async function again<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn() } catch (e) {
      if (i >= tries) throw e
      await new Promise((ok) => setTimeout(ok, 300))
    }
  }
}
const rd = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[], blockNumber: bigint) =>
  withRetry(() => pub.readContract({ address, abi, functionName, args, blockNumber }) as Promise<T>, 8, 300)
const must = (c: Ctx, ok: boolean, text: string) => void (ok ? c.facts : c.problems).push(text)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const argsOf = (abi: Abi, c: Ctx): any[] => [...(decodeFunctionData({ abi, data: c.tx.input }).args ?? [])]
const bal = (token: Address, who: Address, b: bigint) => rd<bigint>(token, erc20Abi, 'balanceOf', [who], b)
const allowance = (token: Address, who: Address, spender: Address, b: bigint) => rd<bigint>(token, erc20Abi, 'allowance', [who, spender], b)
const position = (who: Address, b: bigint) => rd<bigint>(pool, stabilityPoolAbi, 'getCompoundedMUSDDeposit', [who], b)
async function trove(who: Address, b: bigint) {
  const status = Number(await rd<number>(troveManager, troveManagerAbi, 'getTroveStatus', [who], b))
  if (status !== 1) return { status, coll: 0n, debt: 0n }
  const e = await rd<readonly bigint[]>(troveManager, troveManagerAbi, 'getEntireDebtAndColl', [who], b)
  return { status, coll: e[0]! + e[3]!, debt: e[1]! + e[2]! + e[4]! + e[5]! }
}
const transfers = (c: Ctx) => parseEventLogs({ abi: transferAbi, eventName: 'Transfer', logs: c.rc.logs }).filter((l) => same(l.address, musd))

/** sp_status (the tool) must equal the StabilityPool read directly, at the receipt's block. */
async function agreement(c: Ctx) {
  const tool = (await createSp(pub).status({ address: c.me }, { blockNumber: c.block })) as { raw: Record<string, string | null> }
  const direct: Record<string, string> = {}
  for (const [key, fn, args] of [['deposit', 'deposits', [c.me]], ['compounded', 'getCompoundedMUSDDeposit', [c.me]], ['collateralGain', 'getDepositorCollateralGain', [c.me]], ['totalDeposits', 'getTotalMUSDDeposits', []], ['collateralBalance', 'getCollateralBalance', []]] as const)
    direct[key] = String(await rd<bigint>(pool, stabilityPoolAbi, fn, args, c.block))
  const bad = Object.keys(direct).filter((k) => tool.raw[k] !== direct[k])
  must(c, bad.length === 0, bad.length ? `sp_status differs from the direct pool reads at block ${c.block}: ${bad.map((k) => `${k} ${tool.raw[k]} vs ${direct[k]}`).join('; ')}` : `sp_status equals the direct StabilityPool reads at block ${c.block} (deposit ${direct.deposit}, compounded ${direct.compounded}, BTC gain ${direct.collateralGain}, pool total ${direct.totalDeposits}, pool BTC ${direct.collateralBalance} wei)`)
}

async function revoke(c: Ctx, token: Address) {
  const [spender, amount] = argsOf(erc20Abi, c)
  const [before, after] = await Promise.all([allowance(token, c.me, spender, c.block - 1n), allowance(token, c.me, spender, c.block)])
  must(c, amount === 0n && after === 0n && before > 0n, `allowance of the wallet for ${spender}: ${f(before)} before block ${c.block}, ${f(after)} at it`)
}

// What each ledger name claims, read from the chain at the receipt's block (and the block before it for changes). A leg that is not here is a FAIL: nothing goes unchecked.
const legs: Record<string, (c: Ctx) => Promise<void>> = {
  async ve_approve_btc(c) {
    const [spender, amount] = argsOf(erc20Abi, c)
    const now = await allowance(btc, c.me, spender, c.block)
    must(c, same(spender, veBTC) && now === amount, `BTC allowance of the wallet for ${spender} (veBTC) at block ${c.block} is ${f(now)}; the approve asked for ${f(amount)}`)
  },
  async ve_lock(c) {
    const [value, duration] = argsOf(veBtcAbi, c)
    const mint = parseEventLogs({ abi: veBtcAbi, eventName: 'Transfer', logs: c.rc.logs }).find((l) => same(l.address, veBTC) && same(l.args.from, zeroAddress) && same(l.args.to, c.me))
    must(c, !!mint, 'the receipt carries the LIVE veBTC event that mints a veNFT to the wallet')
    if (!mint) return
    const id = mint.args.tokenId
    const [owner, lock] = await Promise.all([rd<Address>(veBTC, veBtcAbi, 'ownerOf', [id], c.block), rd<{ amount: bigint; end: bigint; isPermanent: boolean }>(veBTC, veBtcAbi, 'locked', [id], c.block)])
    must(c, same(owner, c.me), `veNFT ${id} is owned by the wallet at block ${c.block}`)
    must(c, lock.amount === value, `veNFT ${id} locks ${f(lock.amount)} BTC; createLock asked for ${f(value)}`)
    must(c, !lock.isPermanent && lock.end > c.ts && lock.end <= c.ts + duration, `the lock ends ${iso(lock.end)}, within the ${duration} s asked for (the contract rounds the end down to a Thursday)`)
  },
  async ve_vote(c) {
    const [id, pools, weights] = argsOf(poolsVoterAbi, c)
    const [voted, last, used] = await Promise.all([rd<boolean>(veBTC, veBtcAbi, 'voted', [id], c.block), rd<bigint>(poolsVoter, poolsVoterAbi, 'lastVoted', [id], c.block), rd<bigint>(poolsVoter, poolsVoterAbi, 'usedWeights', [id], c.block)])
    must(c, voted, `veNFT ${id}: voted() is true at block ${c.block}`)
    must(c, last === c.ts && used > 0n, `lastVoted(${id}) is ${last} (the block time ${c.ts}), usedWeights ${used}`)
    for (const [i, pool] of (pools as Address[]).entries()) {
      const v = await rd<bigint>(poolsVoter, poolsVoterAbi, 'votes', [id, pool], c.block)
      must(c, v > 0n, `votes(${id}, ${pool}) is ${v} at block ${c.block} (weight asked ${weights[i]})`)
    }
  },
  async trove_open(c) {
    const [debt] = argsOf(borrowerOperationsAbi, c)
    const [a, b, reserve, m0, m1] = await Promise.all([trove(c.me, c.block - 1n), trove(c.me, c.block), rd<bigint>(troveManager, troveManagerAbi, 'MUSD_GAS_COMPENSATION', [], c.block), bal(musd, c.me, c.block - 1n), bal(musd, c.me, c.block)])
    must(c, a.status !== 1 && b.status === 1, `trove of the wallet: ${TROVE_STATUS[a.status]} before block ${c.block}, ${TROVE_STATUS[b.status]} at it`)
    must(c, b.coll - a.coll === c.tx.value, `collateral +${f(b.coll - a.coll)} BTC; the tx carried ${f(c.tx.value)} BTC`)
    must(c, b.debt - a.debt >= debt + reserve, `debt +${f(b.debt - a.debt)} MUSD: at least the ${f(debt)} asked for plus the ${f(reserve)} reserve (the borrowing fee comes on top)`)
    must(c, m1 - m0 === debt, `wallet MUSD +${f(m1 - m0)}; openTrove asked for ${f(debt)}`)
  },
  async trove_add_coll(c) {
    const [a, b] = await Promise.all([trove(c.me, c.block - 1n), trove(c.me, c.block)])
    must(c, a.status === 1 && b.status === 1, 'the trove is active before and at the block')
    must(c, b.coll - a.coll === c.tx.value, `collateral +${f(b.coll - a.coll)} BTC; the tx carried ${f(c.tx.value)} BTC`)
    must(c, b.debt >= a.debt && b.debt - a.debt <= TOL, `debt ${f(a.debt)} -> ${f(b.debt)} MUSD: only interest`)
  },
  async trove_repay(c) {
    const [amount] = argsOf(borrowerOperationsAbi, c)
    const [a, b, m0, m1] = await Promise.all([trove(c.me, c.block - 1n), trove(c.me, c.block), bal(musd, c.me, c.block - 1n), bal(musd, c.me, c.block)])
    must(c, a.status === 1 && b.status === 1 && b.coll === a.coll, 'the trove is active before and at the block, collateral unchanged')
    must(c, abs(a.debt - amount - b.debt) <= TOL, `debt ${f(a.debt)} -> ${f(b.debt)} MUSD: down by the ${f(amount)} repaid, within ${f(TOL)} of interest`)
    must(c, m0 - m1 === amount, `wallet MUSD -${f(m0 - m1)}; repayMUSD asked for ${f(amount)}`)
  },
  async sp_approve_musd(c) {
    const [spender, amount] = argsOf(erc20Abi, c)
    const now = await allowance(musd, c.me, spender, c.block)
    must(c, same(spender, pool) && now === amount, `MUSD allowance of the wallet for ${spender} (StabilityPool) at block ${c.block} is ${f(now)}; the approve asked for ${f(amount)}`)
  },
  async sp_deposit(c) {
    const [amount] = argsOf(stabilityPoolAbi, c)
    const [p0, p1, m0, m1] = await Promise.all([position(c.me, c.block - 1n), position(c.me, c.block), bal(musd, c.me, c.block - 1n), bal(musd, c.me, c.block)])
    must(c, transfers(c).some((l) => same(l.args.from, c.me) && same(l.args.to, pool) && l.args.value === amount), `the receipt carries the MUSD Transfer wallet -> StabilityPool of ${f(amount)}`)
    must(c, m0 - m1 === amount, `wallet MUSD -${f(m0 - m1)}; provideToSP asked for ${f(amount)}`)
    must(c, abs(p1 - p0 - amount) <= TOL, `the wallet's pool deposit ${f(p0)} -> ${f(p1)} MUSD (+${f(amount)} asked for)`)
    await agreement(c)
  },
  async sp_withdraw(c) {
    const [amount] = argsOf(stabilityPoolAbi, c)
    const [p0, p1, m0, m1] = await Promise.all([position(c.me, c.block - 1n), position(c.me, c.block), bal(musd, c.me, c.block - 1n), bal(musd, c.me, c.block)])
    const out = amount < p0 ? amount : p0 // a request above the deposit withdraws all of it
    must(c, transfers(c).some((l) => same(l.args.from, pool) && same(l.args.to, c.me) && abs(l.args.value - out) <= TOL), `the receipt carries the MUSD Transfer StabilityPool -> wallet of about ${f(out)}`)
    must(c, abs(m1 - m0 - out) <= TOL, `wallet MUSD +${f(m1 - m0)}; ${f(out)} expected`)
    must(c, abs(p0 - out - p1) <= TOL, `the wallet's pool deposit ${f(p0)} -> ${f(p1)} MUSD`)
    await agreement(c)
  },
  async trove_liquidate(c) {
    const [borrower] = argsOf(troveManagerAbi, c)
    const events = parseEventLogs({ abi: troveManagerAbi, logs: c.rc.logs })
    const gone = events.find((l) => l.eventName === 'TroveLiquidated' && same(l.args.borrower, borrower))
    const totals = events.find((l) => l.eventName === 'Liquidation')
    must(c, !!gone && !!totals, 'the receipt carries TroveLiquidated for the borrower and the Liquidation totals')
    if (!totals || totals.eventName !== 'Liquidation') return
    const before = c.block - 1n
    const [s0, s1, price, mcr, m0, m1, b0, b1, t0, t1, k0, k1] = await Promise.all([
      trove(borrower, before), rd<number>(troveManager, troveManagerAbi, 'getTroveStatus', [borrower], c.block), rd<bigint>(priceFeed, priceFeedAbi, 'fetchPrice', [], before), rd<bigint>(troveManager, troveManagerAbi, 'MCR', [], before),
      bal(musd, c.me, before), bal(musd, c.me, c.block), pub.getBalance({ address: c.me, blockNumber: before }), pub.getBalance({ address: c.me, blockNumber: c.block }),
      rd<bigint>(pool, stabilityPoolAbi, 'getTotalMUSDDeposits', [], before), rd<bigint>(pool, stabilityPoolAbi, 'getTotalMUSDDeposits', [], c.block),
      rd<bigint>(pool, stabilityPoolAbi, 'getCollateralBalance', [], before), rd<bigint>(pool, stabilityPoolAbi, 'getCollateralBalance', [], c.block),
    ])
    const icr = await rd<bigint>(troveManager, troveManagerAbi, 'getCurrentICR', [borrower, price], before)
    must(c, s0.status === 1 && Number(s1) === 3, `trove of ${borrower}: ${TROVE_STATUS[s0.status]} at block ${before}, ${TROVE_STATUS[Number(s1)]} at ${c.block}`)
    must(c, icr < mcr, `the trove was at ${percent(icr)}% at block ${before}, under the ${percent(mcr)}% minimum (BTC price ${fixed(price, 18, 2)})`)
    const { collGasCompensation: collComp, gasCompensation: musdComp } = totals.args
    must(c, m1 - m0 === musdComp, `wallet MUSD +${f(m1 - m0)}; the gas compensation in the event is ${f(musdComp)}`)
    must(c, b1 - b0 === collComp - c.rc.gasUsed * c.rc.effectiveGasPrice, `wallet BTC ${b1 >= b0 ? '+' : '-'}${f(abs(b1 - b0))}: the ${f(collComp)} collateral compensation minus the gas it paid`)
    must(c, t1 < t0 && k1 > k0, `the pool absorbed it: deposits ${f(t0)} -> ${f(t1)} MUSD, BTC held ${f(k0)} -> ${f(k1)}`)
    await agreement(c)
  },
  approve_revoke_btc: (c) => revoke(c, btc),
  approve_revoke_musd: (c) => revoke(c, musd),
}

let pass = 0
let skip = 0
/** Prints one verdict line for a leg: PASS (facts listed), FAIL (problems listed) or SKIP (old state not served, receipt checks passed). */
function verdict(c: Ctx, title: string, skipped: string) {
  if (c.problems.length) return void r.check(false, title, c.problems)
  if (skipped) {
    skip++
    r.log(`SKIP  ${title}`)
    r.log(`        ${skipped}; the receipt checks passed:`)
  } else {
    pass++
    r.check(true, title)
  }
  for (const t of c.facts) r.log(`        ${t}`)
}

async function proveLine(line: Line) {
  const title = `${line.name.padEnd(20)} nonce ${line.nonce}  ${line.hash}`
  let c: Ctx
  try {
    const [tx, rc] = await Promise.all([again(() => pub.getTransaction({ hash: line.hash })), again(() => pub.getTransactionReceipt({ hash: line.hash }))])
    const ts = (await again(() => pub.getBlock({ blockNumber: rc.blockNumber }))).timestamp
    c = { line, tx, rc, block: rc.blockNumber, ts, me: line.from, facts: [], problems: [] }
  } catch (e) {
    return void r.check(false, title, [`the chain has no such transaction or receipt: ${msg(e)}`])
  }
  const { tx, rc } = c
  must(c, rc.status === line.status, `receipt status ${rc.status} at block ${c.block} (${iso(c.ts)}); the ledger says ${line.status}`)
  must(c, same(tx.from, line.from) && same(rc.from, line.from) && same(tx.to, line.to) && tx.nonce === line.nonce && tx.input.slice(0, 10) === line.selector, `sent by ${tx.from} to ${tx.to}, nonce ${tx.nonce}, selector ${tx.input.slice(0, 10)}: as the ledger says`)
  must(c, tx.gas === BigInt(line.gas) && tx.maxFeePerGas === BigInt(line.maxFeePerGas), `gas limit ${tx.gas} (used ${rc.gasUsed}), max fee per gas ${tx.maxFeePerGas}: as the ledger says`)
  const entry = ALLOW.find((e) => e.name === line.name)
  must(c, !!entry && same(entry.contract, tx.to) && entry.selector === line.selector, `the allow-list entry ${line.name} covers this target and function`)
  try {
    const moved = entry!.amounts(tx.input)
    const btcWei = moved.btc + tx.value + tx.gas * (tx.maxFeePerGas ?? 0n) // what the write core counted: calldata BTC + tx value + worst-case gas fee
    must(c, moved.musd.toString() === line.musd && btcWei.toString() === line.btc, `ledger amounts musd ${line.musd}, btc ${line.btc} = the calldata and value on chain`)
  } catch (e) {
    must(c, false, `the allow-list entry rejects this calldata: ${msg(e)}`)
  }
  let skipped = ''
  if (rc.status === 'success' && line.status === 'success') {
    try {
      const leg = legs[line.name]
      if (!leg) must(c, false, `no state check is written for ${line.name}`)
      else await leg(c)
    } catch (e) {
      const served = await Promise.all([c.block - 1n, c.block].map((b) => again(() => pub.getBalance({ address: c.me, blockNumber: b }), 6).then(() => true, () => false)))
      if (served.every(Boolean)) must(c, false, `a state read failed: ${msg(e)}`)
      else skipped = `the node no longer serves state at block ${served[0] ? c.block : c.block - 1n}`
    }
  }
  verdict(c, title, skipped)
}

async function proveDeploy() {
  const d = deployment.MezoLens
  const hash = d.txHash as Hex
  const title = `${'MezoLens deploy'.padEnd(20)} ${hash}`
  try {
    const [tx, rc, code, ve] = await Promise.all([
      again(() => pub.getTransaction({ hash })), again(() => pub.getTransactionReceipt({ hash })), again(() => pub.getCode({ address: d.address as Address })),
      again(() => pub.readContract({ address: d.address as Address, abi: lensAbi, functionName: 'veBTC' })),
    ])
    const c: Ctx = { line: {} as Line, tx, rc, block: rc.blockNumber, ts: 0n, me: d.deployer as Address, facts: [], problems: [] }
    must(c, rc.status === 'success' && rc.blockNumber === BigInt(d.blockNumber), `receipt status ${rc.status} at block ${rc.blockNumber}; the record says ${d.blockNumber}`)
    must(c, same(tx.from, d.deployer) && same(rc.contractAddress, d.address), `${tx.from} created ${rc.contractAddress}; the record says ${d.deployer} created ${d.address}`)
    must(c, !!code && (code.length - 2) / 2 === d.deployedCodeBytes, `the contract has ${code ? (code.length - 2) / 2 : 0} bytes of code; the record says ${d.deployedCodeBytes}`)
    must(c, same(ve, veBTC), `the lens reads veBTC ${ve}: the LIVE system (${veBTC}), not the old one`)
    verdict(c, title, '')
  } catch (e) {
    r.check(false, title, [msg(e)])
  }
}

// ---- run ----------------------------------------------------------------------------------------------------------------------------------
const chainId = await pub.getChainId()
r.log(`Wave 2 proof: ${new URL(RPC_URL).origin}, chain ${chainId}, head block ${await pub.getBlockNumber()}`)
if (!r.check(chainId === CHAIN_ID, `eth_chainId is ${CHAIN_ID}`, [`the RPC answered ${chainId}`])) process.exit(1)

r.log('\n# Transactions of evidence/w2/receipts.jsonl (one leg each)')
const lines: Line[] = []
for (const [i, text] of readFileSync(dir + 'receipts.jsonl', 'utf8').split('\n').entries()) {
  if (!text.trim()) continue
  try { lines.push(JSON.parse(text) as Line) } catch { r.check(false, `receipts.jsonl line ${i + 1} is JSON`, [text.slice(0, 80)]) }
}
for (const line of lines) await proveLine(line)

r.log('\n# The MezoLens deploy of deployments/testnet.json')
await proveDeploy()

r.log('\n# 64-hex strings in evidence/w2/*.txt')
const known = new Set([...lines.map((l) => l.hash), deployment.MezoLens.txHash].map((h) => h.toLowerCase()))
const seen = new Map<string, string>()
for (const file of readdirSync(dir).filter((n) => n.endsWith('.txt')))
  for (const h of readFileSync(dir + file, 'utf8').match(/(?<![0-9a-fA-F])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g) ?? []) seen.set(h.toLowerCase(), file)
const other = [...seen].filter(([h]) => !known.has(h))
const words = other.filter(([h]) => /^0x0{16}/.test(h)).length // an ABI word (an id or an amount), not a hash
r.log(`        ${seen.size} distinct: ${seen.size - other.length} are ledger or deploy transactions (re-read above), ${words} are ABI words, ${other.length - words} are other and are not fetched`)
for (const [h, file] of other.filter(([h]) => !/^0x0{16}/.test(h))) r.log(`        not fetched: ${h} (${file})`)

r.log(`\nresult: ${pass} PASS, ${r.failures()} FAIL, ${skip} SKIP`)
process.exitCode = r.failures() ? 1 : 0
