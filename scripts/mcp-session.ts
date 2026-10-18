// A live MCP session on Mezo testnet, driven the way an agent host drives a server: the real stdio server (src/mcp.ts) is started as a child process,
// every tool is listed and called, and pay_and_fetch really pays MUSD on chain through the x402 facilitator, under hard limits set in the child's environment.
//   - the four read tools are checked against direct reads of the protocol contracts at the block each answer names;
//   - pay_and_fetch pays twice (0.001 MUSD each), is refused when a price is over the per-call limit, is refused when a third payment would go over the
//     session limit, refuses a host that is not on the allow list and a bad URL, and fetches a free URL without paying;
//   - the explorer and the MUSD balances confirm exactly what was paid, and that the buyer sent no transaction of its own (the facilitator pays the gas).
// Costs 0.002 MUSD. Writes evidence/mcp-session.log; exit code is non-zero if any check fails. The key path, the child's environment and its stderr are never logged.
// Usage: tsx scripts/mcp-session.ts [--note "text added to the log header"]
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseUnits, type Address } from 'viem'
import { erc20Abi, troveManagerAbi } from '../src/abis.ts'
import { publicClient } from '../src/clients.ts'
import { ADDRESSES, FACILITATOR_URL, NETWORK, txUrl } from '../src/config.ts'
import { keyPaths, opsAccount, readKeyFile } from '../src/keys.ts'
import { createLens } from '../src/lens.ts'
import { startServer } from '../src/serve.ts'
import { differences, directPool, directQueue, directSystem, directTrove, directVe, lockDifferences, systemDifferences, troveFromTail } from './lib/direct.ts'
import { settlementProblems } from './lib/explorer.ts'
import { discoverLiveLock, discoverVeHolder } from './lib/holders.ts'
import { createReport } from './lib/report.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = fileURLToPath(new URL('../evidence/mcp-session.log', import.meta.url))
const PER_CALL = '0.002'
const PER_SESSION = '0.002'
const PRICE = 1_000_000_000_000_000n // $0.001 in MUSD base units (18 decimals)
const TOOLS = ['pay_and_fetch', 'pool_quote', 'redemption_risk', 'trove_health', 've_locks']

const { log, check, verdict, failures, save } = createReport()
const note = process.argv.includes('--note') ? process.argv[process.argv.indexOf('--note') + 1] : undefined
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const pub = publicClient()
const lens = createLens(pub)
const account = opsAccount() // only its public address is used here; the child loads the key itself, from the file path in its environment
const balance = (a: Address) => pub.readContract({ address: ADDRESSES.musd, abi: erc20Abi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>

/** The real facilitator, with its answers counted and noted: the public testnet RPC sometimes makes it report a failure for a transfer that landed. */
function watched() {
  const real = new HTTPFacilitatorClient({ url: FACILITATOR_URL })
  const seen = { verify: 0, settle: 0, answers: [] as string[] }
  const first = (t?: string) => (t ?? '').split('\n')[0]!.slice(0, 100)
  const client: FacilitatorClient = {
    verify: (p, r) => {
      seen.verify++
      return real.verify(p, r)
    },
    getSupported: () => real.getSupported(),
    async settle(p, r) {
      seen.settle++
      try {
        const res = await real.settle(p, r)
        seen.answers.push(res.success ? 'success' : `FAILED ${res.errorReason}: ${first(res.errorMessage)}`)
        return res
      } catch (e) {
        seen.answers.push(`threw: ${first((e as Error).message)}`)
        throw e
      }
    },
  }
  return { client, seen }
}

const cheapFacilitator = watched()
const priceyFacilitator = watched()
const cheap = await startServer({ port: 0, facilitator: cheapFacilitator.client, price: '$0.001' })
const pricey = await startServer({ port: 0, facilitator: priceyFacilitator.client, price: '$0.05' })

// The server under test: a child process with a clean environment plus exactly the settings an operator would give it.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', 'src/mcp.ts'],
  cwd: ROOT,
  env: { ...getDefaultEnvironment(), MEZO_KEY_FILE: keyPaths().ops, MEZO_MAX_PER_CALL_MUSD: PER_CALL, MEZO_MAX_PER_SESSION_MUSD: PER_SESSION, MEZO_PAY_ALLOWED_HOSTS: '127.0.0.1' },
  stderr: 'pipe',
})
let stderr = ''
let said = '' // every answer the server gave, searched for secrets at the end
transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
const client = new Client({ name: 'mezo-session-script', version: '0.0.0' })

