// The Worker's app. It serves the same Hono app as `npm run serve` (createApp, unchanged), plus the console page at `/` and a free JSON route
// for recent payments. The seller needs no secret: it holds only the payee's address; the buyer signs, the facilitator sends the transaction.
// Settings come from wrangler.toml [vars]: PAYEE_ADDRESS, PRICE, RPC_URL, FACILITATOR_URL.
// This is not the entry file: workerd rejects any export of the entry module except the handler, so the entry (worker.ts) only exports the default.
import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import type { Hono } from 'hono'
import { createPublicClient, formatUnits, getAddress, http, isAddress, isAddressEqual, type Address } from 'viem'
import deployment from '../deployments/testnet.json' with { type: 'json' }
import { createApp, DEFAULT_PRICE } from './app.ts'
import { ADDRESSES, CHAIN_ID, DEFAULT_PAYEE, FACILITATOR_URL, NETWORK, RPC_URL, mezoTestnet } from './config.ts'
import { consoleResponse, PAID_ROUTES } from './console.ts'
import { createLens, type Lens } from './lens.ts'
import { recentPayments, type PaymentsChain, type PaymentsResult } from './payments.ts'
import type { LogReader, RecoveryOptions } from './recover.ts'

export interface Env {
  PAYEE_ADDRESS?: string
  /** USD price of one call, for example "$0.001"; paid in MUSD. */
  PRICE?: string
  RPC_URL?: string
  FACILITATOR_URL?: string
}

export interface Settings {
  payTo: Address
  price: string
  rpcUrl: string
  facilitatorUrl: string
}

/** How long a payments answer is reused, so the public RPC is read at most once per window per Worker instance (a burst at the moment it expires can scan more than once). */
export const PAYMENTS_TTL_MS = 45_000

const isHttpUrl = (v: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol)
  } catch {
    return false
  }
}

/** Reads and checks the settings. A bad one throws a message that names the variable and never echoes a secret (there are none). */
export function settingsFrom(env: Env): Settings {
  const payTo = env.PAYEE_ADDRESS ?? DEFAULT_PAYEE
  if (!isAddress(payTo)) throw new Error('PAYEE_ADDRESS must be a 0x address with 40 hex characters')
  const price = env.PRICE ?? DEFAULT_PRICE
  if (!/^\$\d+(\.\d{1,18})?$/.test(price) || /^\$0+(\.0+)?$/.test(price)) throw new Error('PRICE must be a positive USD amount such as "$0.001"')
  const rpcUrl = env.RPC_URL ?? RPC_URL
  if (!isHttpUrl(rpcUrl)) throw new Error('RPC_URL must be an http or https URL')
  const facilitatorUrl = env.FACILITATOR_URL ?? FACILITATOR_URL
  if (!isHttpUrl(facilitatorUrl)) throw new Error('FACILITATOR_URL must be an http or https URL')
  return { payTo: getAddress(payTo), price, rpcUrl, facilitatorUrl }
}

/** Replaces the outside world (tests). Without it the Worker reads the real chain and calls the real facilitator. */
export interface WorkerDeps {
  lens?: Lens
  /** The chain as the paid endpoint and the payments route see it. */
  chain?: LogReader & PaymentsChain
  facilitator?: FacilitatorClient
  recovery?: RecoveryOptions
  now?: () => number
}

export interface WorkerApp {
  fetch(request: Request): Promise<Response>
}

