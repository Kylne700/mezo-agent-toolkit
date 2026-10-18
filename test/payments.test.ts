// The recent-payments reader without a network: a fake chain with MUSD transfers at chosen blocks, and a record of every range the RPC was asked for.
import { parseUnits, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { ADDRESSES, EXPLORER } from '../src/config.ts'
import { DEFAULT_LIMIT, MAX_WINDOWS, WINDOW_BLOCKS, recentPayments, type PaymentsChain } from '../src/payments.ts'
import { PAYEE, txHash } from './helpers/x402.ts'

const BUYER = '0xea2D4b92DDd760959BB1D8119430640885851A91'
const RPC_LIMIT = 10_000n // measured on the public Mezo RPC: "maximum [from, to] blocks distance: 10000"

interface Hit {
  block: bigint
  index?: number
  value?: bigint
  hash?: Hex
}

function chainWith(head: bigint, hits: Hit[]) {
  const asked: { address: string; to: string; from: bigint; toBlock: bigint }[] = []
  const timesAsked: bigint[] = []
  const chain: PaymentsChain = {
    async getBlockNumber() {
      return head
    },
    async getLogs(args) {
      asked.push({ address: args.address, to: args.args.to, from: args.fromBlock, toBlock: args.toBlock })
      return hits
        .filter((h) => h.block >= args.fromBlock && h.block <= args.toBlock)
        .map((h) => ({ transactionHash: h.hash ?? txHash(Number(h.block) * 10 + (h.index ?? 0)), blockNumber: h.block, logIndex: h.index ?? 0, args: { from: BUYER, value: h.value ?? parseUnits('0.001', 18) } }))
    },
    async getBlock({ blockNumber }) {
      timesAsked.push(blockNumber)
      return { timestamp: 1_792_000_000n + blockNumber }
    },
  }
  return { chain, asked, timesAsked }
}

const read = (chain: PaymentsChain, limit?: number) => recentPayments(chain, { asset: ADDRESSES.musd, payee: PAYEE, limit })

describe('recent payments', () => {
  it('asks for MUSD transfers to the payee, newest first, with the exact amount, the block time and an explorer link', async () => {
    const { chain, asked } = chainWith(100_000n, [{ block: 99_000n }, { block: 99_990n, index: 1 }, { block: 99_990n, index: 5, value: parseUnits('0.0125', 18) }])
    const r = await read(chain)
    expect(asked[0]).toMatchObject({ address: ADDRESSES.musd, to: PAYEE })
    expect(r.payments.map((p) => [p.block, p.musd])).toEqual([[99_990, '0.0125'], [99_990, '0.001'], [99_000, '0.001']])
    expect(r.payments[0]).toMatchObject({ from: BUYER, time: new Date((1_792_000_000 + 99_990) * 1000).toISOString(), explorer: `${EXPLORER}/tx/${r.payments[0]!.transaction}` })
    expect(r).toMatchObject({ payee: PAYEE, asset: ADDRESSES.musd, head: 100_000, limit: DEFAULT_LIMIT })
  })

  it('never asks the RPC for more than its block limit at once, and the windows join without a gap or an overlap', async () => {
    const { chain, asked } = chainWith(200_000n, [])
    const r = await read(chain)
    expect(asked).toHaveLength(MAX_WINDOWS)
    for (const w of asked) expect(w.toBlock - w.from, `window ${w.from}-${w.toBlock}`).toBeLessThan(RPC_LIMIT)
    expect(asked[0]!.toBlock).toBe(200_000n)
    for (let i = 1; i < asked.length; i++) expect(asked[i]!.toBlock).toBe(asked[i - 1]!.from - 1n)
    expect(r).toMatchObject({ payments: [], searchLimitReached: true, searchedFrom: 200_000 - MAX_WINDOWS * Number(WINDOW_BLOCKS) + 1 })
  })

  it('stops as soon as it has enough rows, and keeps only the newest ones', async () => {
    const { chain, asked } = chainWith(100_000n, Array.from({ length: 25 }, (_, i) => ({ block: 99_000n + BigInt(i) })))
    const r = await read(chain)
    expect(asked).toHaveLength(1)
    expect(r.payments).toHaveLength(DEFAULT_LIMIT)
    expect(r.payments[0]!.block).toBe(99_024)
    expect(r.searchLimitReached).toBe(false)
    expect((await read(chain, 3)).payments.map((p) => p.block)).toEqual([99_024, 99_023, 99_022])
  })

  it('keeps looking back while it has fewer rows than the limit, and says so when it ran out of windows', async () => {
    const { chain, asked } = chainWith(200_000n, [{ block: 150_000n }])
    const r = await read(chain)
    expect(asked).toHaveLength(MAX_WINDOWS)
    expect(r.payments.map((p) => p.block)).toEqual([150_000])
    expect(r.searchLimitReached).toBe(true)
  })

  it('on a short chain it searches back to block 0 and does not claim older payments may exist', async () => {
    const { chain, asked } = chainWith(100_000n, [{ block: 80_000n }])
    const r = await read(chain)
    expect(asked).toHaveLength(11)
    expect(r).toMatchObject({ searchedFrom: 0, searchLimitReached: false })
    expect(r.payments).toHaveLength(1)
  })

  it('stops at the start of the chain and never asks below block 0', async () => {
    const { chain, asked } = chainWith(5_000n, [])
    const r = await read(chain)
    expect(asked).toEqual([{ address: ADDRESSES.musd, to: PAYEE, from: 0n, toBlock: 5_000n }])
    expect(r).toMatchObject({ searchedFrom: 0, searchLimitReached: false, payments: [] })
  })

  it('asks for the time of each distinct block once', async () => {
    const { chain, timesAsked } = chainWith(100_000n, [{ block: 99_990n, index: 1 }, { block: 99_990n, index: 2 }, { block: 99_000n }])
    await read(chain)
    expect(timesAsked.sort()).toEqual([99_000n, 99_990n])
  })
})
