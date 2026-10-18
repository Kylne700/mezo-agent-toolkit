// The Worker end to end, on this machine, under `wrangler dev` (workerd, the runtime Cloudflare runs). No login, nothing is deployed.
//   - starts `npm run dev` on 127.0.0.1:8787 in its own process group (refuses to start if the port is taken, stops only that group);
//   - free routes first: /health, /status, /api/payments, the console page at / (CSP hashes, no outside resources, price and addresses agree with /status);
//   - the unpaid challenge: HTTP 402, x402 version 2, exact scheme, MUSD, the payee, 0.001 MUSD; the curl line printed on the page really prints it;
//   - bad input: an invalid address is 400 and never a challenge, a malformed payment header is 402 and serves no data;
//   - the real stdio MCP server (src/mcp.ts) pays one call through the Worker on Mezo testnet under limits of 0.01 MUSD per call and 0.1 in total;
//     the explorer, /status, /api/payments and the MUSD balances must all agree on that one payment, and the buyer must send no transaction of its own;
//   - one refusal: pay_and_fetch on a host that is not on the allow list pays nothing and never reaches the Worker.
// Free routes run before the paid one on purpose: under workerd a request that ended used to leave every later paid request hanging (see src/worker-app.ts).
// Costs 0.001 MUSD, one attempt, never retried. Writes evidence/worker-smoke.log; the exit code is non-zero if any check fails.
// Usage: tsx scripts/worker-smoke.ts [--note "text"] [--no-pay] [--url http://127.0.0.1:8787]
//   --no-pay  runs everything that costs nothing and writes no evidence file; --url checks a Worker that already runs (it is left running).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { decodePaymentRequiredHeader } from '@x402/core/http'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatUnits, type Address } from 'viem'
import { erc20Abi } from '../src/abis.ts'
import { publicClient } from '../src/clients.ts'
import { ADDRESSES, CHAIN_ID, DEFAULT_PAYEE, EXPLORER, NETWORK, addressUrl, txUrl } from '../src/config.ts'
import { keyPaths, opsAccount, readKeyFile } from '../src/keys.ts'
import { troveFromTail } from './lib/direct.ts'
import { settlementProblems } from './lib/explorer.ts'
import { createReport } from './lib/report.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = fileURLToPath(new URL('../evidence/worker-smoke.log', import.meta.url))
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const attach = arg('--url')
const noPay = process.argv.includes('--no-pay')
const note = arg('--note')
const BASE = (attach ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const PORT = Number(new URL(BASE).port)
const INSPECTOR = 9330
const PRICE = 1_000_000_000_000_000n // $0.001 in MUSD base units (18 decimals)
const PER_CALL = '0.01'
const PER_SESSION = '0.1'
const TOOLS = ['pay_and_fetch', 'pool_quote', 'redemption_risk', 'trove_health', 've_locks']

const { log, check, verdict, failures, save } = createReport()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sha = (t: string) => `'sha256-${createHash('sha256').update(t).digest('base64')}'`
const unescapeHtml = (s: string) => s.replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
const get = (path: string, init: RequestInit = {}) => fetch(BASE + path, { ...init, signal: AbortSignal.timeout(20_000) }) // a hung paid request must fail, not wait

// ---- the Worker process -------------------------------------------------------------------------------------------------------------------------
const inUse = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port })
    s.once('connect', () => (s.destroy(), resolve(true)))
    s.once('error', () => resolve(false))
  })
let child: ChildProcess | undefined
let tempDir = ''
const wranglerLog = () => (tempDir ? readFileSync(join(tempDir, 'wrangler.log'), 'utf8') : '')
const scrub = (s: string) => s.replaceAll(homedir(), '~')

async function start() {
  for (const port of [PORT, INSPECTOR]) if (await inUse(port)) throw new Error(`port ${port} is already in use; not touching whatever runs there`)
  tempDir = mkdtempSync(join(tmpdir(), 'worker-smoke-'))
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
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
  const busy = async () => (await inUse(PORT)) || (await inUse(INSPECTOR))
  for (let i = 0; i < 40 && (await busy()); i++) await sleep(250)
  if (await busy()) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    await sleep(1000)
  }
  return !(await busy())
}

