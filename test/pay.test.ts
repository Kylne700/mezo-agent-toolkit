// The paying side: spend limits stop a payment before anything is signed, and the URL, body and redirect rules hold.
import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.ts'
import { PaymentRefused, checkUrl, createBuyer, readCapped } from '../src/pay.ts'
import { SpendGuard } from '../src/spend.ts'
import { PAYEE, TROVE, fakeFacilitator, fakeLens, testAccount, zeroReader } from './helpers/x402.ts'
import { parseUnits } from 'viem'

const musd = (x: string) => parseUnits(x, 18)

function world(o: { price?: string; perCall?: string; perSession?: string; allowedHosts?: string[] } = {}) {
  const facilitator = fakeFacilitator()
  const app = createApp({ lens: fakeLens(), payTo: PAYEE, facilitator, price: o.price })
  const calls: string[] = []
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push(input instanceof Request ? input.url : String(input))
    return Promise.resolve(app.fetch(new Request(input as Request | string, init)))
  }
  const guard = new SpendGuard({ perCall: musd(o.perCall ?? '0.01'), perSession: musd(o.perSession ?? '0.1') })
  const buyer = createBuyer({ account: testAccount(), chainReader: zeroReader, guard, fetchImpl, allowedHosts: o.allowedHosts })
  return { buyer, guard, facilitator, calls }
}

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
