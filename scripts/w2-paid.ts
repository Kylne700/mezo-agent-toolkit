// One real paid call, end to end, on Mezo testnet: a local server (the same createApp the Worker runs; its planners read the real chain) with payTo = our own
// wallet, paid by the same buyer code the MCP pay_and_fetch tool uses, through the real facilitator, under a spend cap of exactly one call.
// POST /plan/top-up costs 0.005 MUSD. The wallet pays itself, so its MUSD balance does not change; the facilitator sends the settlement transaction and pays its gas.
// The plan that comes back is only read: nothing here signs or sends it, so the trove, the Stability Pool deposit and veNFT 1729 are not touched.
// The settlement is checked through the RPC only (receipt, sender, the MUSD Transfer log); no explorer is asked about it.
// Writes evidence/w2/e-paid-plan-call.txt (transcript), evidence/w2/e-paid-plan-top-up.json (request, answer, settlement) and one line of evidence/w2/receipts.jsonl,
// which scripts/w2-prove.ts re-reads. One attempt, never retried; it refuses to run again once the ledger has the line.
// Usage: MEZO_KEY_FILE=<key file> npm run w2:paid   (the key is read inside the code and never printed)
import { decodePaymentRequiredHeader } from '@x402/core/http'
import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { formatUnits, isAddressEqual, parseAbi, parseEventLogs, type Address, type Hex } from 'viem'
import { erc20Abi } from '../src/abis.ts'
import { publicClient } from '../src/clients.ts'
import { ADDRESSES, CHAIN_ID, FACILITATOR_URL, NETWORK, RPC_URL } from '../src/config.ts'
import { opsAccount } from '../src/keys.ts'
import { createLens } from '../src/lens.ts'
import { createBuyer } from '../src/pay.ts'
import { createPlanner } from '../src/plan.ts'
import { appendReceipt, usedOn, type Receipt } from '../src/receipts.ts'
import { startServer } from '../src/serve.ts'
import { createSp } from '../src/sp-actions.ts'
import { SpendGuard } from '../src/spend.ts'
import { createReport } from './lib/report.ts'

const dir = fileURLToPath(new URL('../evidence/w2/', import.meta.url))
const LEDGER = dir + 'receipts.jsonl'
const OURS: Address = '0xea2D4b92DDd760959BB1D8119430640885851A91'
const PRICE = 5_000_000_000_000_000n // $0.005 as MUSD base units
const PATH = '/plan/top-up'
const BODY = { address: OURS, amountBtc: '0.0001' } // asks for a plan; nobody signs it
const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const r = createReport()
const same = (a?: string | null, b?: string | null) => !!a && !!b && isAddressEqual(a as Address, b as Address)
const firstLine = (t?: string) => (t ?? '').split('\n')[0]!.slice(0, 200)
const msg = (e: unknown) => String((e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : e)).slice(0, 200)
// The RPC is several nodes behind one URL and some answer "not found" for a transaction that exists, so ask again.
async function retry<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn() } catch (e) {
      if (i >= tries) throw e
      await new Promise((ok) => setTimeout(ok, 300))
    }
  }
}

if (existsSync(LEDGER) && readFileSync(LEDGER, 'utf8').includes('"x402_plan_top_up"')) {
  console.log('The ledger already has the x402_plan_top_up line: one paid call only, nothing was sent.')
  process.exit(2)
}

// What this process asks of each host, so the log can say how many RPC requests (Worker subrequests) the answer costs. Hosts only, never paths or bodies.
// It only counts and always passes the request on unchanged. It reads `.url` instead of testing `instanceof Request`: the Hono node server swaps the global
// Request class, so a clone made by the x402 client is not an instance of it (the first run of this script died on that test before any payment left the process).
const asked = new Map<string, number>()
const realFetch = globalThis.fetch
const hostOf = (input: unknown) => {
  try { return new URL(typeof input === 'object' && input !== null && 'url' in input ? String(input.url) : String(input)).host } catch { return '?' }
}
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = hostOf(input)
  asked.set(host, (asked.get(host) ?? 0) + 1)
  return realFetch(input, init)
}) as typeof fetch
const hostCount = (url: string) => asked.get(new URL(url).host) ?? 0

const pub = publicClient()
const account = opsAccount()
const lens = createLens(pub)
const planner = createPlanner(pub, lens)
const balance = () => pub.readContract({ address: ADDRESSES.musd, abi: erc20Abi, functionName: 'balanceOf', args: [OURS] }) as Promise<bigint>

r.log(`Wave 2: one real paid plan call (x402 on Mezo testnet)   ${new Date().toISOString()}`)
r.log(`wallet, buyer and payee: ${account.address}`)
const chainId = await pub.getChainId()
if (!r.check(chainId === CHAIN_ID && same(account.address, OURS), `eth_chainId is ${CHAIN_ID} and the key is the wallet ${OURS}`, [`chain ${chainId}`, `key address ${account.address}`])) process.exit(1)

