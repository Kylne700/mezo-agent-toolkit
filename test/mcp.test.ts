// The MCP server end to end without a network: a real MCP client talks to the server over an in-memory pipe (and once over real stdio),
// with a fake lens behind the read tools and the paying world of test/helpers behind pay_and_fetch.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { InputError } from '../src/inputs.ts'
import { buyerFromEnv, DEFAULT_PAY_HOSTS, LIVE_HOSTS, payHosts, veFromEnv } from '../src/mcp-env.ts'
import { createMcpServer, type McpOptions } from '../src/mcp-server.ts'
import { checkUrl } from '../src/pay.ts'
import type { Sp } from '../src/sp-actions.ts'
import type { Trove } from '../src/trove-actions.ts'
import type { Outcome, Ve } from '../src/ve-actions.ts'
import { pool, veWorld } from './helpers/ve.ts'
import { TROVE, fakeLens, payWorld, zeroReader } from './helpers/x402.ts'

interface ToolReply {
  isError?: boolean
  content: { type: string; text: string }[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structuredContent?: any
}

const open: Client[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()))
})

async function connect(o: McpOptions) {
  const server = createMcpServer(o)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(a), client.connect(b)])
  open.push(client)
  return client
}
const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<ToolReply>

const url = `http://app.test/v1/trove/${TROVE}`

describe('tools', () => {
  it('are exactly the five promised ones, and pay_and_fetch takes a url and nothing else', async () => {
    const client = await connect({ lens: fakeLens(), buyer: payWorld().buyer })
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['trove_health', 'redemption_risk', 'pool_quote', 've_locks', 'pay_and_fetch'].sort())
    const pay = tools.find((t) => t.name === 'pay_and_fetch')!
    expect(Object.keys(pay.inputSchema.properties ?? {})).toEqual(['url']) // no amount, no limit, no method to talk the server into
    expect(pay.inputSchema.required).toEqual(['url'])
    expect(pay.description).toMatch(/at most 0\.01 MUSD per call and 0\.1 MUSD in total/)
    expect(pay.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    for (const t of tools.filter((x) => x.name !== 'pay_and_fetch')) expect(t.annotations?.readOnlyHint).toBe(true)
  })

  it('read tools answer with the lens data, as text and as structured content', async () => {
    const seen: unknown[] = []
    const lens = fakeLens({ poolQuote: (async (input: unknown) => (seen.push(input), { blockNumber: 5, ok: true })) as never })
    const client = await connect({ lens })
    for (const [name, args] of [
      ['trove_health', { address: TROVE }],
      ['redemption_risk', { address: TROVE }],
      ['ve_locks', { address: TROVE }],
    ] as const) {
      const r = await call(client, name, args)
      expect(r.isError).toBeFalsy()
      expect(r.structuredContent).toMatchObject({ blockNumber: 123, chainId: 31611 })
      expect(JSON.parse(r.content[0]!.text)).toEqual(r.structuredContent)
    }
    const q = await call(client, 'pool_quote', { tokenIn: 'btc', tokenOut: 'musd', amountIn: ' 0.001 ', stable: false })
    expect(q.structuredContent).toEqual({ blockNumber: 5, ok: true })
    expect(seen).toEqual([{ tokenIn: 'BTC', tokenOut: 'MUSD', amountIn: '0.001', stable: false }]) // same parsers as the HTTP routes: normalised before the lens sees them
  })

  it('turn bad input into a tool error and never ask the lens', async () => {
    let asked = 0
    const count = async () => (asked++, {})
    const client = await connect({ lens: fakeLens({ troveHealth: count as never, poolQuote: count as never, veLocks: count as never, redemptionRisk: count as never }) })
    for (const [name, args] of [
      ['trove_health', { address: 'nope' }],
      ['redemption_risk', { address: '0x123' }],
      ['ve_locks', { address: '' }],
      ['pool_quote', { tokenIn: 'DOGE', tokenOut: 'MUSD', amountIn: '1' }],
      ['pool_quote', { tokenIn: 'BTC', tokenOut: 'MUSD', amountIn: '1e18' }],
      ['pool_quote', { tokenIn: 'BTC', tokenOut: 'MUSD', amountIn: '0' }],
    ] as const) {
      const r = await call(client, name, args)
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true)
      expect(r.content[0]!.text.length).toBeGreaterThan(10)
    }
    expect(asked).toBe(0)
  })

  it('turn a chain failure into a tool error and keep serving', async () => {
    const client = await connect({ lens: fakeLens({ troveHealth: (async () => Promise.reject(Object.assign(new Error('long'), { shortMessage: 'execution reverted' }))) as never }) })
    const bad = await call(client, 'trove_health', { address: TROVE })
    expect(bad.isError).toBe(true)
    expect(bad.content[0]!.text).toBe('chain read failed, try again: execution reverted')
    expect((await call(client, 've_locks', { address: TROVE })).isError).toBeFalsy()
  })
})

