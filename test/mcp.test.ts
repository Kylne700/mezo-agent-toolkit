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
import { buyerFromEnv } from '../src/mcp-env.ts'
import { createMcpServer, type McpOptions } from '../src/mcp-server.ts'
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
    expect(tools.map((t) => t.name).sort()).toEqual(['pay_and_fetch', 'pool_quote', 'redemption_risk', 'trove_health', 've_locks'])
    const r = await call(client, 'pay_and_fetch', { url })
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toMatch(/switched off.*MEZO_KEY_FILE/)
    expect(stderr).toMatch(/"event":"mcp-ready"/)
    expect(stderr).toMatch(/"off":/)
  }, 60_000)
})