// Free reads first: each planner on the real chain, and what it costs in RPC requests. The top-up is the call that gets paid for.
r.log('\n# Dry runs (reads only; nothing is signed)')
const sp = createSp(pub)
const dry: [string, () => Promise<unknown>][] = [
  [`POST ${PATH}`, () => planner.topUp(BODY)],
  ['POST /plan/repay', () => planner.repay({ address: OURS, amountMusd: '1' })],
  ['POST /plan/sp-deposit', () => sp.planDeposit({ address: OURS, amount: '1' })],
]
let toppable = false
for (const [name, run] of dry) {
  const before = hostCount(RPC_URL)
  const plan = (await run()) as { refused: boolean; reason?: string }
  r.log(`${name}: ${plan.refused ? `refused (${plan.reason?.slice(0, 100)})` : 'a plan'}; ${hostCount(RPC_URL) - before} RPC requests`)
  if (name === `POST ${PATH}`) toppable = !plan.refused
}
if (!r.check(toppable, `the top-up of ${BODY.amountBtc} BTC is a plan, not a refusal`)) process.exit(1)

// The real facilitator, with its answers noted for the log (never the payload or the signature).
const real = new HTTPFacilitatorClient({ url: FACILITATOR_URL })
const answers: string[] = []
const facilitator: FacilitatorClient = {
  async verify(p, q) {
    try {
      const v = await real.verify(p, q)
      answers.push(v.isValid ? 'verify: valid' : `verify: INVALID ${v.invalidReason}: ${firstLine(v.invalidMessage)}`)
      return v
    } catch (e) {
      answers.push(`verify: threw ${firstLine((e as Error).message)}`)
      throw e
    }
  },
  getSupported: () => real.getSupported(),
  async settle(p, q) {
    try {
      const s = await real.settle(p, q)
      answers.push(s.success ? 'settle: success' : `settle: FAILED ${s.errorReason}: ${firstLine(s.errorMessage)}`)
      return s
    } catch (e) {
      answers.push(`settle: threw ${firstLine((e as Error).message)}`)
      throw e
    }
  },
}
const srv = await startServer({ port: 0, payTo: OURS, facilitator })
const url = srv.url + PATH
const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

