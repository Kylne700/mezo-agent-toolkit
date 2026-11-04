// How the live scripts (gate, mcp:session, worker:smoke) confirm a payment: from the receipt the RPC gives. If this were too forgiving, "exactly 0.001 MUSD
// from the buyer to the payee" would pass for the wrong reasons, and a live run only ever shows the good case.
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address, type Hex, type TransactionReceipt } from 'viem'
import { describe, expect, it } from 'vitest'
import { receiptOf, settlementProblems } from '../scripts/lib/receipts.ts'
import { ADDRESSES } from '../src/config.ts'

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const buyer: Address = '0x1111111111111111111111111111111111111111'
const payee: Address = '0x2222222222222222222222222222222222222222'
const facilitator: Address = '0x3333333333333333333333333333333333333333'
const hash = `0x${'ab'.repeat(32)}`
const PRICE = 10n ** 15n
const want = { buyer, payee, amount: PRICE, afterBlock: 100n, tries: 1, waitMs: 0 }

const transfer = (token: Address, from: Address, to: Address, value: bigint) => ({
  address: token,
  topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from, to } }),
  data: encodeAbiParameters([{ type: 'uint256' }], [value]),
})
const receipt = (over: Record<string, unknown> = {}) => ({ status: 'success', blockNumber: 101n, from: facilitator, logs: [transfer(ADDRESSES.musd, buyer, payee, PRICE)], ...over }) as unknown as TransactionReceipt
const reader = (r?: TransactionReceipt) => ({
  getTransactionReceipt: async (_: { hash: Hex }) => {
    if (!r) throw new Error('Transaction receipt with hash not found')
    return r
  },
})

describe('settlementProblems', () => {
  it('has nothing to report for a settlement that succeeded, is new, was sent by the facilitator and moved exactly the price', async () => {
    expect(await settlementProblems(reader(receipt()), hash, want)).toEqual({ problems: [], block: '101', sender: facilitator })
  })

  it('accepts the payment among other logs, and addresses in any case', async () => {
    const logs = [transfer(ADDRESSES.musd, payee, facilitator, 7n), transfer(ADDRESSES.musd, buyer.toUpperCase().replace('0X', '0x') as Address, payee, PRICE)]
    expect((await settlementProblems(reader(receipt({ logs })), hash, want)).problems).toEqual([])
  })

  it.each([
    ['a failed transaction', { status: 'reverted' }, /status is reverted/],
    ['a transaction from before the run', { blockNumber: 100n }, /not after the start of the run/],
    ['a transaction the buyer sent itself', { from: buyer }, /sent by the buyer/],
    ['no logs at all', { logs: [] }, /no MUSD transfer/],
    ['a smaller amount', { logs: [transfer(ADDRESSES.musd, buyer, payee, PRICE - 1n)] }, /no MUSD transfer/],
    ['another payee', { logs: [transfer(ADDRESSES.musd, buyer, facilitator, PRICE)] }, /no MUSD transfer/],
    ['another payer', { logs: [transfer(ADDRESSES.musd, facilitator, payee, PRICE)] }, /no MUSD transfer/],
    ['the right transfer of another token', { logs: [transfer(ADDRESSES.btc, buyer, payee, PRICE)] }, /no MUSD transfer/],
  ])('reports %s', async (_what, over, problem) => {
    const { problems } = await settlementProblems(reader(receipt(over)), hash, want)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(problem)
  })

  it('reports an ERC-721 Transfer (same topic, the id indexed) as no payment', async () => {
    const nft = { address: ADDRESSES.musd, topics: [...transfer(ADDRESSES.musd, buyer, payee, 0n).topics, `0x${'00'.repeat(31)}01`], data: '0x' }
    const { problems } = await settlementProblems(reader(receipt({ logs: [nft] })), hash, want)
    expect(problems).toEqual([expect.stringMatching(/no MUSD transfer/)])
  })

  it('says so when the RPC never gives a receipt', async () => {
    expect(await settlementProblems(reader(), hash, want)).toEqual({ problems: [expect.stringContaining('gave no receipt')], block: '?', sender: '?' })
  })
})

describe('receiptOf', () => {
  it('asks again after an error or a null, and stops at the first receipt', async () => {
    let asked = 0
    const r = receipt()
    const flaky = { getTransactionReceipt: async (_: { hash: Hex }) => (++asked === 1 ? Promise.reject(new Error('method handler crashed')) : asked === 2 ? (null as unknown as TransactionReceipt) : r) }
    expect(await receiptOf(flaky, hash, 6, 0)).toBe(r)
    expect(asked).toBe(3)
  })

  it('gives up after the number of tries', async () => {
    let asked = 0
    const never = { getTransactionReceipt: async (_: { hash: Hex }) => (asked++, Promise.reject(new Error('not found'))) }
    expect(await receiptOf(never, hash, 4, 0)).toBeUndefined()
    expect(asked).toBe(4)
  })
})