export function createWorker(s: Settings, deps: WorkerDeps = {}): WorkerApp {
  const now = deps.now ?? Date.now
  const client = createPublicClient({ chain: mezoTestnet, transport: http(s.rpcUrl) })
  const chain = deps.chain ?? client
  // The payments route asks for the time of several blocks at once; batching turns those into one request to the public RPC.
  const batching = deps.chain ?? createPublicClient({ chain: mezoTestnet, transport: http(s.rpcUrl, { batch: true }) })
  const lens = deps.lens ?? createLens(client, getAddress(deployment.MezoLens.address))
  const facilitator = deps.facilitator ?? new HTTPFacilitatorClient({ url: s.facilitatorUrl })

  // The paid endpoint is the unchanged createApp, built once and kept: its settlement memory (which transaction already paid for an answer, the last settlement) lives in it.
  // workerd cancels a fetch when the request that started it ends, and a promise tied to that fetch then never settles for any other request. createApp starts the
  // facilitator's "supported" call the moment it is built, so it is built only after this request holds the answer, and it is handed over as a plain value.
  // Measured: building it at the first request, whatever that was, left every later paid request hanging.
  let inner: Hono | undefined
  async function paidApp(): Promise<Hono> {
    if (inner) return inner
    const supported = await facilitator.getSupported()
    return (inner ??= createApp({
      lens,
      payTo: s.payTo,
      price: s.price,
      facilitatorUrl: s.facilitatorUrl,
      chain,
      recovery: deps.recovery,
      facilitator: { verify: (p, r) => facilitator.verify(p, r), settle: (p, r) => facilitator.settle(p, r), getSupported: async () => supported },
    }))
  }

  // Only finished answers are kept between requests, never a promise that is still running (see above).
  let cache: { at: number; value: PaymentsResult } | undefined
  /** The payments, at most one chain scan per TTL. When the chain cannot be read the last good answer is served, marked stale. */
  async function payments(): Promise<{ value: PaymentsResult; fetchedAt: string; stale: boolean }> {
    if (cache && now() - cache.at < PAYMENTS_TTL_MS) return { value: cache.value, fetchedAt: new Date(cache.at).toISOString(), stale: false }
    try {
      cache = { at: now(), value: await recentPayments(batching, { asset: ADDRESSES.musd, payee: s.payTo }) }
      return { value: cache.value, fetchedAt: new Date(cache.at).toISOString(), stale: false }
    } catch (e) {
      if (!cache) throw e
      return { value: cache.value, fetchedAt: new Date(cache.at).toISOString(), stale: true }
    }
  }

  async function paymentsRoute(): Promise<Response> {
    try {
      const { value, fetchedAt, stale } = await payments()
      return Response.json(
        { network: NETWORK, chainId: CHAIN_ID, ...value, fetchedAt, cacheSeconds: PAYMENTS_TTL_MS / 1000, stale },
        { headers: { 'cache-control': 'public, max-age=30', 'x-content-type-options': 'nosniff' } },
      )
    } catch {
      // No detail on purpose: a chain error can carry the RPC URL.
      return Response.json({ error: 'the chain could not be read just now, try again in a minute' }, { status: 502, headers: { 'cache-control': 'no-store' } })
    }
  }

  /** What the page says about the price comes from the same parser that builds the 402 challenge. */
  async function page(request: Request): Promise<Response> {
    const { amount, asset } = await new ExactEvmScheme().parsePrice(s.price, NETWORK)
    if (!isAddressEqual(asset as Address, ADDRESSES.musd)) throw new Error('the price would not be paid in MUSD')
    return consoleResponse({
      origin: new URL(request.url).origin,
      network: NETWORK,
      chainId: CHAIN_ID,
      priceMusd: formatUnits(BigInt(amount), 18),
      payee: s.payTo,
      lens: lens.address,
      facilitatorHost: new URL(s.facilitatorUrl).host,
      endpoints: PAID_ROUTES,
    })
  }

  return {
    async fetch(request) {
      if (request.method === 'GET' || request.method === 'HEAD') {
        const { pathname } = new URL(request.url)
        if (pathname === '/') return page(request).catch(() => Response.json({ error: 'the console page could not be built' }, { status: 500 }))
        if (pathname === '/api/payments') return paymentsRoute()
        if (pathname === '/favicon.ico') return new Response(null, { status: 204 })
      }
      let app: Hono
      try {
        app = await paidApp()
      } catch (e) {
        console.warn(`facilitator ${new URL(s.facilitatorUrl).host} did not answer: ${(e as Error).message}`)
        return Response.json({ error: 'the payment facilitator could not be reached, try again in a minute' }, { status: 502, headers: { 'cache-control': 'no-store' } })
      }
      return app.fetch(request)
    },
  }
}

// One instance per set of settings, kept for the life of the Worker isolate: createApp's settlement memory must survive from one request to the next.
let current: { key: string; app: WorkerApp } | undefined
export function workerFor(env: Env): WorkerApp {
  const s = settingsFrom(env)
  const key = JSON.stringify(s)
  if (current?.key !== key) current = { key, app: createWorker(s) }
  return current.app
}
