// The paying side of x402: an HTTP GET that pays in MUSD when a server answers 402, under the hard limits of a SpendGuard.
// Layers, from the outside in: URL and host checks, a one-at-a-time queue, the x402 client's own per-payment cap (set to the same limit),
// and the SpendGuard hook that runs right before anything is signed. Nothing is signed unless every layer agrees.
import { x402Client } from '@x402/core/client'
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http'
import { toClientEvmSigner } from '@x402/evm'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { wrapFetchWithPayment } from '@x402/fetch'
import type { Address, LocalAccount } from 'viem'
import { formatUnits } from 'viem'
import { NETWORK, txUrl } from './config.ts'
import { SpendGuard, MUSD_DECIMALS, type SpendSnapshot } from './spend.ts'

/** The payment was refused by a spend limit or a rule; nothing was signed and nothing was paid. */
export class PaymentRefused extends Error {
  override name = 'PaymentRefused'
  constructor(readonly reason: string) {
    super(reason)
  }
}

export interface PaidResult {
  url: string
  /** HTTP status; 0 when the request failed after a payment had been sent (see `unsettled`). */
  status: number
  /** True when the server answered 2xx. */
  ok: boolean
  /** True when a payment was made and the server confirmed settlement. */
  paid: boolean
  /** What this call authorised, in MUSD (set when a payment was signed). */
  authorizedMusd: string | null
  settlement: { transaction: string; network: string; payer: string | null; explorer: string } | null
  /**
   * Set when a payment was sent but the server did not confirm settlement. The money may still have moved (a facilitator can fail after it
   * has broadcast the transfer, and a dropped connection hides the answer), so check the payer's MUSD balance or the explorer before paying again.
   */
  unsettled: { reason: string; detail: string | null } | null
  contentType: string | null
  body: string
  bodyTruncated: boolean
  /** The body parsed as JSON, when it is JSON and was not cut off. */
  json?: unknown
  spend: SpendSnapshot
}

export interface BuyerOptions {
  account: LocalAccount
  /** Anything with viem's readContract: the EVM signer reads allowances and permit nonces from the chain. */
  chainReader: unknown
  guard: SpendGuard
  /** Replace the network layer (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Only these hostnames may be called. Empty or missing means any host. */
  allowedHosts?: string[]
  timeoutMs?: number
  maxBodyBytes?: number
}

export interface Buyer {
  address: Address
  guard: SpendGuard
  fetchPaid(url: string): Promise<PaidResult>
}

const REFUSAL = /Payment creation aborted: ([^]*)|rejected by spendControls/

