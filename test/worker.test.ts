// The Cloudflare Worker without a network: the entry file, the settings, the console page and the Worker's own routes, with the same offline
// stand-ins as the other tests (a fake facilitator, lens and chain). The real thing under workerd is checked by scripts/worker-smoke.ts.
import { decodePaymentRequiredHeader } from '@x402/core/http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { formatUnits } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.ts'
import { ADDRESSES, DEFAULT_PAYEE, EXPLORER, FACILITATOR_URL, RPC_URL } from '../src/config.ts'
import { PAID_ROUTES, consoleResponse } from '../src/console.ts'
import { createBuyer } from '../src/pay.ts'
import { SpendGuard } from '../src/spend.ts'
import * as entry from '../src/worker.ts'
import { PAYMENTS_TTL_MS, createWorker, settingsFrom, workerFor, type Env, type Settings, type WorkerDeps } from '../src/worker-app.ts'
import { LENS_ADDRESS, PAYEE, PRICE_BASE_UNITS, TROVE, fakeChain, fakeFacilitator, fakeLens, signatureOf, testAccount, txHash, zeroReader, type FakeFacilitator } from './helpers/x402.ts'

const HOST = 'worker.example.test'
const SETTINGS: Settings = { payTo: PAYEE, price: '$0.001', rpcUrl: 'https://rpc.example.test', facilitatorUrl: 'https://facilitator.example.test' }
const BUYER = '0xea2D4b92DDd760959BB1D8119430640885851A91'

afterEach(() => vi.restoreAllMocks())

/** The recovery side of fakeChain plus the one read the payments route adds (the time of a block). */
const quietChain = (transfers: Parameters<typeof fakeChain>[0] = []): NonNullable<WorkerDeps['chain']> => ({ ...fakeChain(transfers), getBlock: async () => ({ timestamp: 1_792_000_000n }) })

function world(o: { facilitator?: FakeFacilitator; chain?: WorkerDeps['chain']; now?: () => number; settings?: Partial<Settings> } = {}) {
  const facilitator = o.facilitator ?? fakeFacilitator()
  const worker = createWorker({ ...SETTINGS, ...o.settings }, { lens: fakeLens(), facilitator, chain: o.chain ?? quietChain(), recovery: { waitMs: 0 }, now: o.now })
  const get = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://${HOST}${path}`, init))
  const buyer = createBuyer({ account: testAccount(), chainReader: zeroReader, guard: SpendGuard.fromEnv({}), fetchImpl: (input, init) => worker.fetch(new Request(input as Request | string, init)) })
  return { worker, facilitator, get, buyer }
}

/** Counts how often the Worker asks the facilitator what it supports. */
function counting(f: FakeFacilitator, failFirst = 0) {
  const real = f.getSupported.bind(f)
  const seen = { supported: 0 }
  f.getSupported = async () => {
    if (++seen.supported <= failFirst) throw new Error('the facilitator is down')
    return real()
  }
  return seen
}

