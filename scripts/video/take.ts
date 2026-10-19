// The take for the pitch video: ONE real run on Mezo testnet, written down as data. Every scene of the video that shows a result is drawn from
// media/raw/take.json (this script writes it); nothing on screen is typed by hand.
//   1. the Worker: started here under `wrangler dev` on 127.0.0.1:8787 (inspector 8402, own process group); attached instead, and left running,
//      when BASE_URL points at another host or the port is already taken;
//   2. a plain x402 buyer pays one call: the unpaid 402, the signed Permit2 permit, the 200 with the settlement (every HTTP hop is recorded);
//   3. the real stdio MCP server under limits of 0.001 MUSD per call and in total: the four free lens reads, one paid call that settles,
//      one that the session limit refuses before anything is signed;
//   4. the explorer, the MUSD balances and /api/payments must agree on both payments; the two no-double-pay unit tests run offline;
//   5. record-live.mjs films the explorer page of the first payment and the Worker's console page while the Worker is still up.
// Costs 2 x 0.001 MUSD, one attempt per payment, never retried; stops before a payment once the wallet has lost 0.004 MUSD.
// The key is read in code from MEZO_KEY_FILE and never printed. Writes media/raw/take.json and
// evidence/video-take-<UTC date>.log (the deck's facts file comes from scripts/video/facts.mjs). Exit code is non-zero if any check fails.
// Usage: MEZO_KEY_FILE=<file> node --import tsx scripts/video/take.ts [--url <base>] [--no-pay]
//   --no-pay  does everything that costs nothing (Worker, free reads, refusal by allow list, offline tests) and writes no evidence.
//   --live-only  refilms only the two live pages (explorer, console) of the payments already in media/raw/take.json against the Worker at --url;
//             free routes only, nothing is spent, and only the `live` key of take.json changes (used to re-take the host scenes after a deploy).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatUnits, type Address } from 'viem'
import { erc20Abi } from '../../src/abis.ts'
import { publicClient } from '../../src/clients.ts'
import { ADDRESSES, CHAIN_ID, DEFAULT_PAYEE, FACILITATOR_URL, NETWORK, txUrl } from '../../src/config.ts'
import { keyPaths, opsAccount, readKeyFile } from '../../src/keys.ts'
import { createBuyer } from '../../src/pay.ts'
import { SpendGuard } from '../../src/spend.ts'
import { troveFromTail } from '../lib/direct.ts'
import { settlementProblems } from '../lib/explorer.ts'
import { discoverLiveLock, discoverVeHolder } from '../lib/holders.ts'
import { createReport } from '../lib/report.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const RAW = join(ROOT, 'media/raw')
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const noPay = process.argv.includes('--no-pay')
const liveOnly = process.argv.includes('--live-only')
const BASE = (arg('--url') ?? process.env.BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const U = new URL(BASE)
const PORT = Number(U.port || (U.protocol === 'https:' ? 443 : 80))
const LOCAL = U.hostname === '127.0.0.1' || U.hostname === 'localhost'
const INSPECTOR = 8402 // the only other port this work may use (other local tools hold the other ports)
const PRICE = 1_000_000_000_000_000n // 0.001 MUSD in base units (18 decimals)
const STOP_AT = 4_000_000_000_000_000n // the wallet may lose at most 0.004 MUSD in this take (the brief allows 0.05 in total)
const LIMIT = '0.001' // per call and per session, for the buyer and for the MCP server
const NODOUBLE = 'does not pay twice|pays for that URL again' // the two tests of src/pay.ts that guard against a second payment for one URL
const TOOLS = ['pay_and_fetch', 'pool_quote', 'redemption_risk', 'trove_health', 've_locks']
const DAY = new Date().toISOString().slice(0, 10)
const OUT_LOG = join(ROOT, `evidence/video-take-${DAY}.log`)

const { log, check, verdict, failures, save } = createReport()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const short = (a: string) => `${a.slice(0, 8)}...${a.slice(-6)}`
// A 5xx answer of the Worker is noted with its time (Cloudflare shows its CPU-limit error 1102 as a 503 page); the take log lists them at the end.
const edgeErrors: string[] = []
const watch = async (res: Response, path: string) => {
  if (res.status >= 500) edgeErrors.push(`${new Date().toISOString()} HTTP ${res.status} ${path}${/\b1102\b/.test(await res.clone().text().catch(() => '')) ? ' (Cloudflare error 1102: CPU limit)' : ''}`)
  return res
}
const get = async (path: string, init: RequestInit = {}) => watch(await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(25_000) }), path) // a hung request must fail, not wait
// Long strings (signatures, nonces) are cut for display; addresses and hashes (at most 66 characters) stay whole so a viewer can compare them.
const cut = (v: unknown): unknown => (typeof v === 'string' ? (v.length > 66 ? `${v.slice(0, 20)}...${v.slice(-6)} (${v.length} chars)` : v) : Array.isArray(v) ? v.map(cut) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)])) : v)
const shownJson = (j: unknown): string[] => Object.entries((j ?? {}) as Record<string, unknown>).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 8).map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)

