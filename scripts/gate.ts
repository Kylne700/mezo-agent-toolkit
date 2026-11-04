// The x402 gate, run against the real app and the real facilitator on Mezo testnet.
// For each paid endpoint: an unpaid GET must return 402 with a payment challenge, then a paid GET (through the same buyer code the MCP tool uses,
// under its spend limits) must return 200 with live chain data and a settlement transaction whose receipt the Mezo testnet RPC gives (no explorer lookup).
// Writes the transcript to evidence/gate-402-then-200.log. Costs 0.001 MUSD per paid call (four calls). Exit code is non-zero if any check fails.
import { decodePaymentRequiredHeader } from '@x402/core/http'
import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server'
import { fileURLToPath } from 'node:url'
import type { Address } from 'viem'
import { erc20Abi, sortedTrovesAbi, troveManagerAbi } from '../src/abis.ts'
import { publicClient } from '../src/clients.ts'
import { ADDRESSES, EXPLORER, FACILITATOR_URL, NETWORK, txUrl } from '../src/config.ts'
import { opsAccount } from '../src/keys.ts'
import { createBuyer } from '../src/pay.ts'
import { startServer } from '../src/serve.ts'
import { SpendGuard } from '../src/spend.ts'
import { discoverVeHolder } from './lib/holders.ts'
import { settlementProblems } from './lib/receipts.ts'
import { createReport } from './lib/report.ts'
import { fixed } from '../src/lens.ts'

const OUT = fileURLToPath(new URL('../evidence/gate-402-then-200.log', import.meta.url))
const { log, check, verdict, failures, save } = createReport()

const pub = publicClient()
const balance = (a: Address) => pub.readContract({ address: ADDRESSES.musd, abi: erc20Abi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>

const account = opsAccount()
const guard = SpendGuard.fromEnv()
const buyer = createBuyer({ account, chainReader: pub, guard })
// The real facilitator, with its /settle answers noted for the log: the public testnet RPC sometimes makes it report a failure for a transfer that landed.
const realFacilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL })
const facilitatorAnswers: string[] = []
const firstLine = (t?: string) => (t ?? '').split('\n')[0]!.slice(0, 120)
const facilitator: FacilitatorClient = {
  verify: (p, r) => realFacilitator.verify(p, r),
  getSupported: () => realFacilitator.getSupported(),
  async settle(p, r) {
    try {
      const res = await realFacilitator.settle(p, r)
      facilitatorAnswers.push(res.success ? `success, transaction ${res.transaction}` : `FAILED ${res.errorReason}: ${firstLine(res.errorMessage)}`)
      return res
    } catch (e) {
      facilitatorAnswers.push(`threw: ${firstLine((e as Error).message)}`)
      throw e
    }
  },
}
const srv = await startServer({ port: 0, facilitator })
const startBlock = await pub.getBlockNumber()
const buyerBefore = await balance(account.address)
const payeeBefore = await balance(srv.payTo)
const buyerSent = async () => ({ btc: await pub.getBalance({ address: account.address }), nonce: await pub.getTransactionCount({ address: account.address }) })
const sentBefore = await buyerSent()

log(`x402 gate, real app + real facilitator   ${new Date().toISOString()}`)
log(`network ${NETWORK}   app ${srv.url}   lens ${srv.lens.address}`)
log(`buyer ${account.address}   payee ${srv.payTo}`)
log(`spend limits: ${guard.snapshot().perCallMusd} MUSD per call, ${guard.snapshot().perSessionMusd} MUSD per session`)
log(`MUSD before   buyer ${fixed(buyerBefore, 18, 6)}   payee ${fixed(payeeBefore, 18, 6)}`)

const trove = (await pub.readContract({ address: ADDRESSES.sortedTroves, abi: sortedTrovesAbi, functionName: 'getLast' })) as Address
const holder = (await discoverVeHolder()) ?? account.address
const targets: { name: string; path: string; show: (j: any) => string }[] = [
  { name: 'trove', path: `/v1/trove/${trove}`, show: (j) => `status ${j.status}, debt ${j.debtMusd} MUSD, icr ${j.icrPercent}%, block ${j.blockNumber}` },
  { name: 'redemption', path: `/v1/redemption/${trove}`, show: (j) => `listed ${j.listed}, found ${j.found}, ${j.redeemableTrovesAhead} redeemable troves ahead, block ${j.blockNumber}` },
  { name: 'pool', path: '/v1/pool/quote?tokenIn=BTC&tokenOut=MUSD&amountIn=0.001', show: (j) => `${j.amountIn} BTC -> ${j.amountOut} MUSD, pool ${j.pool}, block ${j.blockNumber}` },
  { name: 've', path: `/v1/ve/${holder}`, show: (j) => `${j.veBtcCount} veBTC + ${j.veMezoCount} veMEZO locks for ${j.owner}, block ${j.blockNumber}` },
]