describe('pay_and_fetch', () => {
  it('pays within the limits and returns the data with the settlement and the spend so far', async () => {
    const w = payWorld()
    const r = await call(await connect({ lens: fakeLens(), buyer: w.buyer }), 'pay_and_fetch', { url })
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toMatchObject({ status: 200, ok: true, paid: true, authorizedMusd: '0.001', json: { blockNumber: 123 }, spend: { spentMusd: '0.001', payments: 1 } })
    expect(r.structuredContent.settlement.transaction).toMatch(/^0x[0-9a-f]{64}$/)
    expect(r.structuredContent.body).toBeUndefined() // the parsed json is returned once, not twice
    expect(w.facilitator.settles).toBe(1)
  })

  it('refuses a price over the per-call limit: an error that says nothing was paid, and nothing signed', async () => {
    const w = payWorld({ price: '$0.05', perCall: '0.01' })
    const r = await call(await connect({ lens: fakeLens(), buyer: w.buyer }), 'pay_and_fetch', { url })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ refused: true, reason: 'the price is over the per-call limit of 0.01 MUSD', spend: { spentMusd: '0', payments: 0 } })
    expect(r.content[0]!.text).toMatch(/^Refused, nothing was paid/)
    expect(w.facilitator.verifies + w.facilitator.settles).toBe(0)
  })

  it('refuses the call that would pass the session limit', async () => {
    const w = payWorld({ perCall: '0.001', perSession: '0.001' })
    const client = await connect({ lens: fakeLens(), buyer: w.buyer })
    expect((await call(client, 'pay_and_fetch', { url })).isError).toBeFalsy()
    const second = await call(client, 'pay_and_fetch', { url })
    expect(second.isError).toBe(true)
    expect(second.structuredContent).toMatchObject({ refused: true, spend: { spentMusd: '0.001', remainingMusd: '0', payments: 1 } })
    expect(second.structuredContent.reason).toMatch(/session limit of 0\.001 MUSD/)
    expect(w.facilitator.settles).toBe(1)
  })

  it('lets exactly one of two simultaneous calls spend the last of the session limit', async () => {
    const w = payWorld({ perCall: '0.001', perSession: '0.001' })
    const client = await connect({ lens: fakeLens(), buyer: w.buyer })
    const both = await Promise.all([call(client, 'pay_and_fetch', { url }), call(client, 'pay_and_fetch', { url })])
    expect(both.filter((r) => !r.isError)).toHaveLength(1)
    const refused = both.filter((r) => r.isError)
    expect(refused).toHaveLength(1)
    expect(refused[0]!.structuredContent).toMatchObject({ refused: true })
    expect(w.facilitator.settles).toBe(1)
  })

  it('says a payment may still have been charged when the connection drops after it was sent', async () => {
    const w = payWorld({ wrap: (real) => (input, init) => ((input as Request).headers?.has('payment-signature') ? Promise.reject(new TypeError('fetch failed')) : real(input, init)) })
    const r = await call(await connect({ lens: fakeLens(), buyer: w.buyer }), 'pay_and_fetch', { url })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ status: 0, paid: false, unsettled: { reason: 'request_failed' }, spend: { spentMusd: '0.001' } })
    expect(r.structuredContent.warning).toMatch(/may still have been charged: check the buyer's MUSD balance/)
  })

  it('reports an unusable url or a host that is not allowed as an error that says nothing was paid', async () => {
    const w = payWorld({ allowedHosts: ['app.test'] })
    const client = await connect({ lens: fakeLens(), buyer: w.buyer })
    const at = '@' // spelled out so the privacy check does not read the test URL as an email address
    for (const bad of ['ftp://app.test/x', 'not a url', 'http://evil.test/x', `http://user:pw${at}app.test/x`]) {
      const r = await call(client, 'pay_and_fetch', { url: bad })
      expect(r.isError, bad).toBe(true)
      expect(r.structuredContent, bad).toMatchObject({ refused: false, spend: { payments: 0 } })
      expect(r.content[0]!.text).toMatch(/nothing was paid/)
    }
    expect(w.calls).toEqual([])
  })

  it('is switched off without a wallet, says why, and leaves the read tools working', async () => {
    const client = await connect({ lens: fakeLens(), payOffReason: 'no wallet is configured (the operator sets MEZO_KEY_FILE)' })
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === 'pay_and_fetch')!.description).toMatch(/Currently switched off: no wallet is configured/)
    const r = await call(client, 'pay_and_fetch', { url })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ refused: true })
    expect(r.content[0]!.text).toMatch(/switched off.*MEZO_KEY_FILE/)
    expect((await call(client, 'trove_health', { address: TROVE })).isError).toBeFalsy()
  })
})