// ---- the Worker process (as in scripts/worker-smoke.ts, but with the inspector on an allowed port) -----------------------------------------------
const inUse = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port })
    s.once('connect', () => (s.destroy(), resolve(true)))
    s.once('error', () => resolve(false))
  })
let child: ChildProcess | undefined
let tempDir = ''
let attached = !LOCAL
const wranglerLog = () => (tempDir ? readFileSync(join(tempDir, 'wrangler.log'), 'utf8') : '')
const scrub = (s: string) => s.replaceAll(homedir(), '~')

async function start() {
  if (await inUse(INSPECTOR)) throw new Error(`port ${INSPECTOR} is already in use; not touching whatever runs there`)
  tempDir = mkdtempSync(join(tmpdir(), 'video-take-'))
  const fd = openSync(join(tempDir, 'wrangler.log'), 'w')
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }
  for (const k of ['DISPLAY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) delete env[k]
  // `npm run dev` is the command a user runs, so the pinned wrangler version lives in one place (package.json). Own process group: stop() ends exactly these processes.
  child = spawn('npm', ['run', '--silent', 'dev', '--', '--ip', '127.0.0.1', '--port', String(PORT), '--inspector-port', String(INSPECTOR), '--log-level', 'info'], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd], env })
  closeSync(fd)
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early (code ${child.exitCode}); last lines: ${scrub(wranglerLog().trim().split('\n').slice(-6).join(' | '))}`)
    if (await fetch(BASE + '/favicon.ico', { signal: AbortSignal.timeout(2000) }).then((r) => r.status === 204, () => false)) return
    await sleep(500)
  }
  throw new Error('wrangler dev did not answer within 150 s')
}

async function stop() {
  if (!child?.pid) return true
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
  const busy = async () => (await inUse(PORT)) || (await inUse(INSPECTOR))
  for (let i = 0; i < 40 && (await busy()); i++) await sleep(250)
  if (await busy()) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    await sleep(1000)
  }
  return !(await busy())
}

const watchdog = setTimeout(async () => {
  console.error('overall time limit reached; stopping')
  await stop()
  process.exit(2)
}, 1_200_000)
watchdog.unref()
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, async () => (await stop(), process.exit(130)))

// ---- chain reads -------------------------------------------------------------------------------------------------------------------------------
const pub = publicClient()
const account = opsAccount() // only the public address is used here; the MCP child loads the key itself from the path in its environment
const balance = (a: Address) => pub.readContract({ address: ADDRESSES.musd, abi: erc20Abi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>
const snapshot = async (payee: Address) => ({ buyer: await balance(account.address), payee: await balance(payee), btc: await pub.getBalance({ address: account.address }), nonce: await pub.getTransactionCount({ address: account.address }) })
const musd = (v: bigint) => formatUnits(v, 18)

// ---- what the plain buyer's HTTP hops looked like ------------------------------------------------------------------------------------------------
interface Hop { n: number; method: string; path: string; status: number; ms: number; sent?: unknown; got?: Record<string, unknown> }
const hops: Hop[] = []
const recordingFetch: typeof fetch = async (input, init) => {
  const req = input instanceof Request ? input : undefined
  const url = new URL(req ? req.url : String(input))
  const headers = req ? req.headers : new Headers(init?.headers)
  const hop: Hop = { n: hops.length + 1, method: req ? req.method : (init?.method ?? 'GET'), path: url.pathname + url.search, status: 0, ms: 0 }
  const sig = headers.get('payment-signature')
  if (sig) hop.sent = cut(decodePaymentSignatureHeader(sig))
  hops.push(hop)
  const t0 = Date.now()
  const res = await watch(await fetch(input, init), url.pathname)
  hop.ms = Date.now() - t0
  hop.status = res.status
  const required = res.headers.get('payment-required')
  if (required) hop.got = { ...hop.got, paymentRequired: cut(decodePaymentRequiredHeader(required)) }
  const settled = res.headers.get('payment-response')
  if (settled) hop.got = { ...hop.got, paymentResponse: cut(decodePaymentResponseHeader(settled)) }
  return res
}

interface Called { isError: boolean; text: string; data: any; ms: number } // eslint-disable-line @typescript-eslint/no-explicit-any
let said = '' // everything the MCP server said, searched for secrets at the end

// ---- the two live pages, filmed by record-live.mjs while the Worker is up (headless Chromium, no display) -----------------------------------------
function filmLive(shotTx: string, txs: string[]) {
  const rec = spawnSync(process.execPath, [join(ROOT, 'scripts/video/record-live.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 300_000, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TZ: 'UTC', BASE_URL: BASE, EXPLORER_URL: shotTx ? txUrl(shotTx) : '', CONSOLE_TX: txs.join(',') } })
  const filmed = (() => { try { return JSON.parse(readFileSync(join(RAW, 'live/live.json'), 'utf8')) } catch { return undefined } })()
  check(rec.status === 0 && !!filmed?.explorer?.ok && !!filmed?.console?.ok, `record-live.mjs filmed both pages: explorer ${filmed?.explorer?.note ?? '?'}; console ${filmed?.console?.note ?? '?'}`, [scrub(`${rec.stdout}\n${rec.stderr}`).trim().split('\n').slice(-4).join(' | ')])
  return filmed
}

let allStopped = true
let ok = false

if (liveOnly) {
  // Refilms the explorer page and the console of the payments in media/raw/take.json; free routes only, so nothing is spent and no payment is made.
  try {
    if (LOCAL && ![8787, INSPECTOR].includes(PORT)) throw new Error(`port ${PORT} is not one of the two allowed ports (8787, 8402)`)
    if (LOCAL && (await inUse(PORT))) { attached = true; log(`the port ${PORT} is already served: attached to that Worker, it is left running`) }
    const prev = JSON.parse(readFileSync(join(RAW, 'take.json'), 'utf8')) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    const txs = [prev.plain?.tx, prev.mcp?.paid?.tx].filter(Boolean) as string[]
    if (txs.length !== 2) throw new Error('media/raw/take.json does not hold the two payments; run the full take first')
    log(`Live pages only, Worker on ${BASE}; the payments are the ones of the take of ${prev.when}`)
    if (!attached) await start()
    check((await get('/health')).status === 200, '/health answers')
    prev.live = filmLive(txs[0], txs)
    prev.liveRefilmedAt = new Date().toISOString()
    if (JSON.stringify(prev.live).includes(homedir())) throw new Error('the live data would contain a home path; not written')
    writeFileSync(join(RAW, 'take.json'), JSON.stringify(prev, null, 1))
    ok = true
  } catch (e) {
    check(false, 'the run finished without an unexpected error', [scrub(String((e as Error)?.stack ?? e)).split('\n').slice(0, 6).join(' | ')])
  } finally {
    if (!attached) {
      allStopped = await stop()
      check(allStopped, `wrangler dev was stopped (its own process group only) and ports ${PORT} and ${INSPECTOR} are free again`)
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  }
  log(failures() === 0 && ok ? 'LIVE PAGES FILMED' : `${failures()} CHECK(S) FAILED`)
  clearTimeout(watchdog)
  process.exit(failures() === 0 && ok && allStopped ? 0 : 1)
}

const take: Record<string, unknown> = {}
const startBlock = await pub.getBlockNumber()
try {
  const started = new Date()
  log(`Video take, Worker on ${BASE}, real payments on Mezo testnet, UTC ${started.toISOString()}${noPay ? '   (--no-pay: nothing is spent)' : ''}`)
  if (LOCAL && ![8787, INSPECTOR].includes(PORT)) throw new Error(`port ${PORT} is not one of the two allowed ports (8787, 8402)`)
  if (LOCAL && (await inUse(PORT))) { attached = true; log(`the port ${PORT} is already served: attached to that Worker, it is left running`) }
  if (attached && LOCAL) log('attached to a Worker that is already running')
  else if (attached) log(`attached to ${BASE} (not started here)`)
  const t0 = Date.now()
  if (!attached) await start()
  log(`the Worker answers after ${((Date.now() - t0) / 1000).toFixed(1)} s${attached ? '' : ' (including a start of wrangler dev)'}`)

  // ---- free routes first (under workerd the first request must not be a paid one; see src/worker-app.ts) --------------------------------------
  const health = await get('/health')
  check(health.status === 200 && same(await health.json(), { ok: true }), '/health: 200 {"ok":true}')
  const status = (await (await get('/status')).json()) as { network: string; chainId: number; lens: { address: string; explorer: string }; payTo: string; price: string; facilitator: string; endpoints: Record<string, string> }
  verdict('/status: Mezo testnet, the payee from wrangler.toml, price $0.001, the lens address, four paid routes', [
    ...(status.network === NETWORK && status.chainId === CHAIN_ID ? [] : [`network ${status.network} / ${status.chainId}`]),
    ...(status.payTo === DEFAULT_PAYEE ? [] : [`payTo ${status.payTo} is not the configured payee`]),
    ...(status.price === '$0.001' ? [] : [`price ${status.price}`]),
    ...(/^0x[0-9a-fA-F]{40}$/.test(status.lens?.address ?? '') ? [] : ['no lens address']),
    ...(Object.keys(status.endpoints ?? {}).length === 4 ? [] : [`${Object.keys(status.endpoints ?? {}).length} paid routes`]),
  ])
  const payee = status.payTo as Address
  const listed0 = (await (await get('/api/payments')).json()) as { payments: { transaction: string }[]; searchedFrom: number; head: number }
  log(`/api/payments before the take: ${listed0.payments.length} payment(s) to the payee in blocks ${listed0.searchedFrom}-${listed0.head}`)

  const pinned = (await pub.getBlockNumber()) - 2n
  const tail = await troveFromTail(pub, 0, pinned)
  const deep = await troveFromTail(pub, 30, pinned).catch(() => troveFromTail(pub, 10, pinned))
  const live = await discoverLiveLock(pub, pinned)
  const holder = live?.owner ?? (await discoverVeHolder())
  check(!!holder, 'a holder of vote-escrow locks was found for the ve_locks read')
  log(`troves: shallow (first in the redemption queue) ${tail}   deep ${deep}`)

  const before = await snapshot(payee)
  log(`buyer ${account.address}   payee ${payee}`)
  log(`MUSD before   buyer ${before.buyer}   payee ${before.payee}  (base units; buyer ${musd(before.buyer)} MUSD)`)
  const spentSoFar = async () => before.buyer - (await balance(account.address))

  // ---- the unpaid challenge -------------------------------------------------------------------------------------------------------------------
  log('')
  log('== the 402 challenge')
  const unpaid = await get(`/v1/trove/${tail}`)
  const header = unpaid.headers.get('payment-required')
  const challenge = header ? decodePaymentRequiredHeader(header) : undefined
  const offer = challenge?.accepts?.[0]
  verdict('GET /v1/trove/<address> without payment: 402, x402 v2, one "exact" offer of 0.001 MUSD on Mezo testnet to the payee, with gas sponsoring', [
    ...(unpaid.status === 402 ? [] : [`HTTP ${unpaid.status}`]),
    ...(challenge?.x402Version === 2 && challenge.accepts.length === 1 ? [] : ['not v2 with exactly one offer']),
    ...(offer?.scheme === 'exact' && offer.network === NETWORK ? [] : [`scheme/network ${offer?.scheme} ${offer?.network}`]),
    ...(offer?.amount === PRICE.toString() ? [] : [`amount ${offer?.amount}`]),
    ...(offer?.asset.toLowerCase() === ADDRESSES.musd.toLowerCase() ? [] : [`asset ${offer?.asset}`]),
    ...(offer?.payTo === payee ? [] : [`payTo ${offer?.payTo}`]),
    ...(JSON.stringify(challenge?.extensions ?? {}).includes('eip2612GasSponsoring') ? [] : ['no eip2612GasSponsoring extension']),
  ])

  const verify = async (hash: string, afterBlock: bigint) => {
    const s = await settlementProblems(hash, { buyer: account.address, payee, amount: PRICE, afterBlock })
    verdict(`the explorer shows ${short(hash)}: status ok, block ${s.block}, sent by the facilitator (${short(s.sender)}), MUSD buyer -> payee 0.001`, s.problems)
    return { block: s.block, sender: s.sender, problems: s.problems }
  }

  // ---- payment 1: a plain x402 buyer ---------------------------------------------------------------------------------------------------------
  let plainTx = ''
  let mcpTx = ''
  let plainExplorer: { block: string; sender: string; problems: string[] } | undefined
  let mcpExplorer: { block: string; sender: string; problems: string[] } | undefined
  if (noPay) log('\nSKIPPED  payment 1 (--no-pay)')
  else {
    log('')
    log('== payment 1: a plain x402 buyer (the buyer code the MCP tool uses, here called directly)')
    if ((await spentSoFar()) + PRICE > STOP_AT) throw new Error('budget guard: the take has spent too much already')
    const buyer = createBuyer({ account, chainReader: pub, guard: SpendGuard.fromEnv({ MEZO_MAX_PER_CALL_MUSD: LIMIT, MEZO_MAX_PER_SESSION_MUSD: LIMIT }), allowedHosts: [U.host], fetchImpl: recordingFetch })
    const t1 = Date.now()
    const paid = await buyer.fetchPaid(`${BASE}/v1/trove/${tail}`)
    const ms = Date.now() - t1
    plainTx = paid.settlement?.transaction ?? ''
    verdict(`the buyer's call: status 200, paid, 0.001 MUSD authorised, a settlement transaction, paid by the buyer, in ${(ms / 1000).toFixed(1)} s`, [
      ...(paid.status === 200 && paid.paid && paid.authorizedMusd === '0.001' && /^0x[0-9a-fA-F]{64}$/.test(plainTx) ? [] : [`unexpected result: ${JSON.stringify({ status: paid.status, paid: paid.paid, authorizedMusd: paid.authorizedMusd, unsettled: paid.unsettled }).slice(0, 300)}`]),
      ...(String(paid.settlement?.payer).toLowerCase() === account.address.toLowerCase() ? [] : [`the payer is ${paid.settlement?.payer}`]),
    ])
    log(`    HTTP hops: ${hops.map((h) => `${h.method} ${h.path.replace(tail, '<trove>')} -> ${h.status} (${h.ms} ms)`).join('; ')}`)
    if (plainTx) log(`    settlement ${plainTx}   ${txUrl(plainTx)}`)
    take.plain = { path: `/v1/trove/${tail}`, ms, tx: plainTx, explorer: plainTx ? txUrl(plainTx) : '', hops, shown: shownJson(paid.json), spent: paid.spend }
    if (plainTx) plainExplorer = await verify(plainTx, startBlock)
  }

  // ---- the MCP server, as an agent host runs it ----------------------------------------------------------------------------------------------------
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp.ts'],
    cwd: ROOT,
    env: { ...getDefaultEnvironment(), MEZO_KEY_FILE: keyPaths().ops, MEZO_MAX_PER_CALL_MUSD: LIMIT, MEZO_MAX_PER_SESSION_MUSD: LIMIT, MEZO_PAY_ALLOWED_HOSTS: U.host },
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
  const client = new Client({ name: 'scripted-client', version: '0.0.0' })
  const call = async (name: string, args: Record<string, unknown>): Promise<Called> => {
    const t = Date.now()
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 150_000 })) as { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: unknown }
    said += JSON.stringify(r)
    return { isError: r.isError === true, text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), data: r.structuredContent ?? {}, ms: Date.now() - t }
  }
  const mcp: Record<string, unknown> = { host: U.host, limitPerCall: LIMIT, limitPerSession: LIMIT }
  try {
    log('')
    log('== the MCP server (a scripted client, no model), limits 0.001 MUSD per call and in total, host ' + U.host)
    await client.connect(transport)
    for (let i = 0; i < 100 && !stderr.includes('"mcp-ready"'); i++) await sleep(100)
    const { tools } = await client.listTools()
    said += JSON.stringify(tools)
    check(same(tools.map((t) => t.name).sort(), TOOLS), `tools/list returns the five tools: ${tools.map((t) => t.name).sort().join(', ')}`)
    mcp.tools = tools.map((t) => ({ name: t.name, description: (t.description ?? '').split(/(?<=[.!?])\s/)[0] }))

    const reads: Record<string, unknown>[] = []
    const trove = await call('trove_health', { address: tail })
    check(!trove.isError && trove.data.active === true, `trove_health ${short(tail)}: ${String(trove.data.summary ?? trove.text).slice(0, 140)}`)
    reads.push({ tool: 'trove_health', arg: tail, ms: trove.ms, block: trove.data.blockNumber, summary: trove.data.summary })
    const risk = await call('redemption_risk', { address: deep })
    check(!risk.isError && Number(risk.data.stepsWalked) > 1, `redemption_risk ${short(deep)}: ${risk.data.stepsWalked} positions walked of ${risk.data.listSize}, ${risk.data.redeemableTrovesAhead} redeemable troves and ${risk.data.redeemableMusdAhead} MUSD ahead (${risk.ms} ms)`)
    reads.push({ tool: 'redemption_risk', arg: deep, ms: risk.ms, block: risk.data.blockNumber, summary: risk.data.summary, stepsWalked: risk.data.stepsWalked, listSize: risk.data.listSize, redeemableTrovesAhead: risk.data.redeemableTrovesAhead, redeemableMusdAhead: risk.data.redeemableMusdAhead, skippedBelowMcr: risk.data.skippedBelowMcr, borrowerIcrPercent: risk.data.borrowerIcrPercent, walkComplete: risk.data.walkComplete, mcrPercent: risk.data.mcrPercent })
    const quote = await call('pool_quote', { tokenIn: 'BTC', tokenOut: 'MUSD', amountIn: '0.001' })
    check(!quote.isError && quote.data.quoteOk === true, `pool_quote: ${String(quote.data.summary ?? quote.text).slice(0, 140)}`)
    reads.push({ tool: 'pool_quote', arg: 'BTC -> MUSD, 0.001', ms: quote.ms, block: quote.data.blockNumber, summary: quote.data.summary })
    const ve = await call('ve_locks', { address: holder })
    check(!ve.isError && Number(ve.data.returned) > 0, `ve_locks ${short(String(holder))}: ${ve.data.returned} lock(s), ${String(ve.data.summary ?? '').slice(0, 100)}`)
    reads.push({ tool: 've_locks', arg: String(holder), ms: ve.ms, block: ve.data.blockNumber, summary: ve.data.summary ?? `${ve.data.returned} lock(s)` })
    mcp.reads = reads
    take.lens = reads[1]
    take.narrationVars = { steps: Number(risk.data.stepsWalked) }

    if (noPay) {
      const refused = await call('pay_and_fetch', { url: `http://localhost:${PORT}/v1/trove/${tail}` })
      check(refused.isError && /not on the allow list/.test(refused.text), `rehearsal: a host that is not on the allow list is refused: "${refused.text.slice(0, 100)}"`)
    } else {
      log('')
      log('== payment 2: pay_and_fetch through the MCP server, then the call the session limit must refuse')
      if ((await spentSoFar()) + PRICE > STOP_AT) throw new Error('budget guard: the take has spent too much already')
      const url = `${BASE}/v1/redemption/${deep}`
      const paid = await call('pay_and_fetch', { url })
      mcpTx = String(paid.data.settlement?.transaction ?? '')
      verdict(`pay_and_fetch ${url.replace(BASE, '')}: status 200, paid, 0.001 MUSD authorised, a settlement transaction, paid by the buyer, session spend 0.001 (${(paid.ms / 1000).toFixed(1)} s)`, [
        ...(paid.isError ? [`tool error: ${paid.text.slice(0, 240)}`] : []),
        ...(paid.data.status === 200 && paid.data.paid === true && paid.data.authorizedMusd === '0.001' && /^0x[0-9a-fA-F]{64}$/.test(mcpTx) ? [] : [`unexpected answer: ${JSON.stringify({ status: paid.data.status, paid: paid.data.paid, unsettled: paid.data.unsettled }).slice(0, 300)}`]),
        ...(String(paid.data.settlement?.payer).toLowerCase() === account.address.toLowerCase() ? [] : [`the payer is ${paid.data.settlement?.payer}`]),
        ...(paid.data.spend?.spentMusd === '0.001' ? [] : [`spent ${paid.data.spend?.spentMusd}`]),
      ])
      if (mcpTx) log(`    settlement ${mcpTx}   ${txUrl(mcpTx)}`)
      mcp.paid = { path: url.replace(BASE, ''), ms: paid.ms, tx: mcpTx, explorer: mcpTx ? txUrl(mcpTx) : '', status: paid.data.status, authorizedMusd: paid.data.authorizedMusd, spend: paid.data.spend, shown: shownJson(paid.data.json) }

      const w0 = await snapshot(payee)
      const refused = await call('pay_and_fetch', { url: `${BASE}/v1/trove/${deep}` })
      const w1 = await snapshot(payee)
      verdict(`the second call is refused by the session limit before anything is signed: "${refused.text.slice(0, 160).replace(/\s+/g, ' ')}"`, [
        ...(refused.isError ? [] : ['it was not refused']),
        ...(/session/i.test(refused.text) && /nothing was paid/.test(refused.text) ? [] : ['the refusal does not name the session limit and say that nothing was paid']),
        ...(w0.buyer === w1.buyer && w0.payee === w1.payee && w0.nonce === w1.nonce ? [] : ['the refusal moved MUSD or the buyer sent a transaction']),
      ])
      mcp.refused = { path: `/v1/trove/${deep}`, ms: refused.ms, isError: refused.isError, text: refused.text.slice(0, 400), moved: w0.buyer !== w1.buyer || w0.payee !== w1.payee }
    }
  } finally {
    await client.close().catch(() => undefined)
  }
  take.mcp = mcp

  // ---- what really happened ----------------------------------------------------------------------------------------------------------------------
  const txs = [plainTx, mcpTx].filter(Boolean)
  let after = before
  if (txs.length) {
    log('')
    log('== what really happened')
    after = await snapshot(payee)
    log(`MUSD after    buyer ${after.buyer}   payee ${after.payee}  (base units; buyer ${musd(after.buyer)} MUSD)`)
    const n = BigInt(txs.length)
    check(before.buyer - after.buyer === PRICE * n && after.payee - before.payee === PRICE * n, `the buyer paid exactly ${PRICE * n} base units (${musd(PRICE * n)} MUSD) and the payee received exactly that (buyer ${before.buyer - after.buyer}, payee ${after.payee - before.payee})`)
    check(before.btc === after.btc && before.nonce === after.nonce, 'the buyer sent no transaction and spent no BTC: the facilitator paid the gas')
    if (mcpTx) mcpExplorer = await verify(mcpTx, startBlock)
    check(plainTx !== mcpTx, 'the two payments are two different transactions')
    const last = ((await (await get('/status')).json()) as { lastSettlement: { transaction: string } | null }).lastSettlement
    const seen = !!last && txs.map((t) => t.toLowerCase()).includes(last.transaction.toLowerCase())
    // Each instance of a deployed Worker keeps its own last settlement, so another instance may answer; locally the check stays strict (as in scripts/worker-smoke.ts).
    check(seen || !LOCAL, `/status reports one of these transactions as the last settlement${seen || LOCAL ? '' : ' (not checked: another Worker instance answered /status)'}`)

    // The list is cached, so the first answers may predate the payments: ask again until the cache expires and the chain is read afresh.
    const polled = Date.now()
    let rows: { transaction: string; musd: string; from: string; explorer: string; time: string }[] = []
    for (;;) {
      const list = (await (await get('/api/payments')).json()) as { payments: typeof rows }
      rows = list.payments.filter((p) => txs.some((t) => t.toLowerCase() === p.transaction.toLowerCase()))
      if (rows.length === txs.length || Date.now() - polled > 150_000) break
      await sleep(5000)
    }
    const waited = Date.now() - polled
    check(rows.length === txs.length && rows.every((r) => r.musd === '0.001' && r.from.toLowerCase() === account.address.toLowerCase()), `/api/payments lists both payments (0.001 MUSD from the buyer, explorer links) ${(waited / 1000).toFixed(0)} s after the calls`, [`found ${rows.length} of ${txs.length} after ${waited} ms`])
    take.payments = { waitedSeconds: Math.round(waited / 1000), rows }
  }

  // ---- the two live pages, filmed while the Worker is still up (record-live.mjs; headless Chromium, no display) --------------------------------------
  log('')
  log('== filming the explorer page of the first payment and the Worker console')
  const shotTx = plainTx || listed0.payments[0]?.transaction || '' // a rehearsal (--no-pay) films the page of an earlier real payment to the same payee
  take.live = filmLive(shotTx, txs)
  const filmedErrors = ['explorer', 'console'].flatMap((k) => ((take.live as { [k: string]: { errors?: string[] } } | undefined)?.[k]?.errors ?? []))
  edgeErrors.push(...filmedErrors)
  take.edgeErrors = edgeErrors
  log(`5xx answers from the Worker during the take (this script and the filmed console page): ${edgeErrors.length ? edgeErrors.join(' | ') : 'none'}`)

  // ---- the two no-double-pay unit tests, offline (stub facilitator): their real output is the "nodouble" scene -----------------------------------------
  log('')
  log('== the no-double-pay unit tests (offline, stub facilitator)')
  const ansi = /\u001b\[[0-9;]*m/g
  const vt = spawnSync('npm', ['--prefix', ROOT, 'exec', '--', 'vitest', 'run', 'test/pay.test.ts', '-t', NODOUBLE, '--reporter=verbose'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TZ: 'UTC' } })
  // only the result lines are kept: the RUN line of vitest carries the folder of this checkout
  const vlines = `${vt.stdout}\n${vt.stderr}`.replace(ansi, '').split('\n').map((l) => scrub(l.trim())).filter((l) => /^(✓|Test Files|Tests)(\s|$)/.test(l))
  const passed = vlines.filter((l) => l.startsWith('✓'))
  check(vt.status === 0 && passed.length === 2, `vitest ran the two tests offline and both passed: ${passed.map((l) => l.replace(/^✓ test\/pay.test.ts > /, '').slice(0, 70)).join(' | ')}`)
  take.offline = { command: `npx vitest run test/pay.test.ts -t "${NODOUBLE}"`, lines: vlines }

  // ---- nothing leaked ----------------------------------------------------------------------------------------------------------------------------
  const keyHex = readKeyFile(keyPaths().ops).slice(2).toLowerCase()
  const wlog = wranglerLog()
  const leaks = (t: string) => t.toLowerCase().includes(keyHex) || t.includes(keyPaths().ops)
  check(!leaks(said) && !leaks(stderr) && !leaks(wlog) && !said.includes(homedir()), 'nothing the MCP server said, its stderr or the Worker\'s own output contains the private key or the key file path')
  check(!/\bERROR\b|Uncaught|TypeError|ReferenceError/.test(wlog) || attached, `the Worker logged no error${attached ? ' (not checked: attached)' : ''}`, wlog.split('\n').filter((l) => /\bERROR\b|Uncaught|TypeError|ReferenceError/.test(l)).slice(0, 5).map(scrub))

  // ---- the take, as data ----------------------------------------------------------------------------------------------------------------------------
  Object.assign(take, {
    when: started.toISOString(), day: DAY, base: BASE, host: U.host, attached, network: NETWORK, chainId: CHAIN_ID, buyer: account.address, payee, lens: { ...(take.lens as object), address: status.lens.address },
    facilitator: FACILITATOR_URL, challenge: offer ? cut({ x402Version: challenge?.x402Version, scheme: offer.scheme, network: offer.network, amount: offer.amount, asset: offer.asset, payTo: offer.payTo, extensions: Object.keys(challenge?.extensions ?? {}) }) : null,
    balances: { before: { buyer: before.buyer.toString(), payee: before.payee.toString(), btc: before.btc.toString(), nonce: before.nonce }, after: { buyer: after.buyer.toString(), payee: after.payee.toString(), btc: after.btc.toString(), nonce: after.nonce } },
    spentMusd: musd(before.buyer - after.buyer), troves: { shallow: tail, deep }, explorer: { plain: plainExplorer, mcp: mcpExplorer }, logFile: noPay ? null : `evidence/video-take-${DAY}.log`,
  })
  if (noPay) take.dryRun = true
  ok = true
} catch (e) {
  check(false, 'the run finished without an unexpected error', [scrub(String((e as Error)?.stack ?? e)).split('\n').slice(0, 6).join(' | ')])
} finally {
  if (!attached) {
    allStopped = await stop()
    check(allStopped, `wrangler dev was stopped (its own process group only) and ports ${PORT} and ${INSPECTOR} are free again`)
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
}

mkdirSync(RAW, { recursive: true })
const json = JSON.stringify(take, null, 1)
const dirty = Object.entries(take).filter(([, v]) => JSON.stringify(v).includes(homedir()) || JSON.stringify(v).includes(keyPaths().ops)).map(([k]) => k)
if (dirty.length) throw new Error(`take.json would contain a home path or the key path (in ${dirty.join(', ')}); not written`)
writeFileSync(join(RAW, noPay ? 'take-dry.json' : 'take.json'), json)

log('')
log(failures() === 0 && ok ? 'ALL CHECKS PASSED' : `${failures()} CHECK(S) FAILED`)
if (!noPay && ok) save(OUT_LOG)
clearTimeout(watchdog)
process.exit(failures() === 0 && ok && allStopped ? 0 : 1)
