// Live smoke test on Mezo testnet. Read-only: no key, nothing is paid, nothing is deployed.
//   1. the deployed lens has code;
//   2. at one pinned block, the lens (and its paged walk of the redemption queue) gives the same numbers as reading TroveManager, SortedTroves,
//      PriceFeed, HintHelpers, the DEX router and veBTC/veMEZO directly, and the text shown to people is the exact value cut off, not rounded;
//   3. the paid endpoint, started locally with the real facilitator client, answers an unpaid call with a proper x402 challenge for MUSD;
//   4. the README matches the chain: every address in its integration table has code and is one the toolkit uses, and every transaction it links succeeded.
// Exit code is non-zero if any check fails. `--log` also writes evidence/smoke.log.
import { decodePaymentRequiredHeader } from '@x402/core/http'
import { HTTPFacilitatorClient } from '@x402/core/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseUnits, type Address } from 'viem'
import deployment from '../deployments/testnet.json' with { type: 'json' }
import { publicClient } from '../src/clients.ts'
import { ADDRESSES, CHAIN_ID, FACILITATOR_URL, NETWORK } from '../src/config.ts'
import { createLens } from '../src/lens.ts'
import { startServer } from '../src/serve.ts'
import { differences, directPool, directQueue, directSystem, directTrove, directVe, lockDifferences, systemDifferences, troveFromTail } from './lib/direct.ts'
import { explorerGet } from './lib/explorer.ts'
import { discoverLiveLock, discoverVeHolder } from './lib/holders.ts'
import { createReport } from './lib/report.ts'

const { log, check, verdict, failures, save } = createReport()

const pub = publicClient()
const lens = createLens(pub)
log(`smoke test, Mezo testnet (chain ${CHAIN_ID}), read-only, no key   ${new Date().toISOString()}`)

// ---- 1. the deployed lens ---------------------------------------------------------------------------------------------------------------------
check((await pub.getChainId()) === CHAIN_ID, `the RPC is chain ${CHAIN_ID}`)
const code = await pub.getCode({ address: lens.address })
check(!!code && code !== '0x', `eth_getCode(${lens.address}) is not empty`)
check(code?.length === 2 + 2 * deployment.MezoLens.deployedCodeBytes, `the lens code is ${deployment.MezoLens.deployedCodeBytes} bytes, as recorded when it was deployed`)

// ---- 2. lens against direct reads, all at one block -----------------------------------------------------------------------------------------
const B = (await pub.getBlockNumber()) - 2n
const stamp = (await pub.getBlock({ blockNumber: B })).timestamp
log('')
log(`pinned block ${B} (${new Date(Number(stamp) * 1000).toISOString()}): each number is read once through the lens and once straight from the protocol contracts`)

const tail = await troveFromTail(pub, 0, B)
const fifth = await troveFromTail(pub, 4, B)
for (const [name, borrower] of [['tail trove', tail], ['fifth trove from the tail', fifth]] as const) {
  const got = await lens.troveHealth(borrower, { blockNumber: B })
  const want = await directTrove(pub, borrower, B)
  verdict(`trove_health, ${name} ${borrower}: ${Object.keys(want.raw).length} raw integers and ${want.shown.length} shown amounts equal the direct reads`, [
    ...(got.blockNumber === Number(B) ? [] : [`the answer names block ${got.blockNumber}, not ${B}`]),
    ...differences('answer', got, want),
  ])
  log(`    ${got.summary}`)
}

const wantSystem = await directSystem(pub, B)
const system = await lens.systemSnapshot({ blockNumber: B })
verdict(`system_snapshot: ${Object.keys(wantSystem.raw).length} raw values equal the direct reads, and the first redeemable trove equals the HintHelpers answer (${wantSystem.fields.firstRedeemableTrove})`, differences('answer', system, wantSystem))

const wantQueue = await directQueue(pub, fifth, B)
const single = await lens.redemptionRisk(fifth, { blockNumber: B })
verdict(`redemption_risk, one call, for ${fifth}: ${single.redeemableTrovesAhead} redeemable troves and ${single.redeemableMusdAhead} MUSD ahead equal a node-by-node walk from the tail`, [
  ...differences('answer', single, wantQueue),
  ...systemDifferences('system', single.system, wantSystem),
])
const pages = Math.ceil(Number(wantQueue.fields.stepsWalked) / 2)
const paged = await lens.redemptionRisk(fifth, { blockNumber: B, pageSteps: 2 })
verdict(`redemption_risk, paged two nodes per call (${pages} calls): same result as the direct walk, and the same system part`, [...differences('answer', paged, wantQueue), ...systemDifferences('system', paged.system, wantSystem)])
const wantCapped = await directQueue(pub, fifth, B, 2)
const capped = await lens.redemptionRisk(fifth, { blockNumber: B, pageSteps: 2, maxSteps: 2 })
verdict('redemption_risk, stopped by the step cap: walkComplete is false and the counters equal a direct 2-node walk', [...differences('answer', capped, wantCapped), ...(capped.walkComplete ? ['walkComplete should be false'] : [])])