const settlements: string[] = []
let troveJson: any
for (const t of targets) {
  log('')
  log(`== ${t.name}   GET ${t.path}`)
  const unpaid = await fetch(srv.url + t.path)
  const header = unpaid.headers.get('payment-required')
  check(unpaid.status === 402 && !!header, `unpaid call answers 402 with a PAYMENT-REQUIRED challenge (got ${unpaid.status})`)
  if (header) {
    const pr = decodePaymentRequiredHeader(header)
    const a = pr.accepts[0]!
    log(`  challenge: x402 v${pr.x402Version}, ${a.scheme} on ${a.network}, pay ${a.amount} base units (${fixed(BigInt(a.amount), 18, 6)} MUSD) of ${a.asset} to ${a.payTo}`)
    log(`  extensions offered: ${Object.keys(pr.extensions ?? {}).join(', ') || 'none'}`)
  }
  const paid = await buyer.fetchPaid(srv.url + t.path)
  check(paid.status === 200 && paid.paid, `paid call answers 200 and carries a settlement (got ${paid.status}, paid ${paid.paid})`)
  const lastSettlement = ((await (await fetch(srv.url + '/status')).json()) as { lastSettlement: { recovered: boolean } | null }).lastSettlement
  log(`  facilitator /settle answered: ${facilitatorAnswers.at(-1) ?? 'nothing'}`)
  log(`  the server confirmed the payment ${paid.settlement ? (lastSettlement?.recovered ? 'itself, from the chain (transfer found in a transaction carrying this payment signature)' : "from the facilitator's answer") : 'not at all'}`)
  if (paid.settlement) {
    settlements.push(paid.settlement.transaction)
    log(`  SETTLE: ${paid.settlement.transaction}   payer ${paid.settlement.payer}`)
    log(`  explorer: ${paid.settlement.explorer}`)
  }
  if (paid.unsettled) log(`  NOT SETTLED: ${paid.unsettled.reason}${paid.unsettled.detail ? ` (${paid.unsettled.detail})` : ''}; the payment may still have been taken`)
  if (paid.json) log(`  data: ${t.show(paid.json)}`)
  if (t.name === 'trove') troveJson = paid.json
}

// The data really came from the chain: read the same trove directly at the block the answer names.
if (troveJson) {
  const block = BigInt(troveJson.blockNumber)
  const direct = (await pub.readContract({ address: ADDRESSES.troveManager, abi: troveManagerAbi, functionName: 'getEntireDebtAndColl', args: [trove], blockNumber: block })) as readonly bigint[]
  log('')
  check(direct[0]!.toString() === troveJson.raw.coll && (direct[1]! + direct[2]!).toString() === troveJson.raw.debt, `trove numbers equal a direct TroveManager read at block ${block}`)
}

// The RPC gives each settlement's receipt: it succeeded, it is new (mined after this run began), it was sent by the facilitator and not by the buyer
// (the buyer needs no BTC for gas), and its logs include exactly this payment: a Transfer of 0.001 MUSD from the buyer to the payee.
log('')
check(new Set(settlements.map((h) => h.toLowerCase())).size === settlements.length, `the ${settlements.length} settlement hashes are all different`)
for (const hash of settlements) {
  const s = await settlementProblems(pub, hash, { buyer: account.address, payee: srv.payTo, amount: 1_000_000_000_000_000n, afterBlock: startBlock })
  verdict(`receipt: ${hash} succeeded in block ${s.block} (run began at ${startBlock}), sent by ${s.sender} (not the buyer), moved exactly 0.001 MUSD from the buyer to the payee`, s.problems)
}

const buyerAfter = await balance(account.address)
const payeeAfter = await balance(srv.payTo)
log('')
log(`MUSD after    buyer ${fixed(buyerAfter, 18, 6)}   payee ${fixed(payeeAfter, 18, 6)}`)
check(buyerBefore - buyerAfter === payeeAfter - payeeBefore && payeeAfter - payeeBefore === 1_000_000_000_000_000n * BigInt(settlements.length), `buyer paid exactly ${settlements.length} x 0.001 MUSD and the payee received it`)
const sentAfter = await buyerSent()
check(sentBefore.btc === sentAfter.btc && sentBefore.nonce === sentAfter.nonce, `the buyer sent no transaction and spent no BTC (nonce ${sentBefore.nonce} before and after): the facilitator paid the gas`)
log(`spend after: ${JSON.stringify(guard.snapshot())}`)
const status = (await (await fetch(srv.url + '/status')).json()) as { recoveredSettlements?: number }
log(`settlements the server recovered after the facilitator reported a failure (transfer found on chain): ${status.recoveredSettlements ?? 0}`)
log(`explorer base ${EXPLORER}   first settlement ${settlements[0] ? txUrl(settlements[0]) : 'none'}`)
log(failures() === 0 ? 'GATE PASSED' : `GATE FAILED (${failures()} failed check(s))`)

await srv.close()
save(OUT)
process.exit(failures() === 0 ? 0 : 1)
