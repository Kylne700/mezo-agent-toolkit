// The paid POST /plan/* routes: the real planners (over the same fake chain as the planner tests) behind the real paywall and a fake facilitator.
// Per route: unpaid -> 402 with the plan price; paid -> the planner's own answer; a refusal -> a charged 200; bad input -> 400 before any challenge;
// a failing chain -> 502 and no settlement. Last: no module a Worker loads can sign anything.
import { decodePaymentRequiredHeader } from '@x402/core/http'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress, parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'
import { PLAN_PRICE, createApp } from '../src/app.ts'
import { ADDRESSES, NETWORK } from '../src/config.ts'
import { InputError } from '../src/inputs.ts'
import { createBuyer } from '../src/pay.ts'
import { createPlanner } from '../src/plan.ts'
import { createSp } from '../src/sp-actions.ts'
import { SpendGuard } from '../src/spend.ts'
import { spWorld, type SpWorld } from './helpers/sp.ts'
import { e18 } from './helpers/trove.ts'
import { mockRpc } from './helpers/write.ts'
import { PAYEE, PRICE_BASE_UNITS, TROVE, fakeFacilitator, fakeLens, testAccount, zeroReader } from './helpers/x402.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const ME = getAddress('0x3333333333333333333333333333333333333333')
const PLAN_UNITS = '5000000000000000' // $0.005 as MUSD base units
const HOST = 'http://plans.test'

type Tweak = (x: SpWorld) => void
const noop: Tweak = () => {}
const all = (...f: Tweak[]): Tweak => (x) => f.forEach((g) => g(x))
/** The wallet's own trove in the fake list (its borrow cap is what BorrowerOperations stored when it was opened). */
const hasTrove: Tweak = (x) => void x.w.troves.push({ owner: ME, coll: e18('0.045'), principal: e18('2101.9'), interest: 0n, capacity: (e18('0.045') * x.w.price) / x.w.mcr })
const holds500: Tweak = (x) => void (x.w.musd = e18(500))
const approved5: Tweak = (x) => void x.s.allowances.set(`musd:${ADDRESSES.stabilityPool.toLowerCase()}`, e18(5))

function setup(tweak: Tweak = noop, o: { down?: boolean; plans?: boolean } = {}) {
  const x = spWorld(ME)
  tweak(x)
  const rpc = o.down ? mockRpc({ ...x.over, eth_call: () => { throw new Error('execution reverted') } }) : x.rpc()
  const planner = createPlanner(rpc.client, x.lens)
  const sp = createSp(rpc.client)
  const facilitator = fakeFacilitator()
  const app = createApp({ lens: fakeLens(), payTo: PAYEE, facilitator, ...(o.plans === false ? {} : { plans: { planner, sp } }) })
  const fetchImpl: typeof fetch = (input, init) => Promise.resolve(app.fetch(new Request(input as Request | string, init)))
  const buyer = createBuyer({ account: testAccount(), chainReader: zeroReader, guard: new SpendGuard({ perCall: parseUnits('0.01', 18), perSession: parseUnits('0.1', 18) }), fetchImpl })
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  return { app, rpc, planner, sp, facilitator, buyer, post }
}
type Setup = ReturnType<typeof setup>

interface Route {
  path: string
  /** The world the route is called in. */
  tweak: Tweak
  /** An input the planner accepts, and one it refuses (a refusal is an answer, and it is paid for). */
  ok: Record<string, string>
  refused: Record<string, string>
  /** What the planner itself answers for a body, optionally at a given block. */
  plan: (s: Setup, body: Json, blockNumber?: bigint) => Promise<Json>
}
const ROUTES: Route[] = [
  { path: '/plan/open', tweak: noop, ok: { address: ME, collateralBtc: '0.045', debtMusd: '1900' }, refused: { address: ME, collateralBtc: '0.045', debtMusd: '1000' }, plan: (s, b, blockNumber) => s.planner.open(b, { blockNumber }) },
  { path: '/plan/top-up', tweak: hasTrove, ok: { address: ME, amountBtc: '0.001' }, refused: { address: ME, amountBtc: '0.05' }, plan: (s, b, blockNumber) => s.planner.topUp(b, { blockNumber }) },
  { path: '/plan/repay', tweak: all(hasTrove, holds500), ok: { address: ME, amountMusd: '10' }, refused: { address: ME, amountMusd: '102' }, plan: (s, b, blockNumber) => s.planner.repay(b, { blockNumber }) },
  { path: '/plan/sp-deposit', tweak: approved5, ok: { address: ME, amount: '5' }, refused: { address: ME, amount: '1000' }, plan: (s, b, blockNumber) => s.sp.planDeposit(b, { blockNumber }) },
]
const wire = (x: unknown): Json => JSON.parse(JSON.stringify(x))