export function createBuyer(opts: BuyerOptions): Buyer {
  const { account, guard } = opts
  const baseFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 45_000
  const maxBodyBytes = opts.maxBodyBytes ?? 64 * 1024
  const hosts = (opts.allowedHosts ?? []).map((h) => h.toLowerCase())

  // The ticket records what the hook authorised for the call that is running now, and whether a payment has left this process. Calls run one at a time, so there is only ever one.
  let ticket: { amount?: bigint; sent?: boolean } = {}

  const client = new x402Client()
  registerExactEvmScheme(client, { signer: toClientEvmSigner(account, opts.chainReader as never), networks: [NETWORK] })
  // The library's own cap, equal to the per-call limit: a second wall behind the SpendGuard. Only MUSD on this network is a default asset here.
  client.setSpendControls({ maxAmountPerPayment: `$${formatUnits(guard.perCall, MUSD_DECIMALS)}` })
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    const decision = guard.authorize(selectedRequirements)
    if (!decision.ok) return { abort: true as const, reason: decision.reason }
    ticket.amount = decision.amount
  })

  // Never follow redirects with a payment attached: a 3xx comes back to the caller, who decides.
  const noRedirect: typeof fetch = (input, init) => {
    // Only the paid retry carries a payment header. From the moment it goes out the payment may reach the server, whatever happens next.
    const headers = (input as Partial<Request>).headers
    if (headers?.has('payment-signature') || headers?.has('x-payment')) ticket.sent = true
    return baseFetch(input, { ...init, redirect: 'manual' })
  }
  const payFetch = wrapFetchWithPayment(noRedirect, client)

  let queue: Promise<unknown> = Promise.resolve()

  async function run(rawUrl: string): Promise<PaidResult> {
    const url = checkUrl(rawUrl, hosts)
    ticket = {}
    let res: Response
    try {
      res = await payFetch(url, { method: 'GET', headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.1' }, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const m = REFUSAL.exec(message)
      if (!m) {
        // A failure before the payment left (bad URL, no route, signing trouble) is an ordinary error: nothing was sent. A failure after it (timeout, dropped
        // connection) may have happened on either side of the transfer, so it comes back as a result that says the payment is unconfirmed.
        if (!ticket.sent) throw e
        return {
          url,
          status: 0,
          ok: false,
          paid: false,
          authorizedMusd: ticket.amount === undefined ? null : formatUnits(ticket.amount, MUSD_DECIMALS),
          settlement: null,
          unsettled: { reason: 'request_failed', detail: message.slice(0, 200) },
          contentType: null,
          body: '',
          bodyTruncated: false,
          spend: guard.snapshot(),
        }
      }
      // The x402 library's own cap speaks in terms of options the operator cannot change from here; say what happened in plain words instead.
      if (/spendControls\.maxAmountPerPayment/.test(message)) throw new PaymentRefused(`the price is over the per-call limit of ${formatUnits(guard.perCall, MUSD_DECIMALS)} MUSD`)
      throw new PaymentRefused(m[1] ? m[1].trim() : message.replace(/^Failed to create payment payload: /, ''))
    }
    const header = res.headers.get('payment-response') ?? res.headers.get('x-payment-response')
    let settlement: PaidResult['settlement'] = null
    if (header) {
      try {
        const s = decodePaymentResponseHeader(header)
        if (s.success && s.transaction) settlement = { transaction: s.transaction, network: s.network, payer: s.payer ?? null, explorer: txUrl(s.transaction) }
      } catch {
        // An unreadable settlement header counts as no settlement: paid stays false.
      }
    }
    // A body that cannot be read to the end (dropped connection) must not hide a settlement that already happened: it counts as cut off.
    const { text, truncated } = await readCapped(res, maxBodyBytes).catch(() => ({ text: '', truncated: true }))
    const contentType = res.headers.get('content-type')
    const result: PaidResult = {
      url,
      status: res.status,
      ok: res.ok,
      paid: settlement !== null,
      authorizedMusd: ticket.amount === undefined ? null : formatUnits(ticket.amount, MUSD_DECIMALS),
      settlement,
      unsettled: ticket.sent && !settlement ? whyUnsettled(res) : null,
      contentType,
      body: text,
      bodyTruncated: truncated,
      spend: guard.snapshot(),
    }
    if (!truncated && contentType?.includes('json')) {
      try {
        result.json = JSON.parse(text)
      } catch {
        // Not valid JSON after all: the text stays in `body`.
      }
    }
    return result
  }

  return {
    address: account.address,
    guard,
    fetchPaid(url) {
      const next = queue.then(() => run(url), () => run(url))
      queue = next.catch(() => undefined)
      return next
    },
  }
}

/** Why the server did not confirm a settlement, from the headers it sent: the facilitator's own error, or the new payment challenge. */
function whyUnsettled(res: Response): { reason: string; detail: string | null } {
  const paymentResponse = res.headers.get('payment-response') ?? res.headers.get('x-payment-response')
  if (paymentResponse) {
    try {
      const s = decodePaymentResponseHeader(paymentResponse)
      if (!s.success) return { reason: s.errorReason ?? 'settlement_failed', detail: s.errorMessage ? (s.errorMessage.split('\n')[0] ?? '').slice(0, 200) : null }
    } catch {
      // Unreadable: fall through to the other signals.
    }
  }
  const challenge = res.headers.get('payment-required')
  if (challenge) {
    try {
      return { reason: 'payment_not_accepted', detail: decodePaymentRequiredHeader(challenge).error ?? null }
    } catch {
      // Unreadable: fall through.
    }
  }
  return res.ok ? { reason: 'no_settlement_receipt', detail: 'the server answered but sent no settlement receipt' } : { reason: `http_${res.status}`, detail: null }
}

/** http or https only, no credentials in the URL, and the host must be on the allow list when there is one. */
export function checkUrl(raw: string, allowedHosts: string[]): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('url must be a full http:// or https:// address')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('url must start with http:// or https://')
  if (u.username || u.password) throw new Error('url must not contain a user name or password')
  if (allowedHosts.length > 0 && !allowedHosts.includes(u.hostname.toLowerCase())) throw new Error(`host ${u.hostname} is not on the allow list (MEZO_PAY_ALLOWED_HOSTS)`)
  return u.toString()
}

/** Read at most `max` bytes of the body and drop the rest, so a huge or endless response cannot flood memory or the model's context. */
export async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.length > max) {
      chunks.push(value.slice(0, max - size))
      size = max
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
    size += value.length
  }
  const buf = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    buf.set(c, at)
    at += c.length
  }
  return { text: new TextDecoder().decode(buf), truncated }
}
