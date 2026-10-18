// The paying side: spend limits stop a payment before anything is signed, and the URL, body and redirect rules hold.
import { describe, expect, it, vi } from 'vitest'
import { PaymentRefused, checkUrl, createBuyer, readCapped } from '../src/pay.ts'
import { SpendGuard } from '../src/spend.ts'
import { TROVE, musdRequirement, payWorld as world, rawSeller, receiptCrash, testAccount, zeroReader } from './helpers/x402.ts'

const url = `http://app.test/v1/trove/${TROVE}`

describe('spend limits at the buyer', () => {
  it('refuse a price over the per-call limit before anything is signed or sent to the facilitator', async () => {
    const { buyer, guard, facilitator } = world({ price: '$0.02' })
    const err = await buyer.fetchPaid(url).catch((e) => e)
    expect(err).toBeInstanceOf(PaymentRefused)
    expect((err as PaymentRefused).reason).toBe('the price is over the per-call limit of 0.01 MUSD')
    expect(facilitator.verifies).toBe(0)
    expect(facilitator.settles).toBe(0)
    expect(guard.snapshot()).toMatchObject({ spentMusd: '0', payments: 0 })
  })

  it('refuse the call that would pass the session limit, and count only what was paid', async () => {
    const { buyer, guard, facilitator } = world({ perCall: '0.001', perSession: '0.002' })
    expect((await buyer.fetchPaid(url)).status).toBe(200)
    expect((await buyer.fetchPaid(url)).status).toBe(200)
    const err = await buyer.fetchPaid(url).catch((e) => e)
    expect(err).toBeInstanceOf(PaymentRefused)
    expect((err as PaymentRefused).reason).toMatch(/session limit of 0\.002 MUSD/)
    expect(facilitator.settles).toBe(2)
    expect(guard.snapshot()).toMatchObject({ spentMusd: '0.002', remainingMusd: '0', payments: 2 })
  })

  it('serialise calls: five calls at once with room for two pay for exactly two', async () => {
    const { buyer, facilitator } = world({ perCall: '0.001', perSession: '0.002' })
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => buyer.fetchPaid(url)))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(3)
    expect(facilitator.settles).toBe(2)
  })
})

describe('what the buyer will call', () => {
  it('refuses a host that is not on the allow list without making any request', async () => {
    const { buyer, calls } = world({ allowedHosts: ['app.test'] })
    await expect(buyer.fetchPaid('http://evil.test/v1/trove/x')).rejects.toThrow(/not on the allow list/)
    expect(calls).toEqual([])
    expect((await buyer.fetchPaid(url)).status).toBe(200)
  })

  it('does not follow a redirect with a payment attached: the 3xx comes back as it is', async () => {
    const init: RequestInit[] = []
    const fetchImpl: typeof fetch = async (_input, i) => {
      init.push(i ?? {})
      return new Response(null, { status: 302, headers: { location: 'http://elsewhere.test/' } })
    }
    const buyer = createBuyer({ account: testAccount(), chainReader: zeroReader, guard: SpendGuard.fromEnv({}), fetchImpl })
    const r = await buyer.fetchPaid(url)
    expect(r.status).toBe(302)
    expect(r.paid).toBe(false)
    expect(init).toHaveLength(1)
    expect(init[0]!.redirect).toBe('manual')
  })

  it('cuts a long answer off at the body limit and does not parse the cut text as JSON', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ pad: 'x'.repeat(5000) }), { headers: { 'content-type': 'application/json' } })
    const buyer = createBuyer({ account: testAccount(), chainReader: zeroReader, guard: SpendGuard.fromEnv({}), fetchImpl, maxBodyBytes: 1000 })
    const r = await buyer.fetchPaid(url)
    expect(r.bodyTruncated).toBe(true)
    expect(r.body.length).toBe(1000)
    expect(r.json).toBeUndefined()
  })

  it('gives up on a server that never answers', async () => {
    // The x402 wrapper hands fetch a Request, which carries the abort signal itself.
    const fetchImpl: typeof fetch = (input, init) =>
      new Promise((_res, rej) => (input instanceof Request ? input.signal : init?.signal)?.addEventListener('abort', () => rej(new Error('aborted'))))
    const buyer = createBuyer({ account: testAccount(), chainReader: zeroReader, guard: SpendGuard.fromEnv({}), fetchImpl, timeoutMs: 50 })
    await expect(buyer.fetchPaid(url)).rejects.toThrow()
  })
})