/** Bodies the planner rejects as bad input. Where the body is a JSON object the planner is fed the same object, and its own error message must be the one the route answers. */
function badBodies(ok: Record<string, string>): { name: string; body: unknown; fed: boolean }[] {
  const out: { name: string; body: unknown; fed: boolean }[] = ['not json', '[]', 'null', '"text"', '7', ''].map((body) => ({ name: `the body ${JSON.stringify(body)}`, body, fed: false }))
  for (const key of Object.keys(ok)) {
    const { [key]: _gone, ...rest } = ok
    out.push({ name: `${key} missing`, body: rest, fed: true })
    const values = key === 'address' ? ['0x123', 'nobody', '', 42, null, ME.toLowerCase().replace('0x', ''), `${ME}00`] : ['0', '-1', '1e18', 'abc', '', '0.0000000000000000001', '1.0000000000000000001', 5, null, true, [], {}]
    for (const v of values) out.push({ name: `${key} = ${JSON.stringify(v)}`, body: { ...ok, [key]: v }, fed: true })
  }
  // Several wrong fields at once: the route and the planner must complain about the same one.
  const amounts = Object.keys(ok).slice(1)
  out.push({ name: 'every field wrong', body: { address: '0x123', ...Object.fromEntries(amounts.map((k) => [k, '0'])) }, fed: true })
  out.push({ name: 'the amounts wrong, in reverse order', body: { ...Object.fromEntries([...amounts].reverse().map((k) => [k, '-1'])), address: ME }, fed: true })
  return out
}

describe.each(ROUTES)('POST $path', ({ path, tweak, ok, refused, plan }) => {
  it('unpaid: a 402 for 0.005 MUSD to the payee with the gas-sponsoring offer, and nothing was read or settled', async () => {
    const s = setup(tweak)
    const res = await s.post(path, ok)
    expect(res.status).toBe(402)
    const challenge = decodePaymentRequiredHeader(res.headers.get('payment-required')!)
    const offer = challenge.accepts[0]!
    expect(offer).toMatchObject({ scheme: 'exact', network: NETWORK, amount: PLAN_UNITS, payTo: PAYEE })
    expect(offer.asset.toLowerCase()).toBe(ADDRESSES.musd.toLowerCase())
    expect(Object.keys(challenge.extensions ?? {})).toContain('eip2612GasSponsoring')
    expect([s.facilitator.verifies, s.facilitator.settles, s.rpc.calls.length]).toEqual([0, 0, 0])
  })

  it('paid: charged once, answered with exactly what the planner says at that block, and the answer is a plan, not a refusal', async () => {
    const s = setup(tweak)
    const r = await s.buyer.fetchPaid(`${HOST}${path}`, ok)
    expect(r).toMatchObject({ status: 200, paid: true, authorizedMusd: '0.005' })
    expect([s.facilitator.verifies, s.facilitator.settles]).toEqual([1, 1])
    const answer = r.json as Json
    expect(answer.refused).toBe(false)
    expect(typeof answer.to).toBe('string')
    expect(typeof answer.data).toBe('string')
    expect(answer.blockNumber).toBe(16_500_000)
    expect(answer).toEqual(wire(await plan(s, ok, BigInt(answer.blockNumber))))
  })

  it('refused by the planner: still a 200 with refused: true and the reason, and it is paid for because the answer is the work', async () => {
    const s = setup(tweak)
    const expected = await plan(s, refused)
    expect(expected.refused).toBe(true)
    const r = await s.buyer.fetchPaid(`${HOST}${path}`, refused)
    expect(r).toMatchObject({ status: 200, paid: true })
    expect(s.facilitator.settles).toBe(1)
    expect(r.json).toEqual(wire(expected))
    expect((r.json as Json).reason).toMatch(/\S/)
    expect(r.json).not.toHaveProperty('data')
  })

  it('bad input: a 400 with the planner\'s own message, no challenge, nobody asked to pay, no chain read', async () => {
    const s = setup(tweak)
    for (const { name, body, fed } of badBodies(ok)) {
      const res = await s.post(path, body)
      expect(res.status, name).toBe(400)
      expect(res.headers.get('payment-required'), name).toBeNull()
      const { error } = (await res.json()) as { error: string }
      if (fed) {
        const thrown = await plan(s, body).then(() => null, (e: unknown) => e)
        expect(thrown, `${name}: the planner should reject it too`).toBeInstanceOf(InputError)
        expect(error, name).toBe((thrown as InputError).message)
      } else expect(error, name).toBe('the body must be a JSON object')
    }
    expect(s.facilitator.verifies).toBe(0)
    expect(s.rpc.calls).toEqual([]) // the planner's own rejections above read nothing either
  })

  it('a failing chain: 502, signed but never settled, so the payer is not charged', async () => {
    const s = setup(tweak, { down: true })
    const r = await s.buyer.fetchPaid(`${HOST}${path}`, ok)
    expect(r).toMatchObject({ status: 502, paid: false, json: { error: 'chain read failed, try again' } })
    expect([s.facilitator.verifies, s.facilitator.settles]).toEqual([1, 0])
  })

  it('does not exist as a GET, and is a plain 404 when the app is built without planners', async () => {
    const s = setup(tweak)
    const get = await s.app.request(path)
    expect(get.status).toBe(404)
    expect(get.headers.get('payment-required')).toBeNull()
    const bare = setup(tweak, { plans: false })
    const res = await bare.post(path, ok)
    expect(res.status).toBe(404)
    expect(res.headers.get('payment-required')).toBeNull()
  })
})

