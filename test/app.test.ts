// The paid endpoint end to end, offline: the real app, the real x402 client code and a fake facilitator.
import { decodePaymentRequiredHeader } from '@x402/core/http'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { ADDRESSES, NETWORK } from '../src/config.ts'
import { createBuyer } from '../src/pay.ts'
import { settlementRecovery } from '../src/recover.ts'
import { SpendGuard } from '../src/spend.ts'
import {
  PAYEE, PRICE_BASE_UNITS, TROVE, fakeChain, fakeFacilitator, fakeLens, receiptCrash, signatureOf, testAccount, txHash, zeroReader,
  type FakeFacilitator,
} from './helpers/x402.ts'

const POOL = '/v1/pool/quote?tokenIn=BTC&tokenOut=MUSD&amountIn=0.001'
const guard = () => SpendGuard.fromEnv({})

function setup(o: { facilitator?: FakeFacilitator; chain?: ReturnType<typeof fakeChain>; lens?: ReturnType<typeof fakeLens>; price?: string } = {}) {
  const facilitator = o.facilitator ?? fakeFacilitator()
  const app = createApp({ lens: o.lens ?? fakeLens(), payTo: PAYEE, facilitator, chain: o.chain, recovery: { waitMs: 0 }, price: o.price })
  const fetchImpl: typeof fetch = (input, init) => Promise.resolve(app.fetch(new Request(input as Request | string, init)))
  const buyer = createBuyer({ account: testAccount(), chainReader: zeroReader, guard: guard(), fetchImpl })
  return { app, facilitator, buyer, get: (path: string) => app.request(path) }
}

describe('unpaid requests', () => {
  it('get 402 with a challenge for 0.001 MUSD to the payee, and the gas-sponsoring offer', async () => {
    const { get } = setup()
    for (const path of [`/v1/trove/${TROVE}`, `/v1/redemption/${TROVE}`, POOL, `/v1/ve/${TROVE}`]) {
      const res = await get(path)
      expect(res.status, path).toBe(402)
      const challenge = decodePaymentRequiredHeader(res.headers.get('payment-required')!)
      const offer = challenge.accepts[0]!
      expect(offer).toMatchObject({ scheme: 'exact', network: NETWORK, amount: PRICE_BASE_UNITS, payTo: PAYEE })
      expect(offer.asset.toLowerCase()).toBe(ADDRESSES.musd.toLowerCase())
      expect(Object.keys(challenge.extensions ?? {})).toContain('eip2612GasSponsoring')
    }
  })

  it('with bad input get 400 and no challenge, so nobody is asked to pay for a request that cannot succeed', async () => {
    const { get, facilitator } = setup()
    for (const path of [
      '/v1/trove/not-an-address',
      `/v1/redemption/${TROVE.slice(0, 20)}`,
      '/v1/ve/0xDA04759E54728B6636Fe48F7c9795c7B609bAaAA', // wrong checksum
      '/v1/pool/quote?tokenIn=DOGE&tokenOut=MUSD&amountIn=1',
      '/v1/pool/quote?tokenIn=BTC&tokenOut=MUSD&amountIn=-1',
      '/v1/pool/quote?tokenIn=BTC&tokenOut=MUSD&amountIn=1e3',
      '/v1/pool/quote?tokenIn=BTC&tokenOut=MUSD',
      '/v1/pool/quote?tokenIn=BTC&tokenOut=MUSD&amountIn=1&stable=maybe',
    ]) {
      const res = await get(path)
      expect(res.status, path).toBe(400)
      expect(res.headers.get('payment-required'), path).toBeNull()
      expect(((await res.json()) as { error: string }).error).toMatch(/must be/)
    }
    expect(facilitator.verifies).toBe(0)
  })

  it('leave the free routes free and answer unknown paths with 404', async () => {
    const { get } = setup()
    expect((await get('/health')).status).toBe(200)
    const status = (await (await get('/status')).json()) as { payTo: string; price: string; lastSettlement: unknown; recoveredSettlements: number }
    expect(status).toMatchObject({ payTo: PAYEE, price: '$0.001', lastSettlement: null, recoveredSettlements: 0 })
    expect((await get('/nope')).status).toBe(404)
  })
})

describe('paid requests', () => {
  it('get 200 with the lens data and a settlement, and cost exactly one verify and one settle', async () => {
    const { buyer, facilitator, get } = setup()
    const r = await buyer.fetchPaid(`http://app.test/v1/trove/${TROVE}`)
    expect(r.status).toBe(200)
    expect(r.paid).toBe(true)
    expect(r.unsettled).toBeNull()
    expect(r.settlement?.transaction).toBe(txHash(1))
    expect(r.authorizedMusd).toBe('0.001')
    expect(r.json).toMatchObject({ blockNumber: 123, borrower: TROVE })
    expect(facilitator.verifies).toBe(1)
    expect(facilitator.settles).toBe(1)
    const status = (await (await get('/status')).json()) as { lastSettlement: { transaction: string; path: string; recovered: boolean } }
    expect(status.lastSettlement).toMatchObject({ transaction: txHash(1), path: `/v1/trove/${TROVE}`, recovered: false })
  })

  it('pass the query of the pool route through to the lens', async () => {
    const { buyer } = setup()
    const r = await buyer.fetchPaid(`http://app.test${POOL}`)
    expect(r.json).toMatchObject({ amountIn: '0.001' })
  })

  it('are not charged when the lens fails: 502 and no settlement', async () => {
    const lens = fakeLens({ troveHealth: async () => { throw new Error('rpc down') } })
    const { buyer, facilitator } = setup({ lens })
    const r = await buyer.fetchPaid(`http://app.test/v1/trove/${TROVE}`)
    expect(r.status).toBe(502)
    expect(r.paid).toBe(false)
    expect(facilitator.settles).toBe(0)
    expect(r.unsettled?.reason).toBe('http_502') // signed, but the server never submitted it
    expect(r.json).toMatchObject({ error: 'chain read failed, try again' })
  })
})