describe('what gets signed', () => {
  // A full RPC client, like the real one: with it the library can also build and sign plain transactions.
  const rpcReader = { readContract: async () => 0n, getTransactionCount: async () => 7, estimateFeesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }) }

  it('never signs the raw approve(Permit2, unlimited) transaction a seller can ask for', async () => {
    const seller = rawSeller({ accepts: [musdRequirement({ extra: { assetTransferMethod: 'permit2' } })], extensions: { erc20ApprovalGasSponsoring: { info: {}, schema: {} } } })
    const buyer = createBuyer({ account: testAccount(), chainReader: rpcReader, guard: SpendGuard.fromEnv({}), fetchImpl: seller.fetchImpl })
    await buyer.fetchPaid(url)
    expect(seller.payments).toHaveLength(1)
    expect(JSON.stringify(seller.payments[0])).not.toMatch(/signedTransaction/)
  })

  it('refuses a seller that wants the signature to stay valid for a day, before signing anything', async () => {
    const seller = rawSeller({ accepts: [musdRequirement({ maxTimeoutSeconds: 86400 })] })
    const guard = SpendGuard.fromEnv({})
    const buyer = createBuyer({ account: testAccount(), chainReader: zeroReader, guard, fetchImpl: seller.fetchImpl })
    await expect(buyer.fetchPaid(url)).rejects.toThrow(/valid for 86400 seconds is not allowed/)
    expect(seller.payments).toHaveLength(0)
    expect(guard.snapshot()).toMatchObject({ spentMusd: '0', payments: 0 })
  })
})

describe('checkUrl', () => {
  it('accepts http and https and normalises', () => {
    expect(checkUrl('https://Example.com/a?b=1', [])).toBe('https://example.com/a?b=1')
  })

  it('rejects other schemes, credentials and garbage', () => {
    const at = '@' // spelled out so the privacy check does not take a URL with credentials for an email address
    for (const bad of ['file:///etc/passwd', 'ftp://x.test/', 'javascript:alert(1)', `https://user:pw${at}x.test/`, `https://user${at}x.test/`, 'not a url', '']) {
      expect(() => checkUrl(bad, []), bad).toThrow()
    }
  })

  it('applies the allow list to the host name only, case-insensitively', () => {
    expect(checkUrl('https://API.example.com/x', ['api.example.com'])).toBe('https://api.example.com/x')
    expect(() => checkUrl('https://api.example.com.evil.test/x', ['api.example.com'])).toThrow(/allow list/)
  })

  it('takes an entry with a port to mean that port only', () => {
    expect(checkUrl('http://127.0.0.1:8402/v1/x', ['127.0.0.1:8402'])).toBe('http://127.0.0.1:8402/v1/x')
    expect(() => checkUrl('http://127.0.0.1:8403/', ['127.0.0.1:8402'])).toThrow(/allow list/)
    expect(checkUrl('http://127.0.0.1:8403/', ['127.0.0.1'])).toBe('http://127.0.0.1:8403/')
  })
})

describe('readCapped', () => {
  it('returns short bodies whole', async () => {
    expect(await readCapped(new Response('hello'), 100)).toEqual({ text: 'hello', truncated: false })
  })

  it('stops reading a long or endless body at the limit', async () => {
    const cancelled = vi.fn()
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += 10
        c.enqueue(new Uint8Array(10).fill(97))
      },
      cancel: cancelled,
    })
    const r = await readCapped(new Response(body), 25)
    expect(r.truncated).toBe(true)
    expect(r.text).toBe('a'.repeat(25))
    expect(cancelled).toHaveBeenCalled()
    expect(sent).toBeLessThan(100)
  })

  it('handles an empty body', async () => {
    expect(await readCapped(new Response(null), 10)).toEqual({ text: '', truncated: false })
  })
})