describe('settings', () => {
  it('default to the toolkit defaults, and the payee is written in checksum form', () => {
    expect(settingsFrom({})).toEqual({ payTo: DEFAULT_PAYEE, price: '$0.001', rpcUrl: RPC_URL, facilitatorUrl: FACILITATOR_URL })
    expect(settingsFrom({ PAYEE_ADDRESS: PAYEE.toLowerCase() }).payTo).toBe(PAYEE)
  })

  const bad: [Env, RegExp][] = [
    [{ PAYEE_ADDRESS: '0x123' }, /PAYEE_ADDRESS/],
    [{ PAYEE_ADDRESS: 'not an address' }, /PAYEE_ADDRESS/],
    ...['0', '$0', '$0.000', '0.001', '$-1', '$1e3', '$0.0000000000000000001', 'free', ''].map((PRICE): [Env, RegExp] => [{ PRICE }, /PRICE/]),
    [{ RPC_URL: 'ftp://rpc.example.test' }, /RPC_URL/],
    [{ RPC_URL: 'not a url' }, /RPC_URL/],
    [{ FACILITATOR_URL: 'javascript:alert(1)' }, /FACILITATOR_URL/],
  ]
  it.each(bad)('reject %j with a message that names the variable', (env, message) => {
    expect(() => settingsFrom(env)).toThrow(message)
  })

  it('are what wrangler.toml ships: valid, the documented four, the same payee and price as `npm run serve`, no key and no nodejs_compat', () => {
    const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
    const vars = Object.fromEntries([...(toml.split('[vars]')[1] ?? '').matchAll(/^([A-Z_]+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1]!, m[2]!]))
    expect(Object.keys(vars).sort()).toEqual(['FACILITATOR_URL', 'PAYEE_ADDRESS', 'PRICE', 'RPC_URL'])
    expect(settingsFrom(vars)).toEqual({ payTo: DEFAULT_PAYEE, price: '$0.001', rpcUrl: 'https://rpc.test.mezo.org', facilitatorUrl: 'https://facilitator.vativ.io' })
    expect(toml).toMatch(/^name\s*=\s*"mezo-agent-toolkit"/m)
    expect(toml).toMatch(/^main\s*=\s*"src\/worker\.ts"/m)
    expect(toml).not.toMatch(/nodejs_compat/)
    expect(toml.replace(/#.*$/gm, '')).not.toMatch(/key|secret|token/i) // comments excluded: they say that there is none
  })
})

describe('the entry file', () => {
  it('exports only the handler, because workerd refuses any other export of the entry module', () => {
    expect(Object.keys(entry)).toEqual(['default'])
  })

  it('keeps one app per set of settings, so the settlement memory lives as long as the isolate', () => {
    const env: Env = { PAYEE_ADDRESS: PAYEE }
    const first = workerFor(env)
    expect(workerFor({ ...env })).toBe(first)
    expect(workerFor({ ...env, PRICE: '$0.002' })).not.toBe(first)
  })

  it('serves the console from the settings it is given, and answers a bad setting with a 500 that names the variable and nothing more', async () => {
    const ok = await entry.default.fetch(new Request(`https://${HOST}/`), { PAYEE_ADDRESS: PAYEE, PRICE: '$0.0025' })
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain(`<dd><code class="addr">${PAYEE}</code>`)
    const bad = await entry.default.fetch(new Request(`https://${HOST}/`), { PRICE: 'free', RPC_URL: 'https://rpc.example.test/hunter2' })
    expect(bad.status).toBe(500)
    const body = (await bad.json()) as { error: string; detail: string }
    expect(body.error).toMatch(/misconfigured/)
    expect(body.detail).toMatch(/PRICE/)
    expect(JSON.stringify(body)).not.toContain('hunter2')
  })
})

describe('the console page', () => {
  it('allows exactly its own inline style and script, by hash, and loads nothing from outside', async () => {
    const res = await world().get('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    const html = await res.text()
    const csp = res.headers.get('content-security-policy')!
    const sha = (t: string) => `'sha256-${createHash('sha256').update(t).digest('base64')}'`
    expect(csp).toContain(`script-src ${sha(/<script>([\s\S]*?)<\/script>/.exec(html)![1]!)};`)
    expect(csp).toContain(`style-src ${sha(/<style>([\s\S]*?)<\/style>/.exec(html)![1]!)};`)
    expect(csp).toMatch(/^default-src 'none'; /)
    expect(csp).not.toMatch(/unsafe-|\*|https?:/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html).not.toMatch(/<script[^>]*\ssrc=|<link|<img|<iframe|<object|<embed|\sstyle=|\son[a-z]+=/i)
    for (const [, href] of html.matchAll(/href="([^"]*)"/g)) expect(href!.startsWith('#') || href!.startsWith('/') || href!.startsWith(`${EXPLORER}/`), href).toBe(true)
  })

  it('shows the price from the same parser that builds the challenge, so the page and the 402 cannot differ', async () => {
    for (const [price, shown, amount] of [['$0.001', '0.001', PRICE_BASE_UNITS], ['$0.0025', '0.0025', '2500000000000000']] as const) {
      const { get } = world({ settings: { price } })
      expect(await (await get('/')).text()).toContain(`<dt>Price per call</dt><dd>${shown} MUSD</dd>`)
      const offer = decodePaymentRequiredHeader((await get(`/v1/trove/${TROVE}`)).headers.get('payment-required')!).accepts[0]!
      expect(offer.amount).toBe(amount)
      expect(formatUnits(BigInt(offer.amount), 18)).toBe(shown)
      expect(offer.asset.toLowerCase()).toBe(ADDRESSES.musd.toLowerCase())
    }
  })

  it('names the testnet, the payee and the lens with explorer links, and says it is testnet only', async () => {
    const html = await (await world().get('/')).text()
    expect(html).toContain('Testnet only')
    expect(html).toContain('31611')
    for (const a of [PAYEE, LENS_ADDRESS]) {
      expect(html).toContain(`<code class="addr">${a}</code>`)
      expect(html).toContain(`href="${EXPLORER}/address/${a}"`)
    }
    expect(html).toContain('facilitator.example.test')
    expect(html).not.toMatch(/mainnet\.mezo|explorer\.mezo\.org/)
  })

  it('puts the host the page was opened on into the curl and MCP examples, with the same limits the MCP server defaults to', async () => {
    const html = await (await world().get('/')).text()
    const blocks = [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => m[1]!.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&'))
    expect(blocks[0]).toContain(`curl -si https://${HOST}/v1/trove/`)
    const mcp = JSON.parse(blocks[1]!) as { mcpServers: { mezo: { env: Record<string, string> } } }
    expect(mcp.mcpServers.mezo.env).toMatchObject({ MEZO_PAY_ALLOWED_HOSTS: HOST, MEZO_MAX_PER_CALL_MUSD: '0.01', MEZO_MAX_PER_SESSION_MUSD: '0.1' })
    expect(SpendGuard.fromEnv({}).snapshot()).toMatchObject({ perCallMusd: '0.01', perSessionMusd: '0.1' })
  })

  it('shows a curl example that works: its address is accepted and the request gets the 402 challenge it then decodes', async () => {
    const { get } = world()
    const html = await (await get('/')).text()
    const curl = /<pre><code>(curl -si [^<]*)<\/code><\/pre>/.exec(html)![1]!
    const path = /^curl -si https:\/\/[^/]+(\/v1\/trove\/\S+) \|/.exec(curl)![1]!
    const res = await get(path)
    expect(res.status).toBe(402)
    expect(decodePaymentRequiredHeader(res.headers.get('payment-required')!).x402Version).toBe(2)
  })

  it('gives every link a 44 px target class, in the markup and in the links the script adds, so a new link cannot be a small one by accident', async () => {
    const html = await (await world().get('/')).text()
    const links = [...html.matchAll(/<a ([^>]*)>/g)].map((m) => m[1]!)
    expect(links.length).toBeGreaterThanOrEqual(6)
    for (const attrs of links) expect(attrs, attrs).toMatch(/class="(touch|skip)"/) // the skip link is 49 px high by its own padding
    expect(html).toContain("a.className = 'touch'")
  })

  it('lists the paid routes exactly as /status does', async () => {
    const status = (await (await createApp({ lens: fakeLens(), payTo: PAYEE, facilitator: fakeFacilitator() }).request('/status')).json()) as { endpoints: Record<string, string> }
    expect(PAID_ROUTES).toEqual(status.endpoints)
  })

  it('escapes what it prints', async () => {
    const res = await consoleResponse({ origin: `https://${HOST}`, network: 'eip155:31611', chainId: 31611, priceMusd: '0.001', payee: PAYEE, lens: LENS_ADDRESS, facilitatorHost: '<b>f</b>', endpoints: { '<i>route</i>': '<script>alert(1)</script>' } })
    const html = await res.text()
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<b>f</b>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('loads without the facilitator and without the chain', async () => {
    const f = fakeFacilitator()
    const seen = counting(f, 99)
    const res = await world({ facilitator: f }).get('/')
    expect(res.status).toBe(200)
    expect(seen.supported).toBe(0)
  })
})

describe('the paid endpoint inside the Worker', () => {
  it('works whatever request came first: the facilitator is asked once, by that request, and the paid app gets the answer as a plain value', async () => {
    // Regression, found under workerd: building the app inside a request that ended before the facilitator answered left every later paid request hanging.
    const f = fakeFacilitator()
    const seen = counting(f)
    const { get } = world({ facilitator: f })
    expect(await (await get('/health')).json()).toEqual({ ok: true })
    expect(seen.supported).toBe(1)
    const res = await get(`/v1/trove/${TROVE}`)
    expect(res.status).toBe(402)
    expect(decodePaymentRequiredHeader(res.headers.get('payment-required')!).accepts[0]).toMatchObject({ amount: PRICE_BASE_UNITS, payTo: PAYEE })
    expect((await get('/status')).status).toBe(200)
    expect(seen.supported).toBe(1)
  })

  it('survives the workerd rule that a fetch still pending when its request ends is canceled for good', async () => {
    // Emulated: a "supported" call that has not answered by the time the test says the first request is over never answers. Before the fix the app was built
    // by that first request without waiting, so the answer died with it and every later paid request hung (seen under `wrangler dev`).
    let over = false
    const f = fakeFacilitator()
    const real = f.getSupported.bind(f)
    f.getSupported = () => new Promise((resolve) => setTimeout(() => (over ? undefined : void real().then(resolve)), 20))
    const { get } = world({ facilitator: f })
    expect((await get('/health')).status).toBe(200)
    over = true
    const later = get(`/v1/trove/${TROVE}`)
    const hung = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the paid request hung')), 1_000))
    expect((await Promise.race([later, hung])).status).toBe(402)
  })

  it('does not ask the facilitator for the page, the payments or the favicon', async () => {
    const f = fakeFacilitator()
    const seen = counting(f, 99)
    const { get } = world({ facilitator: f })
    for (const path of ['/', '/api/payments', '/favicon.ico']) expect((await get(path)).status, path).not.toBe(500)
    expect(seen.supported).toBe(0)
  })

  it('answers 502 while the facilitator is down, keeps the page up, and recovers by itself (nothing is poisoned)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakeFacilitator()
    counting(f, 2)
    const { get } = world({ facilitator: f })
    for (const path of ['/health', `/v1/trove/${TROVE}`]) {
      const down = await get(path)
      expect(down.status, path).toBe(502)
      expect(((await down.json()) as { error: string }).error).toMatch(/facilitator/)
    }
    expect((await get('/')).status).toBe(200)
    expect(warn).toHaveBeenCalledTimes(2)
    expect((await get('/health')).status).toBe(200)
    expect((await get(`/v1/trove/${TROVE}`)).status).toBe(402)
  })

  it('builds one app when several first requests arrive together, and never asks again afterwards', async () => {
    const f = fakeFacilitator()
    const seen = counting(f)
    const { get, buyer } = world({ facilitator: f, chain: quietChain([{ hash: txHash(0xabc), value: BigInt(PRICE_BASE_UNITS), input: () => `0xfa340378${signatureOf(f.payloads.at(-1)!).slice(2)}` }]) })
    const first = await Promise.all([get('/health'), get('/status'), get(`/v1/trove/${TROVE}`)])
    expect(first.map((r) => r.status)).toEqual([200, 200, 402])
    const asked = seen.supported
    expect(asked).toBeLessThanOrEqual(3)
    // One app means one settlement memory: the payment made now is the one /status reports, from a different request.
    const paid = await buyer.fetchPaid(`https://${HOST}/v1/trove/${TROVE}`)
    expect(paid).toMatchObject({ status: 200, paid: true })
    const status = (await (await get('/status')).json()) as { lastSettlement: { transaction: string } | null }
    expect(status.lastSettlement?.transaction).toBe(paid.settlement?.transaction)
    expect(seen.supported).toBe(asked)
  })

  it('checks every settlement on the chain it was given: a reported success that is not on chain serves no data', async () => {
    const { buyer, facilitator } = world({ chain: quietChain([]) })
    const r = await buyer.fetchPaid(`https://${HOST}/v1/trove/${TROVE}`)
    expect(facilitator.settles).toBe(1)
    expect(r).toMatchObject({ status: 402, paid: false })
    expect(r.json).not.toHaveProperty('blockNumber')
  })

  it('pays to the configured payee', async () => {
    const other = '0x1111111111111111111111111111111111111111'
    const { get } = world({ settings: { payTo: other } })
    expect(decodePaymentRequiredHeader((await get(`/v1/trove/${TROVE}`)).headers.get('payment-required')!).accepts[0]!.payTo).toBe(other)
  })

  it('answers a bad address with 400 before any payment challenge, and an unknown path with 404', async () => {
    const { get } = world()
    const bad = await get('/v1/trove/0x123')
    expect(bad.status).toBe(400)
    expect(bad.headers.get('payment-required')).toBeNull()
    expect((await get('/nope')).status).toBe(404)
  })
})

describe('the payments route', () => {
  function ledger(o: { failing?: () => boolean } = {}) {
    const reads = { logs: 0 }
    const chain = {
      async getBlockNumber() {
        if (o.failing?.()) throw new Error('rpc failed at https://rpc.example.test/secret-path')
        return 5_000n
      },
      async getLogs() {
        reads.logs++
        return [{ transactionHash: txHash(7), blockNumber: 4_990n, logIndex: 0, args: { from: BUYER, value: 10n ** 15n } }]
      },
      async getBlock() {
        return { timestamp: 1_792_000_000n }
      },
      async getTransaction() {
        throw new Error('unused')
      },
    } as unknown as NonNullable<WorkerDeps['chain']>
    return { chain, reads }
  }
  const clock = () => {
    const t = { ms: 1_800_000_000_000 }
    return { t, now: () => t.ms }
  }

  it('returns the payments from the chain as JSON with explorer links and a short public cache', async () => {
    const { chain } = ledger()
    const res = await world({ chain }).get('/api/payments')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=30')
    const body = (await res.json()) as { payments: { transaction: string; musd: string; from: string; explorer: string; time: string }[]; stale: boolean; cacheSeconds: number; chainId: number; payee: string }
    expect(body).toMatchObject({ stale: false, cacheSeconds: PAYMENTS_TTL_MS / 1000, chainId: 31611, payee: PAYEE })
    expect(body.payments).toEqual([{ transaction: txHash(7), block: 4_990, time: new Date(1_792_000_000_000).toISOString(), from: BUYER, musd: '0.001', explorer: `${EXPLORER}/tx/${txHash(7)}` }])
  })

  it('reads the chain at most once per window, then again after it', async () => {
    const { chain, reads } = ledger()
    const { t, now } = clock()
    const { get } = world({ chain, now })
    const a = (await (await get('/api/payments')).json()) as { fetchedAt: string }
    t.ms += PAYMENTS_TTL_MS - 1
    const b = (await (await get('/api/payments')).json()) as { fetchedAt: string }
    expect(reads.logs).toBe(1)
    expect(b.fetchedAt).toBe(a.fetchedAt)
    t.ms += 2
    const c = (await (await get('/api/payments')).json()) as { fetchedAt: string }
    expect(reads.logs).toBe(2)
    expect(c.fetchedAt).not.toBe(a.fetchedAt)
  })

  it('serves the last good answer, marked stale, when the chain cannot be read, and recovers', async () => {
    let failing = false
    const { chain } = ledger({ failing: () => failing })
    const { t, now } = clock()
    const { get } = world({ chain, now })
    const good = (await (await get('/api/payments')).json()) as { payments: unknown[]; fetchedAt: string }
    t.ms += PAYMENTS_TTL_MS + 1
    failing = true
    const stale = (await (await get('/api/payments')).json()) as { payments: unknown[]; fetchedAt: string; stale: boolean }
    expect(stale).toMatchObject({ stale: true, fetchedAt: good.fetchedAt, payments: good.payments })
    failing = false
    expect(((await (await get('/api/payments')).json()) as { stale: boolean }).stale).toBe(false)
  })

  it('says 502 with no detail when there is nothing to serve, so a chain error cannot leak the RPC address', async () => {
    const { chain } = ledger({ failing: () => true })
    const res = await world({ chain }).get('/api/payments')
    expect(res.status).toBe(502)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const text = await res.text()
    expect(text).toMatch(/could not be read/)
    expect(text).not.toMatch(/rpc\.example|secret-path/)
  })
})