describe('buyerFromEnv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mezo-mcp-'))
  const key = generatePrivateKey()
  const keyFile = join(dir, 'k.key')
  writeFileSync(keyFile, key, { mode: 0o600 })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('stays off without a key file', () => {
    const r = buyerFromEnv({}, zeroReader)
    expect(r.buyer).toBeUndefined()
    expect(r.offReason).toMatch(/MEZO_KEY_FILE/)
  })

  it('fails closed on limits that do not parse or contradict each other, instead of using the defaults', () => {
    for (const env of [{ MEZO_MAX_PER_CALL_MUSD: 'abc' }, { MEZO_MAX_PER_SESSION_MUSD: '1e3' }, { MEZO_MAX_PER_CALL_MUSD: '' }, { MEZO_MAX_PER_CALL_MUSD: '5', MEZO_MAX_PER_SESSION_MUSD: '1' }, { MEZO_MAX_PER_CALL_MUSD: '0' }]) {
      const r = buyerFromEnv({ MEZO_KEY_FILE: keyFile, ...env }, zeroReader)
      expect(r.buyer, JSON.stringify(env)).toBeUndefined()
      expect(r.offReason).toMatch(/spend limits are not valid, so payments stay off/)
    }
  })

  it('does not echo the path or the key when the key file is missing or wrong', () => {
    const missing = buyerFromEnv({ MEZO_KEY_FILE: join(dir, 'missing.key') }, zeroReader)
    expect(missing.buyer).toBeUndefined()
    expect(missing.offReason).toMatch(/cannot read the key file/)
    expect(missing.offReason).not.toContain(dir)
    const junk = join(dir, 'junk.key')
    writeFileSync(junk, 'not a key at all', { mode: 0o600 })
    const bad = buyerFromEnv({ MEZO_KEY_FILE: junk }, zeroReader)
    expect(bad.offReason).toMatch(/does not hold a 32-byte hex private key/)
    expect(bad.offReason).not.toContain('not a key at all')
  })

  it('builds a buyer from a good key file and the limits, with the default limits when none are given', () => {
    const a = buyerFromEnv({ MEZO_KEY_FILE: keyFile }, zeroReader)
    expect(a.buyer?.address).toBe(privateKeyToAccount(key).address)
    expect(a.buyer?.guard.snapshot()).toMatchObject({ perCallMusd: '0.01', perSessionMusd: '0.1' })
    const b = buyerFromEnv({ MEZO_KEY_FILE: keyFile, MEZO_MAX_PER_CALL_MUSD: '0.002', MEZO_MAX_PER_SESSION_MUSD: '0.004' }, zeroReader)
    expect(b.buyer?.guard.snapshot()).toMatchObject({ perCallMusd: '0.002', perSessionMusd: '0.004' })
  })

  it('applies the host allow list', async () => {
    const r = buyerFromEnv({ MEZO_KEY_FILE: keyFile, MEZO_PAY_ALLOWED_HOSTS: ' a.test , b.test ' }, zeroReader)
    await expect(r.buyer!.fetchPaid('http://evil.test/')).rejects.toThrow(/not on the allow list/)
  })

  it('allows only our own endpoint when the allow list is unset or blank, never any host', async () => {
    for (const hosts of [undefined, ' , ']) {
      const r = buyerFromEnv({ MEZO_KEY_FILE: keyFile, MEZO_PAY_ALLOWED_HOSTS: hosts }, zeroReader)
      // Port 9 is closed here: without the default these would be real requests and fail with a connection error instead.
      for (const u of ['http://127.0.0.1:9/', 'http://localhost:9/']) await expect(r.buyer!.fetchPaid(u), `${hosts} ${u}`).rejects.toThrow(/not on the allow list/)
    }
  })

  it('adding the deployed Worker is one line: a host in LIVE_HOSTS is allowed, an unlisted one is not, and the shipped list is well formed', () => {
    const live = 'mezo-agent-toolkit.example.workers.dev'
    const url = `https://${live}/v1/trove/${TROVE}`
    expect(() => checkUrl(url, payHosts([]))).toThrow(/not on the allow list/)
    expect(checkUrl(url, payHosts([live]))).toBe(url)
    expect(() => checkUrl(`https://evil.${live}/`, payHosts([live]))).toThrow(/not on the allow list/) // no wildcard: an exact host only
    expect(payHosts([]).slice(0, 2)).toEqual(['127.0.0.1:8402', 'localhost:8402'])
    // Whatever is shipped (empty today) must be bare host names, or the line would silently allow nothing; it is also what the default allows.
    for (const h of LIVE_HOSTS) expect(h, 'LIVE_HOSTS entries are host names like abc.workers.dev, without https:// or a path').toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/)
    expect(DEFAULT_PAY_HOSTS).toEqual(payHosts(LIVE_HOSTS))
    expect(DEFAULT_PAY_HOSTS).not.toContain('*')
  })
})

const READS = ['trove_health', 'redemption_risk', 'pool_quote', 've_locks', 'pay_and_fetch']
const VE_READS = ['ve_status', 'gauge_rewards']
const VE_WRITES = ['ve_approve_btc', 've_lock', 've_vote', 've_poke', 've_claim_rewards', 've_claim_rebase']
const HASH = `0x${'ab'.repeat(32)}` as const
const mined: Outcome = { sent: true, hash: HASH, status: 'success', explorer: `https://explorer.test.mezo.org/tx/${HASH}`, blockNumber: '5', gasUsed: '21000', tokenId: '1900' }
/** A Ve whose six writers record what they were given and answer with `next()`. */
function stubVe(next: () => Promise<Outcome> = async () => mined, seen: [string, unknown][] = []): Ve {
  const via = (name: string) => (input: unknown) => (seen.push([name, input]), next())
  return {
    status: async (i) => ({ blockNumber: 7, tokenId: i?.tokenId ?? null }),
    rewards: async (i) => ({ blockNumber: 7, tokenId: i?.tokenId ?? null, pools: [] }),
    write: { approveBtc: via('approveBtc'), lock: via('lock'), vote: via('vote'), poke: via('poke'), claimRewards: via('claimRewards'), claimRebase: via('claimRebase') },
  }
}

