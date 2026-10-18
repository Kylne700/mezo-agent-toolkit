// The paid HTTP endpoint: lens reads behind an x402 paywall priced in MUSD. Unpaid GET -> 402 with the payment challenge,
// paid GET -> 200 with live chain data. The factory takes everything it needs as arguments (no files, no environment),
// so the same code can run under Node today and under a Worker later.
import { decodePaymentResponseHeader } from '@x402/core/http'
import { HTTPFacilitatorClient, type FacilitatorClient, type RoutesConfig } from '@x402/core/server'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import { declareEip2612GasSponsoringExtension } from '@x402/extensions'
import { paymentMiddleware, x402ResourceServer } from '@x402/hono'
import { Hono, type Context, type Next } from 'hono'
import type { Address } from 'viem'
import pkg from '../package.json' with { type: 'json' }
import { ADDRESSES, CHAIN_ID, FACILITATOR_URL, NETWORK, addressUrl, txUrl } from './config.ts'
import { InputError, parseAddress, parseAmountText, parseBool, parseToken } from './inputs.ts'
import type { Lens } from './lens.ts'
import { settlementRecovery, type LogReader, type RecoveryOptions } from './recover.ts'

export const DEFAULT_PRICE = '$0.001'

export interface AppOptions {
  lens: Lens
  /** Who receives the payments. Only an address: the server never needs a key. */
  payTo: Address
  /** Price of one call as a USD string; paid in MUSD. */
  price?: string
  facilitatorUrl?: string
  /** Replace the HTTP facilitator (tests use a recorded one). */
  facilitator?: FacilitatorClient
  /** When given, a settlement the facilitator reports as failed is checked on chain, and the answer is served if the payment did land. */
  chain?: LogReader
  recovery?: RecoveryOptions
  now?: () => Date
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
  const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme())
  const recovery = opts.chain ? settlementRecovery(opts.chain, opts.recovery) : undefined
  if (recovery) resourceServer.onAfterSettle(recovery.afterSettle).onSettleFailure(recovery.onSettleFailure)

  const paid = (description: string) => ({
    accepts: { scheme: 'exact', price, network: NETWORK, payTo: opts.payTo },
    description,
    mimeType: 'application/json',
    // Tells buyers the facilitator pays the BTC gas, so a wallet that holds only MUSD can pay.
    extensions: { ...declareEip2612GasSponsoringExtension() },
  })
  const routes = {
    'GET /v1/trove/:address': paid('Health of one MUSD trove: collateral ratio, debt, liquidation price'),
    'GET /v1/redemption/:address': paid('Where one trove stands in the MUSD redemption queue, with system context'),
    'GET /v1/pool/quote': paid('Quote a swap on the Mezo DEX: output, reserves and price impact'),
    'GET /v1/ve/:address': paid('veBTC and veMEZO locks held by one address'),
  } satisfies RoutesConfig

  let last: Settlement | null = null
  const app = new Hono()

  // Bad input is answered with 400 before any payment challenge, so nobody is asked to pay for a request that cannot succeed.
  const check = (fn: (c: Context) => void) => async (c: Context, next: Next) => {
    try {
      fn(c)
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

  // Remember the most recent settlement for the status page. It runs around the payment middleware and only reads the response.
  app.use('/v1/*', async (c, next) => {
    await next()
    const header = c.res.headers.get('payment-response')
    if (!header) return
    try {
      const s = decodePaymentResponseHeader(header)
      if (s.success && s.transaction) last = { transaction: s.transaction, network: s.network, payer: s.payer ?? null, path: c.req.path, at: now().toISOString(), explorer: txUrl(s.transaction), recovered: !!recovery?.recovered.has(s.transaction.toLowerCase()) }
    } catch {
      // A header we cannot read is simply not recorded.
    }
  })

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
