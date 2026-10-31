// The paid HTTP endpoint: lens reads behind an x402 paywall priced in MUSD. Unpaid GET -> 402 with the payment challenge,
// paid GET -> 200 with live chain data. The same paywall sits in front of POST /plan/* (a ready-to-sign transaction, or the reason there is none).
// The factory takes everything it needs as arguments (no files, no environment, no key), so the same code runs under Node and under a Worker.
import { decodePaymentResponseHeader } from '@x402/core/http'
import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { declareEip2612GasSponsoringExtension } from '@x402/extensions'
import { paymentMiddleware, x402ResourceServer } from '@x402/hono'
import { Hono, type Context, type Next } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Address } from 'viem'
import pkg from '../package.json' with { type: 'json' }
import { ADDRESSES, CHAIN_ID, FACILITATOR_URL, NETWORK, addressUrl, txUrl } from './config.ts'
import { InputError, parseAddress, parseAmountText, parseBool, parseToken, parseTokenAmount } from './inputs.ts'
import type { Lens } from './lens.ts'
import type { Planner } from './plan.ts'
import { settlementRecovery, type LogReader, type RecoveryOptions } from './recover.ts'
import type { Sp } from './sp-actions.ts'

export const DEFAULT_PRICE = '$0.001'
/** A /plan answer is a dozen chain reads, a simulation and a transaction ready to sign: five times a raw read. */
export const PLAN_PRICE = '$0.005'
const MAX_BODY = 4096 // bytes; a plan request is a few short strings
/** The amount fields of each POST /plan/* body besides `address`: the planners' own field names, parsed with the planners' own calls. */
const PLAN_AMOUNTS = { '/plan/open': ['collateralBtc', 'debtMusd'], '/plan/top-up': ['amountBtc'], '/plan/repay': ['amountMusd'], '/plan/sp-deposit': ['amount'] } as const

export interface AppOptions {
  lens: Lens
  /** Who receives the payments. Only an address: the server never needs a key. */
  payTo: Address
  /** Price of one call as a USD string; paid in MUSD. */
  price?: string
  facilitatorUrl?: string
  /** Replace the HTTP facilitator (tests use a recorded one). */
  facilitator?: FacilitatorClient
  /** When given, every settlement is checked on chain: a reported success is served only if the chain shows it, a reported failure is served if the payment did land. */
  chain?: LogReader
  recovery?: RecoveryOptions
  now?: () => Date
  /** The planners behind POST /plan/*; they only read the chain (no signer). Without them those routes do not exist. */
  plans?: { planner: Pick<Planner, 'open' | 'topUp' | 'repay'>; sp: Pick<Sp, 'planDeposit'> }
}

interface Settlement {
  transaction: string
  network: string
  payer: string | null
  path: string
  at: string
  explorer: string
  /** True when the facilitator reported a failure but the transfer was found on chain. */
  recovered: boolean
}