describe('the ve tools', () => {
  const listTools = async (ve?: Ve) => (await (await connect({ lens: fakeLens(), ve })).listTools()).tools

  it('ve_status and gauge_rewards come with ve; the six sending tools only when ve.write exists, and none takes a key, cap or gas argument', async () => {
    expect((await listTools()).map((t) => t.name).sort()).toEqual([...READS].sort())
    const readsOnly = await listTools({ ...stubVe(), write: undefined })
    expect(readsOnly.map((t) => t.name).sort()).toEqual([...READS, ...VE_READS].sort())
    for (const t of readsOnly.filter((x) => x.name !== 'pay_and_fetch')) expect(t.annotations?.readOnlyHint, t.name).toBe(true)

    const all = await listTools(stubVe())
    expect(all.map((t) => t.name).sort()).toEqual([...READS, ...VE_READS, ...VE_WRITES].sort())
    for (const n of VE_WRITES) expect(all.find((t) => t.name === n)!.annotations, n).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false })
    const props = (n: string) => Object.keys(all.find((t) => t.name === n)!.inputSchema.properties ?? {})
    expect(props('ve_approve_btc')).toEqual(['amount'])
    expect(props('ve_lock')).toEqual(['amount', 'days'])
    expect(props('ve_vote')).toEqual(['tokenId', 'pools'])
    for (const n of ['ve_poke', 've_claim_rewards', 've_claim_rebase', 've_status', 'gauge_rewards']) expect(props(n), n).toEqual(['tokenId'])

    const withWrites = (await connect({ lens: fakeLens(), ve: stubVe() })).getInstructions()
    expect(withWrites).toMatch(/Six more tools \(ve_approve_btc, ve_lock, ve_vote, ve_poke, ve_claim_rewards, ve_claim_rebase\) send real testnet transactions/)
    expect((await connect({ lens: fakeLens(), ve: { ...stubVe(), write: undefined } })).getInstructions()).not.toMatch(/ve_approve_btc/)
  })

  it('the two reads answer as text and as structured content, with the token id passed on', async () => {
    const client = await connect({ lens: fakeLens(), ve: stubVe() })
    for (const name of VE_READS) {
      const r = await call(client, name, { tokenId: '1727' })
      expect(r.isError, name).toBeFalsy()
      expect(r.structuredContent).toMatchObject({ blockNumber: 7, tokenId: '1727' })
      expect(JSON.parse(r.content[0]!.text)).toEqual(r.structuredContent)
    }
    expect((await call(client, 've_status')).structuredContent).toMatchObject({ tokenId: null })
  })

  it('maps every outcome the same way for each sending tool: success, refusal, reverted, no receipt, bad input, crash', async () => {
    const seen: [string, unknown][] = []
    let next: () => Promise<Outcome> = async () => mined
    const client = await connect({ lens: fakeLens(), ve: stubVe(() => next(), seen) })
    const args: Record<string, Record<string, unknown>> = {
      ve_approve_btc: { amount: '0.004' },
      ve_lock: { amount: '0.004', days: 28 },
      ve_vote: { tokenId: '1900', pools: [{ pool: pool(0), weight: 100 }] },
      ve_poke: { tokenId: '1900' },
      ve_claim_rewards: { tokenId: '1900' },
      ve_claim_rebase: { tokenId: '1900' },
    }
    for (const [name, a] of Object.entries(args)) {
      next = async () => mined
      const good = await call(client, name, a)
      expect(good.isError, name).toBeFalsy()
      expect(good.structuredContent, name).toMatchObject({ sent: true, status: 'success', hash: HASH, tokenId: '1900' })
      expect(JSON.parse(good.content[0]!.text)).toEqual(good.structuredContent)

      next = async () => ({ sent: false, reason: 'the kill file exists' })
      const refused = await call(client, name, a)
      expect(refused.isError, name).toBe(true)
      expect(refused.content[0]!.text).toBe('Refused, nothing was sent: the kill file exists')
      expect(refused.structuredContent).toEqual({ sent: false, reason: 'the kill file exists' })

      next = async () => ({ ...mined, status: 'reverted' }) as Outcome
      const reverted = await call(client, name, a)
      expect(reverted.isError, name).toBe(true)
      expect(reverted.structuredContent).toMatchObject({ sent: true, status: 'reverted', hash: HASH, warning: expect.stringMatching(/mined and reverted/) })

      next = async () => ({ ...mined, status: 'unknown', blockNumber: null, gasUsed: null }) as Outcome
      const unknown = await call(client, name, a)
      expect(unknown.isError, name).toBe(true)
      expect(unknown.structuredContent.warning).toMatch(/No receipt arrived in time.*Check the hash/)

      next = async () => Promise.reject(new InputError('days must be a whole number from 1 to 28'))
      expect(await call(client, name, a), name).toMatchObject({ isError: true, content: [{ type: 'text', text: 'days must be a whole number from 1 to 28' }] })

      next = async () => Promise.reject(Object.assign(new Error('a very long message'), { shortMessage: 'boom' }))
      const crash = await call(client, name, a)
      expect(crash.isError, name).toBe(true)
      expect(crash.content[0]!.text).toMatch(/^The tool failed \(boom\)\. If a transaction may have been sent, check the receipts file and the chain before trying again\.$/)
    }
    // Each tool handed the writer exactly its own arguments.
    expect(new Set(seen.map((s) => JSON.stringify(s)))).toEqual(new Set([
      JSON.stringify(['approveBtc', args.ve_approve_btc]), JSON.stringify(['lock', args.ve_lock]), JSON.stringify(['vote', args.ve_vote]),
      JSON.stringify(['poke', args.ve_poke]), JSON.stringify(['claimRewards', args.ve_claim_rewards]), JSON.stringify(['claimRebase', args.ve_claim_rebase]),
    ]))
  })

  it('drops arguments the schema does not list and rejects the wrong types before the writer sees anything', async () => {
    const seen: [string, unknown][] = []
    const client = await connect({ lens: fakeLens(), ve: stubVe(undefined, seen) })
    await call(client, 've_lock', { amount: '0.004', days: 28, maxFeePerGas: '999', keyFile: '/tmp/other.key', gas: 1 })
    expect(seen).toEqual([['lock', { amount: '0.004', days: 28 }]])
    const bad = await call(client, 've_lock', { amount: '0.004', days: 'many' }).then((r) => r.isError, () => true)
    expect(bad).toBe(true)
    expect(seen).toHaveLength(1)
  })
})

const TROVE_READS = ['plan_open', 'plan_top_up', 'plan_repay', 'trove_status']
const TROVE_WRITES = ['trove_open', 'trove_add_coll', 'trove_repay']
const WALLET = '0x00000000000000000000000000000000000000aa'
/** A Trove whose four planners answer with the call they got and whose three writers record their input and answer with `next()`. */
function stubTrove(next: () => Promise<Outcome> = async () => mined, seen: [string, unknown][] = [], plan: () => Promise<object> = async () => ({ refused: false, blockNumber: 9 })): Trove {
  const reads = (name: string) => (input: unknown) => (seen.push([name, input]), plan()) as never
  const via = (name: string) => (input: unknown) => (seen.push([name, input]), next())
  return { open: reads('open'), topUp: reads('topUp'), repay: reads('repay'), status: reads('status'), write: { open: via('write.open'), addColl: via('write.addColl'), repay: via('write.repay') } }
}