const watchdog = setTimeout(async () => {
  console.error('overall time limit reached; stopping')
  await stop()
  process.exit(2)
}, 900_000)
watchdog.unref()
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, async () => (await stop(), process.exit(130)))

// ---- the buyer side: the real stdio MCP server --------------------------------------------------------------------------------------------------
const pub = publicClient()
const account = opsAccount() // only its public address is used here; the MCP child loads the key itself, from the file path in its environment
const balance = (a: Address) => pub.readContract({ address: ADDRESSES.musd, abi: erc20Abi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>
const snapshot = async (payee: Address) => ({ buyer: await balance(account.address), payee: await balance(payee), btc: await pub.getBalance({ address: account.address }), nonce: await pub.getTransactionCount({ address: account.address }) })

interface Called {
  isError: boolean
  text: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
}
let said = '' // everything the MCP server said, searched for secrets at the end

let allStopped = true
let ok = false
try {
  log(`Worker smoke, wrangler dev (workerd) on ${BASE}, real payment on Mezo testnet   ${new Date().toISOString()}`)
  if (note) log(`note: ${note}`)
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8')
  log(`started by "npm run dev" = ${pkg.scripts.dev}   compatibility flags: ${/nodejs_compat/.test(toml.replace(/#.*$/gm, '')) ? 'nodejs_compat' : 'none'}`)
  const t0 = Date.now()
  if (attach) log(`attached to a Worker that is already running at ${BASE}`)
  else await start()
  log(`the Worker answers after ${((Date.now() - t0) / 1000).toFixed(1)} s${attach ? '' : ' (including a start of wrangler dev)'}`)

  // ---- free routes first -------------------------------------------------------------------------------------------------------------------------
  log('')
  log('== free routes (before any paid request, on purpose)')
  const health = await get('/health')
  check(health.status === 200 && same(await health.json(), { ok: true }), '/health: 200 {"ok":true}')

  const status = (await (await get('/status')).json()) as { network: string; chainId: number; lens: { address: string; explorer: string }; payTo: string; price: string; facilitator: string; endpoints: Record<string, string>; lastSettlement: { transaction: string; payer: string } | null }
  verdict('/status: Mezo testnet, the payee from wrangler.toml, price $0.001, the lens, four paid routes', [
    ...(status.network === NETWORK && status.chainId === CHAIN_ID ? [] : [`network ${status.network} / ${status.chainId}`]),
    ...(status.payTo === DEFAULT_PAYEE ? [] : [`payTo ${status.payTo}`]),
    ...(status.price === '$0.001' ? [] : [`price ${status.price}`]),
    ...(/^0x[0-9a-fA-F]{40}$/.test(status.lens?.address ?? '') ? [] : ['no lens address']),
    ...(Object.keys(status.endpoints ?? {}).length === 4 ? [] : [`${Object.keys(status.endpoints ?? {}).length} paid routes`]),
  ])
  if (!attach) check(status.lastSettlement === null, 'a fresh Worker has settled nothing yet (/status lastSettlement is null)')

  const first = await get('/api/payments')
  const firstBody = (await first.json()) as { payments: { transaction: string; block: number; time: string; from: string; musd: string; explorer: string }[]; fetchedAt: string; stale: boolean; head: number; searchedFrom: number; cacheSeconds: number; payee: string; chainId: number }
  verdict(`/api/payments: 200, read from the chain, ${firstBody.payments?.length ?? '?'} payment(s) to the payee in blocks ${firstBody.searchedFrom}-${firstBody.head}, each with an exact amount, a time and an explorer link`, [
    ...(first.status === 200 ? [] : [`HTTP ${first.status}`]),
    ...(first.headers.get('cache-control') === 'public, max-age=30' ? [] : [`cache-control ${first.headers.get('cache-control')}`]),
    ...(firstBody.payee === status.payTo && firstBody.chainId === CHAIN_ID && firstBody.stale === false ? [] : ['payee, chain or stale flag is wrong']),
    ...firstBody.payments.filter((p) => !(/^0x[0-9a-f]{64}$/.test(p.transaction) && p.explorer === txUrl(p.transaction) && /^\d+(\.\d+)?$/.test(p.musd) && !Number.isNaN(Date.parse(p.time)) && /^0x[0-9a-fA-F]{40}$/.test(p.from))).map((p) => `bad row ${JSON.stringify(p).slice(0, 120)}`),
  ])
  const second = (await (await get('/api/payments')).json()) as { fetchedAt: string }
  check(second.fetchedAt === firstBody.fetchedAt, `a second call within ${firstBody.cacheSeconds} s is answered from the Worker's cache (same fetchedAt ${firstBody.fetchedAt})`)

  // ---- the console page -------------------------------------------------------------------------------------------------------------------------
  log('')
  log('== the console page')
  const pageRes = await get('/')
  const html = await pageRes.text()
  const csp = pageRes.headers.get('content-security-policy') ?? ''
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? ''
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!)
  verdict(`/: 200 HTML, ${html.length} bytes, a CSP that allows only its own inline script and style by hash`, [
    ...(pageRes.status === 200 && /^text\/html/.test(pageRes.headers.get('content-type') ?? '') ? [] : [`HTTP ${pageRes.status} ${pageRes.headers.get('content-type')}`]),
    ...(csp.startsWith("default-src 'none'; ") ? [] : [`CSP does not start with default-src 'none': ${csp.slice(0, 80)}`]),
    ...(script && csp.includes(`script-src ${sha(script)};`) ? [] : ['the script hash is not in the CSP']),
    ...(style && csp.includes(`style-src ${sha(style)};`) ? [] : ['the style hash is not in the CSP']),
    ...(/unsafe-|\*|https?:/.test(csp) ? [`CSP names an outside source or unsafe-*: ${csp}`] : []),
    ...(pageRes.headers.get('x-content-type-options') === 'nosniff' ? [] : ['no nosniff']),
  ])
  verdict('the page loads nothing from outside: one inline script, no script src, no link, image, frame, inline style attribute or event handler; every href is # or / or the explorer', [
    ...(html.match(/<script/g)?.length === 1 ? [] : ['not exactly one <script>']),
    ...(/<script[^>]*\ssrc=|<link|<img|<iframe|<object|<embed|\sstyle=|\son[a-z]+=/i.test(html) ? ['an outside resource, inline style attribute or event handler'] : []),
    ...hrefs.filter((h) => !(h.startsWith('#') || h.startsWith('/') || h.startsWith(`${EXPLORER}/`))).map((h) => `href ${h}`),
  ])
  verdict('the page says it is testnet, shows the payee and the lens as /status reports them, each with its explorer link', [
    ...(html.includes('Testnet only') && html.includes(String(CHAIN_ID)) ? [] : ['no "Testnet only" or chain id']),
    ...[status.payTo, status.lens.address].flatMap((a) => (html.includes(`>${a}</code>`) && html.includes(`href="${addressUrl(a as Address)}"`) ? [] : [`${a} is not shown with its explorer link`])),
    ...(status.lens.explorer === addressUrl(status.lens.address as Address) ? [] : ['the lens link in /status differs']),
  ])
  const blocks = [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => unescapeHtml(m[1]!))
  const mcpConfig = (() => {
    try {
      return JSON.parse(blocks[1] ?? '') as { mcpServers: { mezo: { env: Record<string, string> } } }
    } catch {
      return undefined
    }
  })()
  verdict(`the MCP example on the page names this host (${new URL(BASE).host}) and the same limits this script runs under`, [
    ...(mcpConfig?.mcpServers.mezo.env.MEZO_PAY_ALLOWED_HOSTS === new URL(BASE).host ? [] : [`allowed host ${mcpConfig?.mcpServers.mezo.env.MEZO_PAY_ALLOWED_HOSTS}`]),
    ...(mcpConfig?.mcpServers.mezo.env.MEZO_MAX_PER_CALL_MUSD === PER_CALL && mcpConfig?.mcpServers.mezo.env.MEZO_MAX_PER_SESSION_MUSD === PER_SESSION ? [] : ['limits differ']),
  ])

  // ---- the unpaid challenge ---------------------------------------------------------------------------------------------------------------------
  log('')
  log('== the 402 challenge')
  const trove = await troveFromTail(pub, 0, (await pub.getBlockNumber()) - 2n)
  const t1 = Date.now()
  const unpaid = await get(`/v1/trove/${trove}`)
  const ms = Date.now() - t1
  const header = unpaid.headers.get('payment-required')
  const challenge = header ? decodePaymentRequiredHeader(header) : undefined
  const offer = challenge?.accepts?.[0]
  verdict(`GET /v1/trove/<address> without payment: 402 in ${ms} ms, x402 v2, one "exact" offer of 0.001 MUSD on Mezo testnet to the payee, with gas sponsoring`, [
    ...(unpaid.status === 402 ? [] : [`HTTP ${unpaid.status}`]),
    ...(challenge?.x402Version === 2 && challenge.accepts.length === 1 ? [] : ['not v2 with exactly one offer']),
    ...(offer?.scheme === 'exact' && offer.network === NETWORK ? [] : [`scheme/network ${offer?.scheme} ${offer?.network}`]),
    ...(offer?.amount === PRICE.toString() ? [] : [`amount ${offer?.amount}`]),
    ...(offer?.asset.toLowerCase() === ADDRESSES.musd.toLowerCase() ? [] : [`asset ${offer?.asset}`]),
    ...(offer?.payTo === status.payTo ? [] : [`payTo ${offer?.payTo}`]),
    ...(JSON.stringify(challenge?.extensions ?? {}).includes('eip2612GasSponsoring') ? [] : ['no eip2612GasSponsoring extension']),
  ])
  check(html.includes(`<dt>Price per call</dt><dd>${formatUnits(BigInt(offer?.amount ?? 0), 18)} MUSD</dd>`), `the price on the page (${formatUnits(BigInt(offer?.amount ?? 0), 18)} MUSD) is the amount in the challenge`)
  const curlLine = /^curl -si .*/.exec(blocks[0] ?? '')?.[0]
  const curled = curlLine ? spawnSync('bash', ['-c', curlLine], { encoding: 'utf8', timeout: 30_000 }) : undefined
  const curledChallenge = (() => {
    try {
      return JSON.parse(curled?.stdout ?? '') as { x402Version: number; accepts: { payTo: string; amount: string }[] }
    } catch {
      return undefined
    }
  })()
  check(curledChallenge?.x402Version === 2 && curledChallenge.accepts[0]?.payTo === status.payTo && curledChallenge.accepts[0]?.amount === PRICE.toString(), 'the curl line printed on the page, run as written, prints the same challenge', [`stdout: ${(curled?.stdout ?? '').slice(0, 100)}`, `stderr: ${(curled?.stderr ?? '').slice(0, 100)}`])

  const bad = await get('/v1/trove/0x123')
  check(bad.status === 400 && bad.headers.get('payment-required') === null, `an invalid address is 400 and never a payment challenge (HTTP ${bad.status})`)
  const junk = await get(`/v1/trove/${trove}`, { headers: { 'payment-signature': 'not-a-payment' } })
  const junkBody = await junk.text()
  check(junk.status === 402 && !/collateral|debt|liquidation/i.test(junkBody), `a malformed PAYMENT-SIGNATURE header gets 402 and no data (HTTP ${junk.status})`)

  // ---- the MCP session: one real payment ---------------------------------------------------------------------------------------------------------
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp.ts'],
    cwd: ROOT,
    env: { ...getDefaultEnvironment(), MEZO_KEY_FILE: keyPaths().ops, MEZO_MAX_PER_CALL_MUSD: PER_CALL, MEZO_MAX_PER_SESSION_MUSD: PER_SESSION, MEZO_PAY_ALLOWED_HOSTS: new URL(BASE).host },
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
  const client = new Client({ name: 'worker-smoke', version: '0.0.0' })
  const call = async (name: string, args: Record<string, unknown>): Promise<Called> => {
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 150_000 })) as { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: unknown }
    said += JSON.stringify(r)
    return { isError: r.isError === true, text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), data: r.structuredContent ?? {} }
  }
  const startBlock = await pub.getBlockNumber()
  const payee = status.payTo as Address
  const before = await snapshot(payee)
  let settlementTx = ''
  try {
    log('')
    log('== the MCP server, as an agent host runs it')
    log(`buyer ${account.address}   payee ${payee}   limits ${PER_CALL} MUSD per call, ${PER_SESSION} MUSD in total; it may only call host ${new URL(BASE).host}`)
    log(`MUSD before   buyer ${before.buyer}   payee ${before.payee}  (base units)`)
    await client.connect(transport)
    for (let i = 0; i < 100 && !stderr.includes('"mcp-ready"'); i++) await sleep(100)
    const { tools } = await client.listTools()
    said += JSON.stringify(tools)
    check(same(tools.map((t) => t.name).sort(), TOOLS), `tools/list returns the five tools: ${tools.map((t) => t.name).sort().join(', ')}`)

    // The refusal first: it must cost nothing and never reach the Worker. `localhost` is the same machine but not the listed host.
    const walletBefore = await snapshot(payee)
    const refused = await call('pay_and_fetch', { url: `http://localhost:${PORT}/v1/trove/${trove}` })
    const walletAfter = await snapshot(payee)
    check(refused.isError && /not on the allow list/.test(refused.text) && /nothing was paid/.test(refused.text), `a host that is not on the allow list is refused: "${refused.text.slice(0, 110)}"`)
    check(walletBefore.buyer === walletAfter.buyer && walletBefore.payee === walletAfter.payee, 'the refusal moved no MUSD')

    if (noPay) log('SKIPPED  the paid call (--no-pay)')
    else {
      log('')
      log('== one paid call through the MCP server')
      const paid = await call('pay_and_fetch', { url: `${BASE}/v1/trove/${trove}` })
      settlementTx = String(paid.data.settlement?.transaction ?? '')
      verdict('pay_and_fetch on the Worker: status 200, paid, 0.001 MUSD authorised, a settlement transaction, paid by the buyer, spend 0.001', [
        ...(paid.isError ? [`tool error: ${paid.text.slice(0, 240)}`] : []),
        ...(paid.data.status === 200 && paid.data.paid === true && paid.data.authorizedMusd === '0.001' && /^0x[0-9a-fA-F]{64}$/.test(settlementTx) ? [] : [`unexpected answer: ${JSON.stringify({ status: paid.data.status, paid: paid.data.paid, authorizedMusd: paid.data.authorizedMusd, unsettled: paid.data.unsettled, settlement: paid.data.settlement }).slice(0, 300)}`]),
        ...(String(paid.data.settlement?.payer).toLowerCase() === account.address.toLowerCase() ? [] : [`the payer is ${paid.data.settlement?.payer}`]),
        ...(paid.data.spend?.spentMusd === '0.001' ? [] : [`spent ${paid.data.spend?.spentMusd}`]),
      ])
      check(String(paid.data.json?.borrower).toLowerCase() === trove.toLowerCase() && paid.data.json?.status === 'active', 'the paid answer is the health of the requested trove (borrower matches, status active)')
      if (settlementTx) log(`    settlement ${settlementTx}   ${txUrl(settlementTx)}`)
    }
  } finally {
    await client.close().catch(() => undefined)
  }

  if (settlementTx) {
    log('')
    log('== what really happened')
    const after = await snapshot(payee)
    log(`MUSD after    buyer ${after.buyer}   payee ${after.payee}  (base units)`)
    check(before.buyer - after.buyer === PRICE && after.payee - before.payee === PRICE, `the buyer paid exactly ${PRICE} base units (0.001 MUSD) and the payee received exactly that (buyer ${before.buyer - after.buyer}, payee ${after.payee - before.payee})`)
    check(before.btc === after.btc && before.nonce === after.nonce, 'the buyer sent no transaction and spent no BTC: the facilitator paid the gas')
    const s = await settlementProblems(settlementTx, { buyer: account.address, payee, amount: PRICE, afterBlock: startBlock })
    verdict(`the explorer shows ${settlementTx.slice(0, 12)}...: status ok, block ${s.block}, sent by the facilitator (${s.sender.slice(0, 10)}...), MUSD buyer -> payee 0.001`, s.problems)
    const last = ((await (await get('/status')).json()) as { lastSettlement: { transaction: string; recovered: boolean } | null }).lastSettlement
    check(last?.transaction.toLowerCase() === settlementTx.toLowerCase(), `/status reports this transaction as the last settlement (the Worker kept it from one request to the next); recovered=${last?.recovered} (true would mean the facilitator reported a failure but the transfer was found on chain)`)

    // The list is cached, so the first answer may predate the payment: ask again until the cache expires and the chain is read afresh.
    let row: { transaction: string; musd: string; from: string; explorer: string } | undefined
    const polled = Date.now()
    for (;;) {
      const list = (await (await get('/api/payments')).json()) as { payments: { transaction: string; musd: string; from: string; explorer: string }[] }
      row = list.payments.find((p) => p.transaction.toLowerCase() === settlementTx.toLowerCase())
      if (row || Date.now() - polled > 90_000) break
      await sleep(5000)
    }
    const waited = Date.now() - polled
    check(row?.musd === '0.001' && row.from.toLowerCase() === account.address.toLowerCase() && row.explorer === txUrl(settlementTx), `/api/payments lists this payment (0.001 MUSD from the buyer, explorer link) ${(waited / 1000).toFixed(0)} s after the call; the list is cached for ${firstBody.cacheSeconds} s`, [`not found after ${waited} ms`])

  }

  // ---- nothing leaked, nothing left running -------------------------------------------------------------------------------------------------------
  log('')
  log('== clean-up')
  const keyHex = readKeyFile(keyPaths().ops).slice(2).toLowerCase()
  const wlog = wranglerLog()
  if (!attach) {
    // wrangler logs every request it serves. On this path my own requests and the page's curl line all get 402; only the buyer's paid retry may be a 200, and it comes last.
    const codes = [...wlog.matchAll(new RegExp(`GET /v1/trove/${trove} (\\d{3})`, 'gi'))].map((m) => m[1]!)
    const paidOnes = codes.filter((c) => c === '200').length
    check(settlementTx ? paidOnes === 1 && codes.slice(-2).join(' ') === '402 200' : paidOnes === 0, `wrangler's own request log for this trove address: ${codes.join(' ')} (${settlementTx ? 'exactly one request was served for payment, the buyer\'s 402 then 200 come last' : 'none was served for payment'})`)
  }
  const leaks = (t: string) => t.toLowerCase().includes(keyHex) || t.includes(keyPaths().ops)
  check(!leaks(said) && !leaks(stderr) && !leaks(wlog) && !said.includes(homedir()), 'nothing the MCP server said, its stderr or the Worker\'s own output contains the private key or the key file path')
  check(!/\bERROR\b|Uncaught|TypeError|ReferenceError/.test(wlog) || !!attach, `the Worker logged no error${attach ? ' (not checked: attached)' : ''}`, wlog.split('\n').filter((l) => /\bERROR\b|Uncaught|TypeError|ReferenceError/.test(l)).slice(0, 5).map(scrub))
  ok = true
} catch (e) {
  check(false, 'the run finished without an unexpected error', [scrub(String((e as Error)?.stack ?? e)).split('\n').slice(0, 6).join(' | ')])
} finally {
  if (!attach) {
    allStopped = await stop()
    check(allStopped, `wrangler dev was stopped (its own process group only) and ports ${PORT} and ${INSPECTOR} are free again`)
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
}

log('')
log(failures() === 0 && ok ? 'ALL CHECKS PASSED' : `${failures()} CHECK(S) FAILED`)
if (!noPay && !attach) save(OUT)
clearTimeout(watchdog)
process.exit(failures() === 0 && ok && allStopped ? 0 : 1)