try {
  r.log(`\n# POST ${PATH} on a local server (payTo = the wallet), real facilitator ${new URL(FACILITATOR_URL).host}`)
  const startBlock = await pub.getBlockNumber()
  const [musdBefore, btcBefore] = [await balance(), await pub.getBalance({ address: OURS })]
  r.log(`before: block ${startBlock}, ${formatUnits(musdBefore, 18)} MUSD, ${formatUnits(btcBefore, 18)} BTC`)

  const unpaid = await post(BODY)
  const header = unpaid.headers.get('payment-required')
  const offer = header ? decodePaymentRequiredHeader(header).accepts[0] : undefined
  r.check(unpaid.status === 402 && !!offer && offer.amount === String(PRICE) && same(offer.asset, ADDRESSES.musd) && same(offer.payTo, OURS) && offer.network === NETWORK, `unpaid call answers 402 asking 0.005 MUSD to the wallet itself (got ${unpaid.status})`)
  const bad = await post({ address: '0x123', amountBtc: BODY.amountBtc })
  r.check(bad.status === 400 && !bad.headers.get('payment-required'), `bad input answers 400 with no challenge (got ${bad.status})`)

  const buyer = createBuyer({ account, chainReader: pub, guard: new SpendGuard({ perCall: PRICE, perSession: PRICE }) }) // room for exactly one call
  const at = new Date().toISOString()
  const [rpcBefore, facBefore] = [hostCount(RPC_URL), hostCount(FACILITATOR_URL)]
  const paid = await buyer.fetchPaid(url, BODY)
  r.log(`facilitator answered: ${answers.join(' | ') || 'nothing'}`)
  r.log(`the whole paid call made ${hostCount(RPC_URL) - rpcBefore} RPC requests (the buyer's reads, the plan, the settlement check) and ${hostCount(FACILITATOR_URL) - facBefore} facilitator requests`)
  r.check(paid.status === 200 && paid.paid && paid.authorizedMusd === '0.005', `paid call answers 200, carries a settlement and authorised 0.005 MUSD (got ${paid.status}, paid ${paid.paid}, authorised ${paid.authorizedMusd})`)
  if (paid.unsettled) r.log(`NOT SETTLED: ${paid.unsettled.reason}${paid.unsettled.detail ? ` (${paid.unsettled.detail})` : ''}; the payment may still have been taken`)
  if (paid.status !== 200 || !paid.json) r.log(`answer body: ${paid.body.slice(0, 300)}`)
  const status = (await (await fetch(srv.url + '/status')).json()) as { lastSettlement: { transaction: string; recovered: boolean } | null }
  if (!paid.settlement) r.log(`the server's /status lastSettlement: ${JSON.stringify(status.lastSettlement)}`) // if the payment did land, this may name it

  if (paid.settlement) {
    const answer = paid.json as Json
    r.log(`the plan: ${answer.refused ? 'refused' : 'a plan'} at block ${answer.blockNumber}: ${String(answer.summary).slice(0, 220)}`)
    // The same plan, asked again directly at the block the answer names, must be the same JSON (the gas estimate is taken at the latest block, so it is left out).
    const pinned = JSON.parse(JSON.stringify(await planner.topUp(BODY, { blockNumber: BigInt(answer.blockNumber) }))) as Json
    const { gas: servedGas, ...served } = answer
    const { gas: pinnedGas, ...direct } = pinned
    r.check(isDeepStrictEqual(served, direct), `the paid answer equals the planner's own answer at block ${answer.blockNumber} (gas ${servedGas} vs ${pinnedGas} left out)`)

    const hash = paid.settlement.transaction as Hex
    r.log(`settlement transaction ${hash}`)
    const [tx, rc] = await Promise.all([retry(() => pub.getTransaction({ hash })), retry(() => pub.getTransactionReceipt({ hash }))])
    // The ledger line and the evidence file are written as soon as the chain shows the transaction, whatever the checks below say.
    const line: Receipt & Record<string, unknown> = {
      at, name: 'x402_plan_top_up', from: tx.from, to: tx.to as Address, selector: tx.input.slice(0, 10) as Hex, nonce: tx.nonce, hash, status: rc.status,
      musd: String(PRICE), btc: '0', gas: String(tx.gas), maxFeePerGas: String(tx.maxFeePerGas ?? tx.gasPrice ?? 0n),
      note: 'x402: the wallet paid its own server 0.005 MUSD for one POST /plan/top-up answer; the facilitator sent this transaction and paid its gas',
      buyer: OURS, payTo: OURS, route: `POST ${PATH}`, block: Number(rc.blockNumber), plan: 'e-paid-plan-top-up.json',
    }
    appendReceipt(LEDGER, line)
    writeFileSync(dir + 'e-paid-plan-top-up.json', JSON.stringify({
      route: `POST ${PATH}`, price: '$0.005', paidMusd: '0.005', request: BODY, answer,
      settlement: { transaction: hash, network: paid.settlement.network, payer: paid.settlement.payer, block: String(rc.blockNumber), status: rc.status, sentBy: tx.from, to: tx.to, nonce: tx.nonce },
    }, null, 2) + '\n')
    const used = usedOn(LEDGER, at.slice(0, 10)) // throws if any ledger line cannot be read
    r.log(`ledger line appended; the ledger still reads (${formatUnits(used.musd, 18)} MUSD and ${formatUnits(used.btc, 18)} BTC counted on ${at.slice(0, 10)})`)

    r.check(rc.status === 'success', `the settlement receipt says ${rc.status}, block ${rc.blockNumber}, gas used ${rc.gasUsed}`)
    r.check(rc.blockNumber > startBlock, `it was mined after this run began (block ${rc.blockNumber} > ${startBlock})`)
    r.check(!same(tx.from, OURS), `the transaction was sent by ${tx.from}, not by the wallet: the facilitator paid the gas`)
    const moves = parseEventLogs({ abi: transferAbi, eventName: 'Transfer', logs: rc.logs }).filter((l) => same(l.address, ADDRESSES.musd))
    const ours = moves.filter((l) => same(l.args.from, OURS) && same(l.args.to, OURS) && l.args.value === PRICE)
    r.check(ours.length === 1, `its receipt holds ${moves.length} MUSD Transfer log(s), exactly one of them wallet -> wallet of ${formatUnits(PRICE, 18)} MUSD (found ${ours.length})`)
    const [musdAfter, btcAfter] = [await balance(), await pub.getBalance({ address: OURS })]
    r.check(musdAfter === musdBefore && btcAfter === btcBefore, `net cost zero: ${formatUnits(musdAfter, 18)} MUSD and ${formatUnits(btcAfter, 18)} BTC after (before: ${formatUnits(musdBefore, 18)} and ${formatUnits(btcBefore, 18)})`)
    r.check(status.lastSettlement?.transaction.toLowerCase() === hash.toLowerCase(), `the server's /status names the same settlement (recovered from the chain: ${status.lastSettlement?.recovered})`)
  }
} catch (e) {
  r.check(false, 'the run finished without an exception', [msg(e)])
} finally {
  await srv.close()
  r.save(dir + 'e-paid-plan-call.txt')
}
process.exitCode = r.failures() ? 1 : 0