describe('the trove tools', () => {
  const listTools = async (trove?: Trove, ve?: Ve) => (await (await connect({ lens: fakeLens(), trove, ve })).listTools()).tools

  it('the four planners come with trove; the three sending tools only when trove.write exists, and none takes a key, cap, gas or address to send from', async () => {
    expect((await listTools()).map((t) => t.name).sort()).toEqual([...READS].sort())
    const readsOnly = await listTools({ ...stubTrove(), write: undefined })
    expect(readsOnly.map((t) => t.name).sort()).toEqual([...READS, ...TROVE_READS].sort())
    for (const t of readsOnly.filter((x) => x.name !== 'pay_and_fetch')) expect(t.annotations?.readOnlyHint, t.name).toBe(true)

    const all = await listTools(stubTrove(), stubVe())
    expect(all.map((t) => t.name).sort()).toEqual([...READS, ...VE_READS, ...VE_WRITES, ...TROVE_READS, ...TROVE_WRITES].sort())
    for (const n of TROVE_WRITES) expect(all.find((t) => t.name === n)!.annotations, n).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false })
    const props = (n: string) => Object.keys(all.find((t) => t.name === n)!.inputSchema.properties ?? {})
    expect(props('plan_open')).toEqual(['address', 'collateralBtc', 'debtMusd'])
    expect(props('plan_top_up')).toEqual(['address', 'amountBtc'])
    expect(props('plan_repay')).toEqual(['address', 'amountMusd'])
    expect(props('trove_status')).toEqual(['address'])
    expect(props('trove_open')).toEqual(['collateralBtc', 'debtMusd']) // the writers act for the operator's wallet only
    expect(props('trove_add_coll')).toEqual(['amountBtc'])
    expect(props('trove_repay')).toEqual(['amountMusd'])
    expect(all.find((t) => t.name === 'trove_open')!.description).toMatch(/Risky:.*MEZO_WRITE_RISKY=1/)

    const base = (await connect({ lens: fakeLens() })).getInstructions()
    expect(base).toMatch(/^Mezo testnet only\. 4 free read tools/)
    expect(base).not.toMatch(/trove_open/)
    const readsText = (await connect({ lens: fakeLens(), trove: { ...stubTrove(), write: undefined } })).getInstructions()
    expect(readsText).toMatch(/^Mezo testnet only\. 8 free read tools .*trove plans and status/)
    expect(readsText).not.toMatch(/trove_open/)
    const full = (await connect({ lens: fakeLens(), ve: stubVe(), trove: stubTrove() })).getInstructions()
    expect(full).toMatch(/^Mezo testnet only\. 10 free read tools/)
    expect(full).toMatch(/Six more tools \(ve_approve_btc, .*\) send real testnet transactions/)
    expect(full).toMatch(/Three more \(trove_open, trove_add_coll, trove_repay\) open a MUSD trove, add collateral and repay on the same guarded writer/)
  })

  it('the planners answer as text and as structured content with their arguments passed on; a refused plan is data, not an error', async () => {
    const seen: [string, unknown][] = []
    let plan: () => Promise<object> = async () => ({ refused: false, blockNumber: 9 })
    const client = await connect({ lens: fakeLens(), trove: stubTrove(undefined, seen, () => plan()) })
    const calls: [string, Record<string, unknown>][] = [
      ['plan_open', { address: WALLET, collateralBtc: '0.045', debtMusd: '1900' }],
      ['plan_top_up', { address: WALLET, amountBtc: '0.0003' }],
      ['plan_repay', { address: WALLET, amountMusd: '10' }],
      ['trove_status', { address: WALLET }],
    ]
    for (const [name, args] of calls) {
      const r = await call(client, name, args)
      expect(r.isError, name).toBeFalsy()
      expect(r.structuredContent).toEqual({ refused: false, blockNumber: 9 })
      expect(JSON.parse(r.content[0]!.text)).toEqual(r.structuredContent)
    }
    expect(seen).toEqual([['open', calls[0]![1]], ['topUp', calls[1]![1]], ['repay', calls[2]![1]], ['status', calls[3]![1]]])
    plan = async () => ({ refused: true, reason: 'the net debt would be under the minimum' })
    const refused = await call(client, 'plan_open', calls[0]![1])
    expect(refused.isError).toBeFalsy()
    expect(refused.structuredContent).toEqual({ refused: true, reason: 'the net debt would be under the minimum' })
  })

  it('turns bad input and a chain failure of a planner into tool errors and keeps serving', async () => {
    let plan: () => Promise<object> = () => Promise.reject(new InputError('collateralBtc must be a plain decimal'))
    const client = await connect({ lens: fakeLens(), trove: stubTrove(undefined, [], () => plan()) })
    expect(await call(client, 'plan_open', { address: WALLET, collateralBtc: 'x', debtMusd: '1900' })).toMatchObject({ isError: true, content: [{ type: 'text', text: 'collateralBtc must be a plain decimal' }] })
    plan = () => Promise.reject(Object.assign(new Error('a very long message'), { shortMessage: 'boom' }))
    expect(await call(client, 'trove_status', { address: WALLET })).toMatchObject({ isError: true, content: [{ type: 'text', text: 'chain read failed, try again: boom' }] })
    plan = async () => ({ ok: true })
    expect((await call(client, 'trove_status', { address: WALLET })).isError).toBeFalsy()
  })

  it('maps every outcome the same way for each sending tool: success, refusal, reverted, no receipt, bad input, crash', async () => {
    const seen: [string, unknown][] = []
    let next: () => Promise<Outcome> = async () => mined
    const client = await connect({ lens: fakeLens(), trove: stubTrove(() => next(), seen) })
    const args: Record<string, Record<string, unknown>> = {
      trove_open: { collateralBtc: '0.045', debtMusd: '1900' },
      trove_add_coll: { amountBtc: '0.0003' },
      trove_repay: { amountMusd: '10' },
    }
    for (const [name, a] of Object.entries(args)) {
      next = async () => mined
      const good = await call(client, name, a)
      expect(good.isError, name).toBeFalsy()
      expect(good.structuredContent, name).toMatchObject({ sent: true, status: 'success', hash: HASH })
      expect(JSON.parse(good.content[0]!.text)).toEqual(good.structuredContent)

      next = async () => ({ sent: false, reason: 'the net debt would be under the minimum' })
      const refused = await call(client, name, a)
      expect(refused.isError, name).toBe(true)
      expect(refused.content[0]!.text).toBe('Refused, nothing was sent: the net debt would be under the minimum')
      expect(refused.structuredContent).toEqual({ sent: false, reason: 'the net debt would be under the minimum' })

      next = async () => ({ ...mined, status: 'reverted' }) as Outcome
      const reverted = await call(client, name, a)
      expect(reverted.isError, name).toBe(true)
      expect(reverted.structuredContent).toMatchObject({ sent: true, status: 'reverted', hash: HASH, warning: expect.stringMatching(/mined and reverted/) })

      next = async () => ({ ...mined, status: 'unknown', blockNumber: null, gasUsed: null }) as Outcome
      const unknown = await call(client, name, a)
      expect(unknown.isError, name).toBe(true)
      expect(unknown.structuredContent.warning).toMatch(/No receipt arrived in time.*Check the hash/)

      next = async () => Promise.reject(new InputError('amountBtc must be a plain decimal'))
      expect(await call(client, name, a), name).toMatchObject({ isError: true, content: [{ type: 'text', text: 'amountBtc must be a plain decimal' }] })

      next = async () => Promise.reject(Object.assign(new Error('a very long message'), { shortMessage: 'boom' }))
      const crash = await call(client, name, a)
      expect(crash.isError, name).toBe(true)
      expect(crash.content[0]!.text).toMatch(/^The tool failed \(boom\)\. If a transaction may have been sent, check the receipts file and the chain before trying again\.$/)
    }
    // Each tool handed the writer exactly its own arguments.
    expect(new Set(seen.map((s) => JSON.stringify(s)))).toEqual(new Set([JSON.stringify(['write.open', args.trove_open]), JSON.stringify(['write.addColl', args.trove_add_coll]), JSON.stringify(['write.repay', args.trove_repay])]))
  })

  it('drops arguments the schema does not list (an address, a key file, a gas or a hint) and rejects the wrong types before the writer sees anything', async () => {
    const seen: [string, unknown][] = []
    const client = await connect({ lens: fakeLens(), trove: stubTrove(undefined, seen) })
    await call(client, 'trove_open', { collateralBtc: '0.045', debtMusd: '1900', address: WALLET, upperHint: WALLET, keyFile: '/tmp/other.key', gas: 1 })
    expect(seen).toEqual([['write.open', { collateralBtc: '0.045', debtMusd: '1900' }]])
    const bad = await call(client, 'trove_repay', { amountMusd: 10 }).then((r) => r.isError, () => true)
    expect(bad).toBe(true)
    expect(seen).toHaveLength(1)
  })
})