const poolCases: { tokenIn: string; tokenOut: string; amountIn: string; from: Address; to: Address }[] = [
  { tokenIn: 'BTC', tokenOut: 'MUSD', amountIn: '0.001', from: ADDRESSES.btc, to: ADDRESSES.musd },
  { tokenIn: 'MUSD', tokenOut: 'BTC', amountIn: '100', from: ADDRESSES.musd, to: ADDRESSES.btc },
  // A trade that is a few percent of the pool, so the price impact is not zero (these are quotes: nothing is traded).
  { tokenIn: 'BTC', tokenOut: 'MUSD', amountIn: '100', from: ADDRESSES.btc, to: ADDRESSES.musd },
]
for (const c of poolCases) {
  const got = await lens.poolQuote({ tokenIn: c.tokenIn, tokenOut: c.tokenOut, amountIn: c.amountIn }, { blockNumber: B })
  const want = await directPool(pub, c.from, c.to, parseUnits(c.amountIn, 18), false, B)
  verdict(`pool_quote ${c.amountIn} ${c.tokenIn} -> ${got.amountOut} ${c.tokenOut} (impact ${got.priceImpactPercent}%): equals the router's own getAmountsOut and reserves`, differences('answer', got, want))
}

const live = await discoverLiveLock(pub, B)
const holder = live?.owner ?? (await discoverVeHolder())
if (!live) log('WARNING  no lock that is still running was found, so secondsLeft is only checked for expired locks')
if (!holder) {
  check(false, 've_locks: no veBTC holder found to read')
} else {
  const want = await directVe(pub, holder, B)
  const got = await lens.veLocks(holder, { blockNumber: B })
  verdict(`ve_locks for ${holder}: ${want.locks.length} of ${got.veBtcCount} veBTC + ${got.veMezoCount} veMEZO locks equal the direct reads (unlock time, seconds left, voting power, voted)`, lockDifferences(got, want))
  if (live) check(got.locks.some((l) => l.secondsLeft > 0 && !l.expired), `ve_locks reports a running lock (${live.escrow} #${live.tokenId}, ${got.locks.find((l) => l.secondsLeft > 0)?.secondsLeft ?? 0} seconds left at the pinned block)`)
}

// ---- 3. the paid endpoint answers an unpaid call with an x402 challenge ----------------------------------------------------------------------
log('')
const srv = await startServer({ port: 0, facilitator: new HTTPFacilitatorClient({ url: FACILITATOR_URL }) })
try {
  const free = await fetch(srv.url + '/health')
  check(free.status === 200, `GET /health answers 200 without payment (got ${free.status})`)
  for (const path of [`/v1/trove/${tail}`, `/v1/redemption/${fifth}`, '/v1/pool/quote?tokenIn=BTC&tokenOut=MUSD&amountIn=0.001']) {
    const res = await fetch(srv.url + path)
    const header = res.headers.get('payment-required')
    const a = header ? decodePaymentRequiredHeader(header).accepts[0] : undefined
    verdict(`unpaid GET ${path.split('?')[0]!.replace(/0x[0-9a-fA-F]{40}/, ':address')} answers 402 with a challenge for 0.001 MUSD to the payee on ${NETWORK}`, [
      ...(res.status === 402 ? [] : [`status ${res.status}`]),
      ...(a ? [] : ['no PAYMENT-REQUIRED header']),
      ...(a && (a.scheme !== 'exact' || a.network !== NETWORK || a.amount !== '1000000000000000' || a.asset.toLowerCase() !== ADDRESSES.musd.toLowerCase() || a.payTo.toLowerCase() !== srv.payTo.toLowerCase())
        ? [`unexpected challenge: ${a.scheme} ${a.network} ${a.amount} ${a.asset} -> ${a.payTo}`]
        : []),
    ])
  }
} finally {
  await srv.close()
}

// ---- 4. the README matches the chain --------------------------------------------------------------------------------------------------------
log('')
const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')
const table = readme.slice(readme.indexOf('## Mezo integration'), readme.indexOf('### Transactions'))
const listed = [...new Set(table.match(/0x[0-9a-fA-F]{40}\b/g) ?? [])]
const known = new Set([...Object.values(ADDRESSES), lens.address].map((a) => a.toLowerCase()))
check(listed.length >= 10, `the README integration table lists ${listed.length} addresses (at least 10 expected)`)
verdict('every address in the README table is one the toolkit uses (src/config.ts or the lens)', listed.filter((a) => !known.has(a.toLowerCase())).map((a) => `${a} is in the README but not in the code`))
const empty: string[] = []
for (const a of listed) {
  const c = await pub.getCode({ address: a as Address })
  if (!c || c === '0x') empty.push(`${a} has no code on chain`)
}
verdict(`every address in the README table has code on chain (${listed.length} checked)`, empty)
const hashes = [...new Set([...readme.matchAll(/\/tx\/(0x[0-9a-fA-F]{64})/g)].map((m) => m[1]!))]
const failed: string[] = []
for (const h of hashes) {
  const t = await explorerGet(`transactions/${h}`, (j) => !!j?.status, 3, 3000)
  if (t?.status !== 'ok') failed.push(`${h}: explorer status is ${t?.status}`)
}
check(hashes.length >= 10, `the README links ${hashes.length} transactions (at least 10 expected)`)
verdict(`every transaction the README links succeeded on chain (${hashes.length} checked on the explorer)`, failed)

log('')
log(failures() === 0 ? 'SMOKE PASSED' : `SMOKE FAILED (${failures()} failed check(s))`)
if (process.argv.includes('--log')) save(fileURLToPath(new URL('../evidence/smoke.log', import.meta.url)))
process.exit(failures() === 0 ? 0 : 1)