describe('when the facilitator reports a failed settlement', () => {
  const theTransfer = (facilitator: FakeFacilitator, value = BigInt(PRICE_BASE_UNITS)) => ({
    hash: txHash(0xabc),
    value,
    input: () => `0xfa340378${signatureOf(facilitator.payloads.at(-1)!).slice(2)}`,
  })

  it('serves the answer when the payment is on chain and was made by this payment (signature in the calldata)', async () => {
    const facilitator = fakeFacilitator(receiptCrash)
    const chain = fakeChain([theTransfer(facilitator)])
    const { buyer, get } = setup({ facilitator, chain })
    const r = await buyer.fetchPaid(`http://app.test/v1/trove/${TROVE}`)
    expect(r.status).toBe(200)
    expect(r.paid).toBe(true)
    expect(r.settlement?.transaction).toBe(txHash(0xabc))
    const status = (await (await get('/status')).json()) as { recoveredSettlements: number; lastSettlement: { recovered: boolean } }
    expect(status.recoveredSettlements).toBe(1)
    expect(status.lastSettlement.recovered).toBe(true)
    // It looked for MUSD sent by the buyer to the payee, nothing broader.
    expect(chain.logCalls[0]).toMatchObject({ address: ADDRESSES.musd, args: { from: buyer.address, to: PAYEE } })
  })

  it('stays at 402 when no transfer is on chain, and tells the buyer the settlement is unconfirmed', async () => {
    const { buyer } = setup({ facilitator: fakeFacilitator(receiptCrash), chain: fakeChain([]) })
    const r = await buyer.fetchPaid(`http://app.test/v1/trove/${TROVE}`)
    expect(r.status).toBe(402)
    expect(r.paid).toBe(false)
    expect(r.json).not.toHaveProperty('blockNumber') // the lens data is withheld
    expect(r.unsettled).toMatchObject({ reason: 'unexpected_error', detail: 'An internal error was received.' })
  })

  it('does not accept an earlier payment of the same size (its transaction carries another signature)', async () => {
    const stale = { hash: txHash(0x111), value: BigInt(PRICE_BASE_UNITS), input: `0xfa340378${'ab'.repeat(65)}` }
    const { buyer } = setup({ facilitator: fakeFacilitator(receiptCrash), chain: fakeChain([stale]) })
    const r = await buyer.fetchPaid(`http://app.test/v1/trove/${TROVE}`)
    expect(r.status).toBe(402)
    expect(r.paid).toBe(false)
  })

  it('does not accept a transfer of the wrong size', async () => {
    const facilitator = fakeFacilitator(receiptCrash)
    const { buyer } = setup({ facilitator, chain: fakeChain([theTransfer(facilitator, 1n)]) })
    expect((await buyer.fetchPaid(`http://app.test/v1/trove/${TROVE}`)).status).toBe(402)
  })

  it('lets one transaction vouch for one answer only', async () => {
    const facilitator = fakeFacilitator(receiptCrash)
    const { app } = setup({ facilitator, chain: fakeChain([theTransfer(facilitator)]) })
    const fetchImpl: typeof fetch = (input, init) => Promise.resolve(app.fetch(new Request(input as Request | string, init)))
    const buyer = createBuyer({ account: testAccount(), chainReader: zeroReader, guard: guard(), fetchImpl })
    expect((await buyer.fetchPaid(`http://app.test/v1/trove/${TROVE}`)).status).toBe(200)
    // The chain still lists the same transfer, and the fake says its calldata carries the newest signature too: only the "one answer per transaction" rule stops it.
    const second = await buyer.fetchPaid(`http://app.test/v1/ve/${TROVE}`)
    expect(second.status).toBe(402)
  })

  it('lets one transaction vouch for one answer even when two recoveries run at once', async () => {
    const signature = `0x${'ab'.repeat(65)}`
    const recovery = settlementRecovery(fakeChain([{ hash: txHash(0xabc), value: BigInt(PRICE_BASE_UNITS), input: `0xfa340378${signature.slice(2)}` }]), { waitMs: 0 })
    const ctx = { paymentPayload: { payload: { signature, permit2Authorization: { from: testAccount().address } } }, requirements: { payTo: PAYEE, asset: ADDRESSES.musd, amount: PRICE_BASE_UNITS, network: NETWORK } }
    const results = await Promise.all([recovery.onSettleFailure(ctx as never), recovery.onSettleFailure(ctx as never)])
    expect(results.filter((r) => r && r.recovered)).toHaveLength(1)
  })

  it('survives a chain that cannot be read: still 402, no crash', async () => {
    const { buyer } = setup({ facilitator: fakeFacilitator(receiptCrash), chain: fakeChain([], { failReads: true }) })
    const r = await buyer.fetchPaid(`http://app.test/v1/trove/${TROVE}`)
    expect(r.status).toBe(402)
    expect(r.unsettled?.reason).toBe('unexpected_error')
  })

  it('does not look at the chain when no chain reader is given', async () => {
    const { buyer } = setup({ facilitator: fakeFacilitator(receiptCrash) })
    expect((await buyer.fetchPaid(`http://app.test/v1/trove/${TROVE}`)).status).toBe(402)
  })
})