const SP_READS = ['sp_status', 'allowance_status', 'plan_sp_deposit']
const SP_WRITES = ['sp_approve_musd', 'sp_deposit', 'sp_withdraw', 'trove_liquidate', 'approve_revoke']
/** An Sp whose three readers answer with the call they got and whose five writers record their input and answer with `next()`. */
function stubSp(next: () => Promise<Outcome> = async () => mined, seen: [string, unknown][] = [], answer: () => Promise<object> = async () => ({ blockNumber: 9 })): Sp {
  const reads = (name: string) => (input: unknown) => (seen.push([name, input]), answer()) as never
  const via = (name: string) => (input: unknown) => (seen.push([name, input]), next())
  return { status: reads('status'), allowances: reads('allowances'), planDeposit: reads('planDeposit'), write: { approveMusd: via('write.approveMusd'), deposit: via('write.deposit'), withdraw: via('write.withdraw'), liquidate: via('write.liquidate'), revoke: via('write.revoke') } }
}

describe('the Stability Pool tools', () => {
  const listTools = async (sp?: Sp, trove?: Trove, ve?: Ve) => (await (await connect({ lens: fakeLens(), sp, trove, ve })).listTools()).tools

  it('the three reads come with sp; the five sending tools only when sp.write exists, and none takes a key, cap, gas or a wallet to send from', async () => {
    expect((await listTools()).map((t) => t.name).sort()).toEqual([...READS].sort())
    const readsOnly = await listTools({ ...stubSp(), write: undefined })
    expect(readsOnly.map((t) => t.name).sort()).toEqual([...READS, ...SP_READS].sort())
    for (const t of readsOnly.filter((x) => x.name !== 'pay_and_fetch')) expect(t.annotations?.readOnlyHint, t.name).toBe(true)

    const all = await listTools(stubSp(), stubTrove(), stubVe())
    expect(all.map((t) => t.name).sort()).toEqual([...READS, ...VE_READS, ...VE_WRITES, ...TROVE_READS, ...TROVE_WRITES, ...SP_READS, ...SP_WRITES].sort())
    for (const n of SP_WRITES) expect(all.find((t) => t.name === n)!.annotations, n).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false })
    const tool = (n: string) => all.find((t) => t.name === n)!
    const props = (n: string) => Object.keys(tool(n).inputSchema.properties ?? {})
    expect(props('sp_status')).toEqual(['address'])
    expect(props('allowance_status')).toEqual(['address', 'spender'])
    expect(tool('allowance_status').inputSchema.required).toEqual(['address'])
    expect(props('plan_sp_deposit')).toEqual(['address', 'amount'])
    expect(tool('plan_sp_deposit').inputSchema.required).toEqual(['address', 'amount'])
    expect(props('sp_approve_musd')).toEqual(['amount']) // the writers act for the operator's wallet only
    expect(props('sp_deposit')).toEqual(['amount'])
    expect(props('sp_withdraw')).toEqual(['amount'])
    expect(props('trove_liquidate')).toEqual(['borrower'])
    expect(props('approve_revoke')).toEqual(['token', 'spender'])
    expect((tool('approve_revoke').inputSchema.properties as Record<string, { enum?: string[] }>).token!.enum).toEqual(['BTC', 'MUSD']) // no other token, no amount: it only sets 0
    expect(tool('trove_liquidate').description).toMatch(/Risky:.*MEZO_WRITE_RISKY=1/)

    const readsText = (await connect({ lens: fakeLens(), sp: { ...stubSp(), write: undefined } })).getInstructions()
    expect(readsText).toMatch(/^Mezo testnet only\. 7 free read tools .*the Stability Pool, a deposit plan and token allowances/)
    expect(readsText).not.toMatch(/sp_deposit/)
    const full = (await connect({ lens: fakeLens(), ve: stubVe(), trove: stubTrove(), sp: stubSp() })).getInstructions()
    expect(full).toMatch(/^Mezo testnet only\. 13 free read tools/)
    expect(full).toMatch(/Five more \(sp_approve_musd, sp_deposit, sp_withdraw, trove_liquidate, approve_revoke\) approve and deposit MUSD to the Stability Pool/)
  })

  it('the readers answer as text and as structured content with their arguments passed on, and leave out a spender nobody named', async () => {
    const seen: [string, unknown][] = []
    const client = await connect({ lens: fakeLens(), sp: stubSp(undefined, seen) })
    for (const [name, args] of [['sp_status', { address: WALLET }], ['allowance_status', { address: WALLET }], ['allowance_status', { address: WALLET, spender: WALLET }], ['plan_sp_deposit', { address: WALLET, amount: '5' }]] as const) {
      const r = await call(client, name, args)
      expect(r.isError, name).toBeFalsy()
      expect(r.structuredContent).toEqual({ blockNumber: 9 })
      expect(JSON.parse(r.content[0]!.text)).toEqual(r.structuredContent)
    }
    expect(seen).toEqual([['status', { address: WALLET }], ['allowances', { address: WALLET }], ['allowances', { address: WALLET, spender: WALLET }], ['planDeposit', { address: WALLET, amount: '5' }]])
  })

  it('turns bad input and a chain failure of a reader into tool errors and keeps serving', async () => {
    let answer: () => Promise<object> = () => Promise.reject(new InputError('address must be a 0x address with 40 hex characters'))
    const client = await connect({ lens: fakeLens(), sp: stubSp(undefined, [], () => answer()) })
    expect(await call(client, 'sp_status', { address: 'x' })).toMatchObject({ isError: true, content: [{ type: 'text', text: 'address must be a 0x address with 40 hex characters' }] })
    answer = () => Promise.reject(Object.assign(new Error('a very long message'), { shortMessage: 'boom' }))
    expect(await call(client, 'allowance_status', { address: WALLET })).toMatchObject({ isError: true, content: [{ type: 'text', text: 'chain read failed, try again: boom' }] })
    answer = async () => ({ ok: true })
    expect((await call(client, 'sp_status', { address: WALLET })).isError).toBeFalsy()
  })

  it('maps every outcome the same way for each sending tool: success, refusal, reverted, no receipt, bad input, crash', async () => {
    const seen: [string, unknown][] = []
    let next: () => Promise<Outcome> = async () => mined
    const client = await connect({ lens: fakeLens(), sp: stubSp(() => next(), seen) })
    const args: Record<string, Record<string, unknown>> = {
      sp_approve_musd: { amount: '10' },
      sp_deposit: { amount: '10' },
      sp_withdraw: { amount: '1' },
      trove_liquidate: { borrower: WALLET },
      approve_revoke: { token: 'MUSD', spender: WALLET },
    }
    for (const [name, a] of Object.entries(args)) {
      next = async () => mined
      const good = await call(client, name, a)
      expect(good.isError, name).toBeFalsy()
      expect(good.structuredContent, name).toMatchObject({ sent: true, status: 'success', hash: HASH })
      expect(JSON.parse(good.content[0]!.text)).toEqual(good.structuredContent)

      next = async () => ({ sent: false, reason: 'the pool refuses every non-zero withdrawal' })
      const refused = await call(client, name, a)
      expect(refused.isError, name).toBe(true)
      expect(refused.content[0]!.text).toBe('Refused, nothing was sent: the pool refuses every non-zero withdrawal')
      expect(refused.structuredContent).toEqual({ sent: false, reason: 'the pool refuses every non-zero withdrawal' })

      next = async () => ({ ...mined, status: 'reverted' }) as Outcome
      const reverted = await call(client, name, a)
      expect(reverted.isError, name).toBe(true)
      expect(reverted.structuredContent).toMatchObject({ sent: true, status: 'reverted', hash: HASH, warning: expect.stringMatching(/mined and reverted/) })

      next = async () => ({ ...mined, status: 'unknown', blockNumber: null, gasUsed: null }) as Outcome
      const unknown = await call(client, name, a)
      expect(unknown.isError, name).toBe(true)
      expect(unknown.structuredContent.warning).toMatch(/No receipt arrived in time.*Check the hash/)

      next = async () => Promise.reject(new InputError('amount must be a plain positive decimal number'))
      expect(await call(client, name, a), name).toMatchObject({ isError: true, content: [{ type: 'text', text: 'amount must be a plain positive decimal number' }] })

      next = async () => Promise.reject(Object.assign(new Error('a very long message'), { shortMessage: 'boom' }))
      const crash = await call(client, name, a)
      expect(crash.isError, name).toBe(true)
      expect(crash.content[0]!.text).toMatch(/^The tool failed \(boom\)\. If a transaction may have been sent, check the receipts file and the chain before trying again\.$/)
    }
    // Each tool handed the writer exactly its own arguments.
    expect(new Set(seen.map((s) => JSON.stringify(s)))).toEqual(
      new Set([['write.approveMusd', args.sp_approve_musd], ['write.deposit', args.sp_deposit], ['write.withdraw', args.sp_withdraw], ['write.liquidate', args.trove_liquidate], ['write.revoke', args.approve_revoke]].map((x) => JSON.stringify(x))),
    )
  })

  it('drops arguments the schema does not list (a wallet, a key file, a gas) and rejects a token other than BTC or MUSD before the writer sees anything', async () => {
    const seen: [string, unknown][] = []
    const client = await connect({ lens: fakeLens(), sp: stubSp(undefined, seen) })
    await call(client, 'sp_deposit', { amount: '10', address: WALLET, keyFile: '/tmp/other.key', gas: 1 })
    await call(client, 'approve_revoke', { token: 'MUSD', spender: WALLET, amount: '5' })
    expect(seen).toEqual([['write.deposit', { amount: '10' }], ['write.revoke', { token: 'MUSD', spender: WALLET }]])
    const bad = await call(client, 'approve_revoke', { token: 'MEZO', spender: WALLET }).then((r) => r.isError, () => true)
    expect(bad).toBe(true)
    expect(seen).toHaveLength(2)
  })
})