describe('the plan routes together', () => {
  it('a body over 4096 bytes is a 413 before any challenge', async () => {
    const s = setup()
    const res = await s.post('/plan/open', { address: ME, collateralBtc: '1'.repeat(5000), debtMusd: '1' })
    expect(res.status).toBe(413)
    expect(res.headers.get('payment-required')).toBeNull()
    expect(s.facilitator.verifies).toBe(0)
  })

  it('/status lists the four POST routes next to the four GET routes and gives the plan price; the read price is unchanged', async () => {
    const s = setup()
    const status = (await (await s.app.request('/status')).json()) as Json
    expect(status.price).toBe('$0.001')
    expect(status.planPrice).toBe(PLAN_PRICE)
    expect(PLAN_PRICE).toBe('$0.005')
    expect(Object.keys(status.endpoints)).toEqual(['GET /v1/trove/:address', 'GET /v1/redemption/:address', 'GET /v1/pool/quote', 'GET /v1/ve/:address', ...ROUTES.map((r) => `POST ${r.path}`)])
    const read = decodePaymentRequiredHeader((await s.app.request(`/v1/trove/${TROVE}`)).headers.get('payment-required')!).accepts[0]!
    expect(read.amount).toBe(PRICE_BASE_UNITS)
  })

  it('one answer costs about twenty RPC requests (measured here: open 20, top-up 19, repay 19, sp-deposit 21); a Worker pays one subrequest for each and gets 50 per request on the free plan', async () => {
    for (const { path, tweak, ok, plan } of ROUTES) {
      const s = setup(tweak)
      await plan(s, ok)
      expect(s.rpc.calls.length, path).toBeLessThanOrEqual(30) // the payment itself adds about five more (supported, verify, settle, recovery reads)
    }
  })
})

// ---- no key in the Worker --------------------------------------------------------------------------------------------------------------------

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
// A static import or re-export (`import type` is erased by the build, so it loads nothing at run time); the specifier is group 1.
const IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm

/** Every file a source file loads at run time (relative `.ts` imports, followed) and every other module it names (packages, node: built-ins). */
function loads(entry: string): { files: Set<string>; others: Set<string> } {
  const files = new Set<string>()
  const others = new Set<string>()
  const todo = [entry]
  for (let file = todo.pop(); file !== undefined; file = todo.pop()) {
    if (files.has(file)) continue
    files.add(file)
    for (const m of readFileSync(join(SRC, file), 'utf8').matchAll(IMPORT)) {
      const spec = m[1]!
      if (spec.endsWith('.ts')) todo.push(spec.replace(/^\.\//, ''))
      else if (!spec.startsWith('.')) others.add(spec)
    }
  }
  return { files, others }
}

const KEY_FILES = ['keys.ts', 'signer-env.ts', 'write.ts', 'policy.ts', 'receipts.ts', 'pay.ts', 'spend.ts', 'clients.ts', 'mcp.ts', 'mcp-env.ts', 'mcp-server.ts', 'cli.ts', 've-actions.ts', 'trove-actions.ts', 'serve.ts']
const KEY_MODULES = [/^viem\/accounts$/, /^@x402\/fetch$/, /^@x402\/evm\/exact\/client$/, /^@modelcontextprotocol\//, /^node:/]
const keysIn = (l: ReturnType<typeof loads>) => [...[...l.files].filter((f) => KEY_FILES.includes(f)), ...[...l.others].filter((m) => KEY_MODULES.some((k) => k.test(m)))]

describe('no key in the Worker', () => {
  const entries = [...readdirSync(SRC).filter((f) => /^worker.*\.ts$/.test(f)), 'app.ts']

  it('sees the worker files and the paywall', () => {
    expect(entries).toEqual(expect.arrayContaining(['worker.ts', 'worker-app.ts', 'app.ts']))
    const worker = loads('worker.ts')
    expect([...worker.files]).toEqual(expect.arrayContaining(['worker-app.ts', 'app.ts', 'plan.ts', 'sp-actions.ts', 'inputs.ts']))
    expect([...worker.others]).toEqual(expect.arrayContaining(['viem', 'hono', '@x402/hono']))
  })

  it.each(entries)('%s loads no signer, key, wallet or node module', (entry) => {
    expect(keysIn(loads(entry))).toEqual([])
  })

  it('and the same walk does find them where they are: the local MCP server loads the key code', () => {
    expect(keysIn(loads('mcp.ts'))).toEqual(expect.arrayContaining(['keys.ts', 'write.ts', 'viem/accounts']))
  })
})