export function createApp(opts: AppOptions): Hono {
  const price = opts.price ?? DEFAULT_PRICE
  const now = opts.now ?? (() => new Date())
  const facilitator = opts.facilitator ?? new HTTPFacilitatorClient({ url: opts.facilitatorUrl ?? FACILITATOR_URL })
  const recovery = opts.chain ? settlementRecovery(opts.chain, opts.recovery) : undefined
  const resourceServer = new x402ResourceServer(recovery ? recovery.confirming(facilitator) : facilitator).register(NETWORK, new ExactEvmScheme())
  if (recovery) resourceServer.onAfterSettle(recovery.afterSettle).onSettleFailure(recovery.onSettleFailure)

  const paid = (description: string, cost = price) => ({
    accepts: { scheme: 'exact', price: cost, network: NETWORK, payTo: opts.payTo },
    description,
    mimeType: 'application/json',
    // Tells buyers the facilitator pays the BTC gas, so a wallet that holds only MUSD can pay.
    extensions: { ...declareEip2612GasSponsoringExtension() },
  })
  const plans = opts.plans
  const planRoutes: Record<string, ReturnType<typeof paid>> = plans
    ? {
        'POST /plan/open': paid('Plan opening a trove (JSON body: address, collateralBtc, debtMusd): the transaction to sign, hints and ratios, or why it would be refused', PLAN_PRICE),
        'POST /plan/top-up': paid('Plan adding BTC to an open trove (JSON body: address, amountBtc): the transaction to sign and the ratio after, or why it would be refused', PLAN_PRICE),
        'POST /plan/repay': paid('Plan repaying MUSD debt of an open trove (JSON body: address, amountMusd): the transaction to sign and the ratio after, or why it would be refused', PLAN_PRICE),
        'POST /plan/sp-deposit': paid('Plan a MUSD deposit into the Stability Pool (JSON body: address, amount): the transaction, the exact approve it needs and the withdraw lock', PLAN_PRICE),
      }
    : {}
  const routes: Record<string, ReturnType<typeof paid>> = {
    'GET /v1/trove/:address': paid('Health of one MUSD trove: collateral ratio, debt, liquidation price'),
    'GET /v1/redemption/:address': paid('Where one trove stands in the MUSD redemption queue, with system context'),
    'GET /v1/pool/quote': paid('Quote a swap on the Mezo DEX: output, reserves and price impact'),
    'GET /v1/ve/:address': paid('veBTC and veMEZO locks held by one address'),
    ...planRoutes,
  }

  let last: Settlement | null = null
  const app = new Hono()

  // Bad input is answered with 400 before any payment challenge, so nobody is asked to pay for a request that cannot succeed.
  const check = (fn: (c: Context) => void | Promise<void>) => async (c: Context, next: Next) => {
    try {
      await fn(c)
    } catch (e) {
      if (e instanceof InputError) return c.json({ error: e.message }, 400)
      throw e
    }
    await next()
  }
  const addr = check((c) => void parseAddress(c.req.param('address')))
  app.use('/v1/trove/:address', addr)
  app.use('/v1/redemption/:address', addr)
  app.use('/v1/ve/:address', addr)
  app.use(
    '/v1/pool/quote',
    check((c) => {
      parseToken(c.req.query('tokenIn'), 'tokenIn')
      parseToken(c.req.query('tokenOut'), 'tokenOut')
      parseAmountText(c.req.query('amountIn'), 'amountIn')
      parseBool(c.req.query('stable'), 'stable')
    }),
  )

  // The same for a plan request: its JSON body must parse with the planner's own calls before anyone is asked to pay. A refusal by the planner is an answer, not bad input.
  // Hono keeps the parsed body, so the payment middleware and the handler read it again for free.
  const bodyOf = async (c: Context): Promise<Record<string, unknown>> => {
    const b: unknown = await c.req.json().catch(() => undefined)
    if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new InputError('the body must be a JSON object')
    return b as Record<string, unknown>
  }
  const take = <K extends string>(b: Record<string, unknown>, ...keys: K[]) => Object.fromEntries(keys.map((k) => [k, b[k]])) as Record<K, string>
  if (plans) {
    const tooBig = bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: `the body is larger than ${MAX_BODY} bytes` }, 413) })
    for (const [path, amounts] of Object.entries(PLAN_AMOUNTS)) {
      app.post(path, tooBig, check(async (c) => {
        const b = await bodyOf(c)
        parseAddress(b.address, 'address')
        for (const field of amounts) parseTokenAmount(b[field] as string, 18, field)
      }))
    }
  }

  // Remember the most recent settlement for the status page. It runs around the payment middleware and only reads the response.
  const remember = async (c: Context, next: Next) => {
    await next()
    const header = c.res.headers.get('payment-response')
    if (!header) return
    try {
      const s = decodePaymentResponseHeader(header)
      if (s.success && s.transaction) last = { transaction: s.transaction, network: s.network, payer: s.payer ?? null, path: c.req.path, at: now().toISOString(), explorer: txUrl(s.transaction), recovered: !!recovery?.recovered.has(s.transaction.toLowerCase()) }
    } catch {
      // A header we cannot read is simply not recorded.
    }
  }
  app.use('/v1/*', remember)
  app.use('/plan/*', remember)

  app.use(paymentMiddleware(routes, resourceServer))

  app.get('/v1/trove/:address', async (c) => c.json(await opts.lens.troveHealth(parseAddress(c.req.param('address')))))
  app.get('/v1/redemption/:address', async (c) => c.json(await opts.lens.redemptionRisk(parseAddress(c.req.param('address')))))
  app.get('/v1/ve/:address', async (c) => c.json(await opts.lens.veLocks(parseAddress(c.req.param('address'), 'address'))))
  app.get('/v1/pool/quote', async (c) =>
    c.json(
      await opts.lens.poolQuote({
        tokenIn: parseToken(c.req.query('tokenIn'), 'tokenIn'),
        tokenOut: parseToken(c.req.query('tokenOut'), 'tokenOut'),
        amountIn: parseAmountText(c.req.query('amountIn'), 'amountIn'),
        stable: parseBool(c.req.query('stable'), 'stable'),
      }),
    ),
  )

  // A refusal (minimum debt, ratio, Recovery Mode, capacity, pool rules) is a normal 200 answer with refused: true, and it is paid for: the answer is the work.
  if (plans) {
    const { planner, sp } = plans
    app.post('/plan/open', async (c) => c.json(await planner.open(take(await bodyOf(c), 'address', 'collateralBtc', 'debtMusd'))))
    app.post('/plan/top-up', async (c) => c.json(await planner.topUp(take(await bodyOf(c), 'address', 'amountBtc'))))
    app.post('/plan/repay', async (c) => c.json(await planner.repay(take(await bodyOf(c), 'address', 'amountMusd'))))
    app.post('/plan/sp-deposit', async (c) => c.json(await sp.planDeposit(take(await bodyOf(c), 'address', 'amount'))))
  }

  const status = (c: Context) =>
    c.json({
      name: pkg.name,
      version: pkg.version,
      network: NETWORK,
      chainId: CHAIN_ID,
      lens: { address: opts.lens.address, explorer: addressUrl(opts.lens.address) },
      payTo: opts.payTo,
      asset: { symbol: 'MUSD', address: ADDRESSES.musd, decimals: 18 },
      price,
      ...(plans ? { planPrice: PLAN_PRICE } : {}),
      facilitator: opts.facilitatorUrl ?? FACILITATOR_URL,
      endpoints: Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, v.description])),
      lastSettlement: last,
      recoveredSettlements: recovery?.recovered.size ?? 0,
    })
  app.get('/', status)
  app.get('/status', status)
  app.get('/health', (c) => c.json({ ok: true }))

  app.onError((err, c) => {
    if (err instanceof InputError) return c.json({ error: err.message }, 400)
    // Anything else is a chain or network failure on our side: 502, and the payment middleware then does not settle.
    const detail = (err as { shortMessage?: string }).shortMessage ?? err.message
    return c.json({ error: 'chain read failed, try again', detail: String(detail).slice(0, 200) }, 502)
  })
  app.notFound((c) => c.json({ error: 'not found', see: '/status' }, 404))
  return app
}