interface Called {
  isError: boolean
  text: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
}
async function call(name: string, args: Record<string, unknown>): Promise<Called> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 150_000 })) as { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: unknown }
  said += JSON.stringify(r)
  return { isError: r.isError === true, text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), data: r.structuredContent ?? {} }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const startBlock = await pub.getBlockNumber()
const before = { buyer: await balance(account.address), payee: await balance(cheap.payTo), btc: await pub.getBalance({ address: account.address }), nonce: await pub.getTransactionCount({ address: account.address }) }
let childPid: number | null = null
const settlements: string[] = []
const watchdog = setTimeout(() => {
  console.error('overall time limit reached; stopping')
  if (childPid) process.kill(childPid)
  process.exit(2)
}, 900_000)
watchdog.unref()

try {
  log(`MCP session, real stdio server, real payments on Mezo testnet   ${new Date().toISOString()}`)
  if (note) log(`note: ${note}`)
  log(`network ${NETWORK}   lens ${lens.address}`)
  log(`buyer ${account.address}   payee ${cheap.payTo}`)
  log(`the server's limits, set in its environment and not changeable by a tool call: ${PER_CALL} MUSD per call, ${PER_SESSION} MUSD per session; it may only call host 127.0.0.1`)
  log(`two local paid endpoints, both using the real facilitator: ${cheap.url} (price $0.001) and ${pricey.url} (price $0.05)`)
  log(`MUSD before   buyer ${before.buyer}   payee ${before.payee}  (base units)`)

  await client.connect(transport)
  childPid = transport.pid

  // ---- the server and its tools ---------------------------------------------------------------------------------------------------------------
  log('')
  log('== the server')
  for (let i = 0; i < 60 && !stderr.includes('"mcp-ready"'); i++) await sleep(100)
  const ready = JSON.parse(stderr.split('\n').find((l) => l.includes('"mcp-ready"')) ?? '{}') as { payments?: { buyer?: string; limits?: { perCallMusd?: string; perSessionMusd?: string } } }
  check(ready.payments?.buyer?.toLowerCase() === account.address.toLowerCase() && ready.payments?.limits?.perCallMusd === PER_CALL && ready.payments?.limits?.perSessionMusd === PER_SESSION, 'the server started with payments on: its buyer is the funded wallet and its limits are the ones set')
  const { tools } = await client.listTools()
  said += JSON.stringify(tools)
  check(same(tools.map((t) => t.name).sort(), TOOLS), `tools/list returns exactly the five tools: ${tools.map((t) => t.name).sort().join(', ')}`)
  for (const t of tools) log(`    ${t.name.padEnd(16)} readOnlyHint=${t.annotations?.readOnlyHint}  destructiveHint=${t.annotations?.destructiveHint}  openWorldHint=${t.annotations?.openWorldHint}`)
  const payTool = tools.find((t) => t.name === 'pay_and_fetch')
  const props = Object.keys((payTool?.inputSchema as { properties?: object } | undefined)?.properties ?? {})
  check(same(props, ['url']), `pay_and_fetch takes only a url, so no tool call can change a limit (arguments: ${props.join(', ')})`)
  check(payTool?.description?.includes(`at most ${PER_CALL} MUSD per call and ${PER_SESSION} MUSD in total for this session`) === true, 'the pay_and_fetch description tells the agent the operator limits')

  // ---- the four read tools, against direct reads at the block each answer names -----------------------------------------------------------------
  log('')
  log('== read tools (free, read through the MezoLens contract)')
  const pinned = (await pub.getBlockNumber()) - 2n
  const tail = await troveFromTail(pub, 0, pinned)
  const fifth = await troveFromTail(pub, 4, pinned)
  const live = await discoverLiveLock(pub, pinned)
  const holder = live?.owner ?? (await discoverVeHolder())
  if (!live) log('WARNING  no lock that is still running was found, so secondsLeft is only checked for expired locks')

  const trove = await call('trove_health', { address: tail })
  const troveAt = BigInt(trove.data.blockNumber ?? 0)
  verdict(`trove_health ${tail} at block ${troveAt}: raw integers and shown amounts equal the direct reads`, [
    ...(trove.isError ? [`tool error: ${trove.text.slice(0, 200)}`] : []),
    ...(same(JSON.parse(trove.text || 'null'), trove.data) ? [] : ['the text and structuredContent of the answer differ']),
    ...(trove.isError ? [] : differences('answer', trove.data, await directTrove(pub, tail, troveAt))),
  ])
  log(`    ${trove.data.summary}`)

  const nobody = await call('trove_health', { address: cheap.payTo })
  const nobodyAt = BigInt(nobody.data.blockNumber ?? 0)
  const nobodyStatus = nobody.isError ? -1 : Number(await pub.readContract({ address: ADDRESSES.troveManager, abi: troveManagerAbi, functionName: 'getTroveStatus', args: [cheap.payTo], blockNumber: nobodyAt }))
  check(!nobody.isError && nobody.data.active === false && nobody.data.status === 'nonExistent' && nobodyStatus === 0, 'trove_health for an address without a trove: active false, status nonExistent (and TroveManager agrees)')

  const risk = await call('redemption_risk', { address: fifth })
  const riskAt = BigInt(risk.data.blockNumber ?? 0)
  verdict(`redemption_risk ${fifth} at block ${riskAt}: ${risk.data.redeemableTrovesAhead} redeemable troves and ${risk.data.redeemableMusdAhead} MUSD ahead equal a node-by-node walk from the tail`, [
    ...(risk.isError ? [`tool error: ${risk.text.slice(0, 200)}`] : []),
    ...(risk.isError ? [] : [...differences('answer', risk.data, await directQueue(pub, fifth, riskAt)), ...systemDifferences('system', risk.data.system, await directSystem(pub, riskAt))]),
  ])

  for (const c of [
    { amountIn: '0.001', note: 'a small trade' },
    { amountIn: '100', note: 'a trade of a few percent of the pool, so the price impact is not zero' },
  ]) {
    const quote = await call('pool_quote', { tokenIn: 'BTC', tokenOut: 'MUSD', amountIn: c.amountIn })
    const at = BigInt(quote.data.blockNumber ?? 0)
    verdict(`pool_quote ${c.amountIn} BTC -> ${quote.data.amountOut} MUSD (impact ${quote.data.priceImpactPercent}%, ${c.note}) at block ${at}: equals the router's own numbers`, [
      ...(quote.isError ? [`tool error: ${quote.text.slice(0, 200)}`] : []),
      ...(quote.isError ? [] : differences('answer', quote.data, await directPool(pub, ADDRESSES.btc, ADDRESSES.musd, parseUnits(c.amountIn, 18), false, at))),
    ])
  }

  if (!holder) {
    check(false, 've_locks: no holder found to read')
  } else {
    const ve = await call('ve_locks', { address: holder })
    const at = BigInt(ve.data.blockNumber ?? 0)
    verdict(`ve_locks ${holder} at block ${at}: ${ve.data.returned} locks equal the direct reads (unlock time, seconds left, voting power, voted)`, [
      ...(ve.isError ? [`tool error: ${ve.text.slice(0, 200)}`] : []),
      ...(ve.isError ? [] : lockDifferences(ve.data, await directVe(pub, holder, at))),
    ])
    if (live) check(((ve.data.locks ?? []) as { secondsLeft: number; expired: boolean }[]).some((l) => l.secondsLeft > 0 && !l.expired), 've_locks reports a lock that is still running (secondsLeft above zero)')
  }

  const bad = await call('trove_health', { address: '0x123' })
  check(bad.isError && /address/i.test(bad.text), `a bad address is a tool error the agent can read, not a crash: "${bad.text.slice(0, 80)}"`)

  // ---- pay_and_fetch --------------------------------------------------------------------------------------------------------------------------
  log('')
  log('== pay_and_fetch (the only tool that spends)')
  const statusOf = async () => ((await (await fetch(cheap.url + '/status')).json()) as { lastSettlement: { recovered: boolean } | null }).lastSettlement

  const free = await call('pay_and_fetch', { url: cheap.url + '/health' })
  verdict('a free URL is just fetched: status 200, paid false, nothing authorised, nothing spent', [
    ...(free.data.status === 200 && free.data.paid === false && free.data.authorizedMusd === null && free.data.spend?.spentMusd === '0' ? [] : [`unexpected answer: ${JSON.stringify({ status: free.data.status, paid: free.data.paid, authorizedMusd: free.data.authorizedMusd, spend: free.data.spend })}`]),
    ...(free.isError ? [`tool error: ${free.text.slice(0, 200)}`] : []),
  ])

  const paidCall = async (n: number, what: string, url: string, verify: (json: any) => Promise<string[]>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await call('pay_and_fetch', { url })
    verdict(`payment ${n}, ${what}: status 200, paid, 0.001 MUSD authorised, settlement transaction returned`, [
      ...(r.isError ? [`tool error: ${r.text.slice(0, 240)}`] : []),
      ...(r.data.status === 200 && r.data.paid === true && r.data.authorizedMusd === '0.001' && r.data.settlement?.transaction ? [] : [`unexpected answer: ${JSON.stringify({ status: r.data.status, paid: r.data.paid, authorizedMusd: r.data.authorizedMusd, unsettled: r.data.unsettled })}`]),
      ...(String(r.data.settlement?.payer).toLowerCase() === account.address.toLowerCase() ? [] : [`the payer is ${r.data.settlement?.payer}, not the buyer`]),
    ])
    log(`    facilitator /settle answered: ${(url.startsWith(cheap.url) ? cheapFacilitator : priceyFacilitator).seen.answers.at(-1) ?? 'nothing'}`)
    if (r.data.settlement?.transaction) {
      const recovered = (await statusOf())?.recovered
      log(`    the server confirmed the payment ${recovered ? 'itself, from the chain (transfer found in a transaction carrying this payment signature)' : "from the facilitator's answer"}`)
      log(`    SETTLE: ${r.data.settlement.transaction}   payer ${r.data.settlement.payer}`)
      log(`    explorer: ${txUrl(r.data.settlement.transaction)}`)
      settlements.push(r.data.settlement.transaction)
    }
    log(`    server spend after this call: ${JSON.stringify(r.data.spend)}`)
    if (r.data.json) verdict(`payment ${n}: the data that was bought equals the direct reads at its block ${r.data.json.blockNumber}`, await verify(r.data.json))
    else check(false, `payment ${n}: no JSON data came back`)
    return r
  }

  await paidCall(1, 'a trove health read', `${cheap.url}/v1/trove/${tail}`, async (j) => differences('answer', j, await directTrove(pub, tail, BigInt(j.blockNumber))))

  const over = await call('pay_and_fetch', { url: `${pricey.url}/v1/trove/${tail}` })
  verdict('a price over the per-call limit ($0.05 against 0.002 MUSD) is refused before anything is signed', [
    ...(over.isError && over.data.refused === true && /per-call limit/.test(String(over.data.reason)) ? [] : [`unexpected answer: ${over.text.slice(0, 200)}`]),
    ...(priceyFacilitator.seen.verify === 0 && priceyFacilitator.seen.settle === 0 ? [] : [`the facilitator was asked to verify ${priceyFacilitator.seen.verify} and settle ${priceyFacilitator.seen.settle} payments`]),
    ...(over.data.spend?.spentMusd === '0.001' && over.data.spend?.payments === 1 ? [] : [`the server's spend changed: ${JSON.stringify(over.data.spend)}`]),
  ])
  log(`    refusal: ${over.text.slice(0, 160)}`)
  log('    (this refusal comes from the x402 client library\'s own spend control, which the server sets to the same limit and which runs just before the SpendGuard hook)')

  await paidCall(2, 'a DEX quote', `${cheap.url}/v1/pool/quote?tokenIn=BTC&tokenOut=MUSD&amountIn=0.001`, async (j) =>
    differences('answer', j, await directPool(pub, ADDRESSES.btc, ADDRESSES.musd, 10n ** 15n, false, BigInt(j.blockNumber))),
  )

  const settlesAfterTwo = cheapFacilitator.seen.settle
  const third = await call('pay_and_fetch', { url: `${cheap.url}/v1/ve/${holder}` })
  verdict('a third payment would take the session over its limit (0.003 against 0.002 MUSD): refused before anything is signed', [
    ...(third.isError && third.data.refused === true && /session limit/.test(String(third.data.reason)) ? [] : [`unexpected answer: ${third.text.slice(0, 200)}`]),
    ...(cheapFacilitator.seen.settle === settlesAfterTwo ? [] : ['the facilitator was asked to settle another payment']),
    ...(third.data.spend?.spentMusd === '0.002' && third.data.spend?.remainingMusd === '0' ? [] : [`unexpected spend: ${JSON.stringify(third.data.spend)}`]),
  ])
  log(`    refusal: ${third.text.slice(0, 200)}`)
  check(cheapFacilitator.seen.verify === 2 && cheapFacilitator.seen.settle === 2 && priceyFacilitator.seen.verify === 0 && priceyFacilitator.seen.settle === 0, `the facilitator was asked to verify ${cheapFacilitator.seen.verify} and settle ${cheapFacilitator.seen.settle} payments on the cheap endpoint (expected 2 and 2: one per payment, none for a refused one) and 0 and 0 on the pricey one`)

  const outside = await call('pay_and_fetch', { url: 'https://example.com/' })
  check(outside.isError && /not on the allow list/.test(outside.text) && /nothing was paid/.test(outside.text), `a host that is not on the allow list is refused without any request: "${outside.text.slice(0, 120)}"`)
  const junk = await call('pay_and_fetch', { url: 'not a url' })
  check(junk.isError && /nothing was paid/.test(junk.text), `a bad URL is a tool error, nothing is paid: "${junk.text.slice(0, 120)}"`)

  // ---- what really happened on chain -----------------------------------------------------------------------------------------------------------
  log('')
  log('== on chain')
  check(new Set(settlements.map((h) => h.toLowerCase())).size === settlements.length && settlements.length === 2, `${settlements.length} settlement hashes, all different (expected 2)`)
  for (const hash of settlements) {
    const s = await settlementProblems(hash, { buyer: account.address, payee: cheap.payTo, amount: PRICE, afterBlock: startBlock })
    verdict(`explorer: ${hash} succeeded in block ${s.block} (run began at ${startBlock}), sent by the facilitator ${s.sender}, moved exactly 0.001 MUSD from the buyer to the payee`, s.problems)
  }
  const after = { buyer: await balance(account.address), payee: await balance(cheap.payTo), btc: await pub.getBalance({ address: account.address }), nonce: await pub.getTransactionCount({ address: account.address }) }
  log(`MUSD after    buyer ${after.buyer}   payee ${after.payee}  (base units)`)
  check(before.buyer - after.buyer === after.payee - before.payee && after.payee - before.payee === PRICE * BigInt(settlements.length), `the buyer paid exactly ${settlements.length} x 0.001 MUSD and the payee received it (nothing else moved)`)
  check(before.btc === after.btc && before.nonce === after.nonce, 'the buyer sent no transaction and spent no BTC: the facilitator paid the gas')
} catch (e) {
  // A tool call that times out or a dropped connection must still leave a log: keep the message short and free of local paths.
  check(false, `the session stopped with an error: ${String((e as Error).message ?? e).replaceAll(homedir(), '<home>').slice(0, 300)}`)
} finally {
  clearTimeout(watchdog)
  await client.close().catch(() => undefined)
  // The child was started here, so it is stopped here: wait for it to leave, and if it has not within 5 s, stop that one process by its id.
  if (childPid) {
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(childPid, 0)
      } catch {
        childPid = null
        break
      }
      await sleep(100)
    }
    if (childPid) process.kill(childPid)
  }
  await cheap.close()
  await pricey.close()
}
check(childPid === null, 'the server process has exited after the client closed')
const key = readKeyFile(keyPaths().ops).slice(2).toLowerCase()
const leaks = (text: string) => text.toLowerCase().includes(key) || text.toLowerCase().includes(keyPaths().ops.toLowerCase())
check(!leaks(said) && !leaks(stderr) && !said.toLowerCase().includes(homedir().toLowerCase()), 'nothing the server said (the tool list, every answer, its stderr) contains the private key, the key file path, or a home path')
log('')
log(failures() === 0 ? 'MCP SESSION PASSED' : `MCP SESSION FAILED (${failures()} failed check(s))`)
save(OUT)
process.exit(failures() === 0 ? 0 : 1)