// Only the paid retry carries the payment header; these tests break the network at exactly that point.
const paidRetry = (input: RequestInfo | URL) => (input as Request).headers?.has('payment-signature') === true

describe('after the payment has left', () => {
  it('reports a dropped connection as an unconfirmed payment, not as an error that says nothing happened', async () => {
    const { buyer, guard } = world({ wrap: (real) => (input, init) => (paidRetry(input) ? Promise.reject(new TypeError('fetch failed')) : real(input, init)) })
    const r = await buyer.fetchPaid(url)
    expect(r).toMatchObject({ status: 0, ok: false, paid: false, authorizedMusd: '0.001', settlement: null, unsettled: { reason: 'request_failed', detail: 'fetch failed' } })
    expect(guard.snapshot()).toMatchObject({ spentMusd: '0.001', payments: 1 })
  })

  it('throws an ordinary error when the request fails before any payment left, and counts nothing', async () => {
    const { buyer, guard } = world({ wrap: () => () => Promise.reject(new TypeError('fetch failed')) })
    await expect(buyer.fetchPaid(url)).rejects.toThrow('fetch failed')
    expect(guard.snapshot()).toMatchObject({ spentMusd: '0', payments: 0 })
  })

  it('flags a 200 that comes with no settlement receipt after a payment was sent', async () => {
    const { buyer } = world({
      wrap: (real) => async (input, init) => {
        const res = await real(input, init)
        return paidRetry(input) ? new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }) : res
      },
    })
    const r = await buyer.fetchPaid(url)
    expect(r).toMatchObject({ status: 200, ok: true, paid: false, unsettled: { reason: 'no_settlement_receipt' } })
  })

  it('keeps the settlement when the body is cut off after it', async () => {
    const { buyer } = world({
      wrap: (real) => async (input, init) => {
        const res = await real(input, init)
        if (!paidRetry(input)) return res
        const broken = new ReadableStream({ pull: (c) => c.error(new Error('connection reset')) })
        return new Response(broken, { status: res.status, headers: res.headers })
      },
    })
    const r = await buyer.fetchPaid(url)
    expect(r).toMatchObject({ status: 200, paid: true, bodyTruncated: true, body: '', unsettled: null })
    expect(r.settlement?.transaction).toMatch(/^0x[0-9a-f]{64}$/)
  })

  // The Permit2 nonce bitmap as the chain would answer it: every nonce used (the payment landed), none used, or no answer.
  const permit2Says = (state: 'landed' | 'unused' | 'unreadable') => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName !== 'nonceBitmap') return 0n
      if (state === 'unreadable') throw new Error('method handler crashed')
      return state === 'landed' ? 2n ** 256n - 1n : 0n
    },
  })

  it('does not pay twice when the seller answers 402 again but the first payment landed on chain', async () => {
    const { buyer, guard, facilitator } = world({ settle: receiptCrash, chainReader: permit2Says('landed') })
    expect((await buyer.fetchPaid(url)).unsettled).toMatchObject({ reason: 'unexpected_error' })
    await expect(buyer.fetchPaid(url)).rejects.toThrow(/landed on chain but the seller never confirmed it/)
    expect(facilitator.verifies).toBe(1) // no second payment reached the seller
    expect(guard.snapshot()).toMatchObject({ spentMusd: '0.001', payments: 1 })
  })

  it('pays for that URL again only once the chain shows the first payment can no longer land', async () => {
    for (const state of ['unused', 'unreadable'] as const) {
      const { buyer, facilitator } = world({ settle: receiptCrash, chainReader: permit2Says(state) })
      await buyer.fetchPaid(url)
      await expect(buyer.fetchPaid(url)).rejects.toThrow(state === 'unused' ? /could still land until/ : /chain could not be read/)
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 400_000) // past the 300 s deadline and the clock slack
      const later = await buyer.fetchPaid(url).then(() => 'paid', (e: Error) => e.message)
      vi.restoreAllMocks()
      expect(later, state).toBe(state === 'unused' ? 'paid' : 'the last payment for this URL was not confirmed and the chain could not be read to check it; try again later')
      expect(facilitator.verifies, state).toBe(state === 'unused' ? 2 : 1)
    }
  })
})