describe('veFromEnv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mezo-mcp-ve-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const key = generatePrivateKey()
  const keyFile = join(dir, 'k.key')
  writeFileSync(keyFile, key, { mode: 0o600 })
  const me = privateKeyToAccount(key).address
  const onEnv = { MEZO_WRITE_ENABLE: 'testnet', MEZO_KEY_FILE: keyFile, MEZO_WRITE_RECEIPTS_FILE: join(dir, 'receipts.jsonl'), MEZO_WRITE_MAX_BTC_PER_CALL: '0.01', MEZO_WRITE_MAX_BTC_PER_DAY: '0.02', MEZO_WRITE_RISKY: '1' }

  it('has no write part unless MEZO_WRITE_ENABLE is exactly testnet', () => {
    const { client } = veWorld(me).rpc()
    for (const v of [undefined, '', '1', 'true', 'mainnet', 'TESTNET', ' testnet']) {
      const r = veFromEnv({ ...onEnv, MEZO_WRITE_ENABLE: v }, client)
      expect(r.writer, String(v)).toBeUndefined()
      expect(r.ve.write, String(v)).toBeUndefined()
    }
    expect(veFromEnv(onEnv, client).ve.write).toBeDefined()
  })

  it('a bad setup keeps the sending tools listed and each one refuses with the reason, naming no path, and touches no chain', async () => {
    for (const [env, why] of [
      [{ MEZO_WRITE_ENABLE: 'testnet' }, /no wallet is configured \(the operator sets MEZO_KEY_FILE/],
      [{ MEZO_WRITE_ENABLE: 'testnet', MEZO_KEY_FILE: join(dir, 'missing.key') }, /cannot read the key file/],
      [{ ...onEnv, MEZO_WRITE_RECEIPTS_FILE: undefined }, /no receipts file is configured/],
      [{ ...onEnv, MEZO_WRITE_MAX_BTC_PER_CALL: '0.5' }, /the write policy is not valid, so writes stay off/],
    ] as const) {
      const rpc = veWorld(me).rpc()
      const client = await connect({ lens: fakeLens(), ve: veFromEnv(env, rpc.client).ve })
      for (const [name, a] of [['ve_approve_btc', { amount: '0.004' }], ['ve_lock', { amount: '0.004', days: 28 }], ['ve_vote', { tokenId: '1', pools: [{ pool: pool(0), weight: 1 }] }], ['ve_poke', { tokenId: '1' }], ['ve_claim_rewards', { tokenId: '1' }], ['ve_claim_rebase', { tokenId: '1' }]] as const) {
        const r = await call(client, name, a)
        expect(r.isError, name).toBe(true)
        expect(r.content[0]!.text, name).toMatch(why)
        expect(r.content[0]!.text).not.toContain(dir)
      }
      expect(rpc.calls).toEqual([])
    }
  })

  it('end to end on the fake chain: status, exact approve, lock, a vote in the lock\'s own block refused, then the vote', async () => {
    const world = veWorld(me)
    const rpc = world.rpc()
    const client = await connect({ lens: fakeLens(), ve: veFromEnv(onEnv, rpc.client).ve })
    expect((await call(client, 've_status')).structuredContent).toMatchObject({ chainId: 31611, systems: { live: { distributing: true }, legacy: { distributing: false } } })
    expect((await call(client, 'gauge_rewards')).structuredContent.pools[0]).toMatchObject({ rank: 1, name: 'MUSD Savings Rate' })
    expect((await call(client, 've_approve_btc', { amount: '0.004' })).structuredContent).toMatchObject({ sent: true, status: 'success', allowance: '0.004' })
    expect((await call(client, 've_lock', { amount: '0.004', days: 28 })).structuredContent).toMatchObject({ sent: true, status: 'success', tokenId: '1900', unlocksAt: '2026-11-26T00:00:00.000Z' })
    const early = await call(client, 've_vote', { tokenId: '1900', pools: [{ pool: pool(0), weight: 100 }] })
    expect(early.isError).toBe(true)
    expect(early.content[0]!.text).toMatch(/^Refused, nothing was sent: NFT 1900 has voting power 0 in this block/)
    world.w.block += 1n
    expect((await call(client, 've_vote', { tokenId: '1900', pools: [{ pool: pool(0), weight: 100 }] })).structuredContent).toMatchObject({ sent: true, status: 'success', voted: true })
    expect((await call(client, 've_status', { tokenId: '1900' })).structuredContent.nft).toMatchObject({ exists: true, voted: true, votedThisEpoch: true, canVoteNow: false })
    expect(world.w.sent).toHaveLength(3)
  })
})

describe('the real stdio entry', () => {
  it('starts with a clean environment, lists the tools over stdio and keeps stdout for the protocol', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp.ts'], cwd: root, env: getDefaultEnvironment(), stderr: 'pipe' })
    const client = new Client({ name: 'test', version: '0.0.0' })
    open.push(client)
    let stderr = ''
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    await client.connect(transport)
    const { tools } = await client.listTools()
    // The two ve reads, the four trove reads and the three Stability Pool reads are always on; the fourteen sending tools need MEZO_WRITE_ENABLE=testnet, which this clean environment lacks.
    expect(tools.map((t) => t.name).sort()).toEqual(['allowance_status', 'gauge_rewards', 'pay_and_fetch', 'plan_open', 'plan_repay', 'plan_sp_deposit', 'plan_top_up', 'pool_quote', 'redemption_risk', 'sp_status', 'trove_health', 'trove_status', 've_locks', 've_status'])
    const r = await call(client, 'pay_and_fetch', { url })
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toMatch(/switched off.*MEZO_KEY_FILE/)
    expect(stderr).toMatch(/"event":"mcp-ready"/)
    expect(stderr).toMatch(/"off":/)
  }, 60_000)
})
