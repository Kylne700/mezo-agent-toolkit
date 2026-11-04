// What a settlement search costs the RPC. A Worker gets 50 subrequests per request on the free plan and every request to the RPC is one of them, so the search
// must not spend more than it needs: one head read, one getLogs per look, a transaction that is not this payment is read once, and what could not be read goes out
// with the next look's logs. The proof it demands is unchanged (tests in app.test.ts); these only count.
import { createPublicClient, http } from 'viem'
import { describe, expect, it } from 'vitest'
import { ADDRESSES, NETWORK, mezoTestnet } from '../src/config.ts'
import { settlementRecovery, type LogReader } from '../src/recover.ts'
import { stubRpc } from './helpers/rpc.ts'
import { PAYEE, PRICE_BASE_UNITS, fakeChain, testAccount, txHash } from './helpers/x402.ts'

const signature = `0x${'ab'.repeat(65)}`
const payer = testAccount().address
const ctx = { paymentPayload: { payload: { signature, permit2Authorization: { from: payer } } }, requirements: { payTo: PAYEE, asset: ADDRESSES.musd, amount: PRICE_BASE_UNITS, network: NETWORK } } as never
const value = BigInt(PRICE_BASE_UNITS)
const mine = { hash: txHash(0xabc), value, input: `0xfa340378${signature.slice(2)}` }
const another = (n: number) => ({ hash: txHash(n), value, input: `0xfa340378${'cd'.repeat(65)}` })

/** The fake chain with the reads counted. `together` is the most transaction reads that were open at once. */
function counting(base: ReturnType<typeof fakeChain>, o: { headFails?: number; txFails?: number; wrongTx?: number } = {}) {
  const n = { head: 0, tx: 0, open: 0, together: 0 }
  const chain: LogReader = {
    async getBlockNumber() {
      if (n.head++ < (o.headFails ?? 0)) throw new Error('method handler crashed')
      return base.getBlockNumber()
    },
    getLogs: (args) => base.getLogs(args),
    async getTransaction(q) {
      const k = n.tx++
      n.together = Math.max(n.together, ++n.open)
      try {
        await Promise.resolve() // lets the other reads of this look start before this one answers
        if (k < (o.txFails ?? 0)) throw new Error('transaction not found')
        if (k < (o.txFails ?? 0) + (o.wrongTx ?? 0)) return { hash: txHash(0x999), input: '0x' } // the node shows another transaction at that position
        return await base.getTransaction(q)
      } finally {
        n.open--
      }
    },
  }
  return { n, chain }
}

describe('a settlement search', () => {
  it('reads the head once and asks every look for the window up to "latest": 8 requests when nothing is found', async () => {
    const base = fakeChain([])
    const c = counting(base)
    expect(await settlementRecovery(c.chain, { waitMs: 0 }).onSettleFailure(ctx)).toBeUndefined()
    expect(c.n).toMatchObject({ head: 1, tx: 0 })
    const asked = base.logCalls as { fromBlock: bigint; toBlock: string }[]
    expect(asked).toHaveLength(7)
    expect(asked.every((a) => a.fromBlock === 850n && a.toBlock === 'latest')).toBe(true) // head 1000 minus the 150-block window
  })

  it('reads a transaction that is not this payment once however many looks follow, and the candidates of a look together', async () => {
    const base = fakeChain([another(1), another(2), another(3)])
    const c = counting(base)
    expect(await settlementRecovery(c.chain, { waitMs: 0 }).onSettleFailure(ctx)).toBeUndefined()
    expect(base.logCalls).toHaveLength(7)
    expect(c.n).toMatchObject({ head: 1, tx: 3, together: 3 })
  })

  it('still finds the payment among older ones of the same size', async () => {
    const c = counting(fakeChain([another(1), mine, another(2)]))
    const r = await settlementRecovery(c.chain, { waitMs: 0 }).onSettleFailure(ctx)
    expect(r).toMatchObject({ recovered: true, result: { transaction: mine.hash } })
    expect(c.n.tx).toBe(3) // one look, one read each
  })

  it('asks again about a transaction it could not read, or that came back as another one: only a read of the calldata settles it', async () => {
    const failed = counting(fakeChain([mine]), { txFails: 2 })
    expect(await settlementRecovery(failed.chain, { waitMs: 0 }).onSettleFailure(ctx)).toMatchObject({ recovered: true })
    expect(failed.n.tx).toBe(3)
    const wrong = counting(fakeChain([mine]), { wrongTx: 2 })
    expect(await settlementRecovery(wrong.chain, { waitMs: 0 }).onSettleFailure(ctx)).toMatchObject({ recovered: true })
    expect(wrong.n.tx).toBe(3)
  })

  it('looks again when the head cannot be read, and then reads it', async () => {
    const base = fakeChain([mine])
    const c = counting(base, { headFails: 1 })
    expect(await settlementRecovery(c.chain, { waitMs: 0 }).onSettleFailure(ctx)).toMatchObject({ recovered: true })
    expect(c.n.head).toBe(2)
    expect(base.logCalls).toHaveLength(1)
  })
})

/** The same search through a real viem client over a stubbed RPC, which counts the requests (what a Worker pays) and not the calls. */
describe('a settlement search over a batching client (requests to the RPC)', () => {
  const search = async (stub: Parameters<typeof stubRpc>[0], tries: number) => {
    const sent = stubRpc(stub)
    try {
      const client = createPublicClient({ chain: mezoTestnet, transport: http('https://rpc.example.test', { batch: true }) })
      const found = await settlementRecovery(client, { waitMs: 0, tries }).onSettleFailure(ctx)
      return { found, shape: sent.shape() }
    } finally {
      sent.restore()
    }
  }
  const carries = (n: number) => (n === 1 ? `0xfa340378${signature.slice(2)}` : '0x') // transfer 1 is this payment, the others are not

  it('is three requests when the first look shows the payment: head, logs, transaction', async () => {
    const r = await search({ payer, logs: [[1]], input: carries }, 7)
    expect(r.found).toMatchObject({ recovered: true, result: { transaction: txHash(1) } })
    expect(r.shape).toEqual([1, 1, 1])
  })

  it('is eight requests when nothing is ever shown: the head once, then one request of logs per look', async () => {
    const r = await search({ payer, logs: [[]] }, 7)
    expect(r.found).toBeUndefined()
    expect(r.shape).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
  })

  it('asks again about unreadable transactions together with the next look\'s logs', async () => {
    const r = await search({ payer, logs: [[1, 2]], unreadable: () => true }, 3)
    expect(r.found).toBeUndefined()
    expect(r.shape).toEqual([1, 1, 2, 3, 3]) // head, logs, both transactions, then logs plus both again, twice
  })

  it('finds the payment at a later look once its transaction can be read', async () => {
    let reads = 0
    const r = await search({ payer, logs: [[1]], input: carries, unreadable: () => ++reads < 3 }, 7)
    expect(r.found).toMatchObject({ recovered: true })
    expect(r.shape).toEqual([1, 1, 1, 2, 2])
  })

  it('is ten requests at the very worst: an older payment of the same size, the real one shown at the second look and unreadable at all seven', async () => {
    const r = await search({ payer, logs: [[2], [2, 1]], input: carries, unreadable: (n) => n === 1 }, 7)
    expect(r.found).toBeUndefined()
    expect(r.shape).toHaveLength(10)
    expect(r.shape).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2]) // head; logs and the older one; logs and the new one; then logs plus the new one again, five times
  })
})
