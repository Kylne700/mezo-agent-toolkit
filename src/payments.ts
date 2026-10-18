// Recent payments to the payee, read straight from the chain: MUSD Transfer events whose recipient is the payee, newest first.
// A transfer is a payment, not proof that data was delivered (a payment can land and the seller still fail to answer; see the README).
// Mezo's public RPC refuses eth_getLogs over more than 10,000 blocks (measured: "maximum [from, to] blocks distance: 10000"), so the chain is
// searched backwards in windows of 9,500 blocks (about 12 hours) until enough rows are found or the search limit is reached.
import { formatUnits, parseAbiItem, type Address } from 'viem'
import { txUrl } from './config.ts'

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')

export const WINDOW_BLOCKS = 9_500n
export const MAX_WINDOWS = 12
export const DEFAULT_LIMIT = 10

/** The slice of a viem public client this needs. Tests pass a fake. */
export interface PaymentsChain {
  getBlockNumber(): Promise<bigint>
  getLogs(args: any): Promise<readonly any[]> // eslint-disable-line @typescript-eslint/no-explicit-any
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
}

export interface PaymentRow {
  transaction: string
  block: number
  /** Block time, ISO 8601 in UTC. */
  time: string
  from: string
  /** MUSD, exact (18 decimals, trailing zeros dropped). */
  musd: string
  explorer: string
}

export interface PaymentsResult {
  payee: string
  asset: string
  /** The newest block read, and the oldest block searched. */
  head: number
  searchedFrom: number
  /** True when the search ran out of windows before it had `limit` rows, so older payments may exist. */
  searchLimitReached: boolean
  limit: number
  payments: PaymentRow[]
}

export async function recentPayments(chain: PaymentsChain, o: { asset: Address; payee: Address; limit?: number }): Promise<PaymentsResult> {
  const limit = o.limit ?? DEFAULT_LIMIT
  const head = await chain.getBlockNumber()
  const found: { hash: string; block: bigint; index: number; from: string; value: bigint }[] = []
  let to = head
  let from = head
  let windows = 0
  while (found.length < limit && windows < MAX_WINDOWS) {
    from = to >= WINDOW_BLOCKS ? to - WINDOW_BLOCKS + 1n : 0n
    const logs = await chain.getLogs({ address: o.asset, event: TRANSFER, args: { to: o.payee }, fromBlock: from, toBlock: to })
    for (const l of logs) {
      if (l.transactionHash && l.blockNumber != null && l.args?.value != null) found.push({ hash: l.transactionHash, block: l.blockNumber, index: l.logIndex ?? 0, from: l.args.from, value: l.args.value })
    }
    windows++
    if (from === 0n) break
    to = from - 1n
  }
  found.sort((a, b) => (a.block === b.block ? b.index - a.index : a.block > b.block ? -1 : 1))
  const rows = found.slice(0, limit)
  // One call per distinct block; the Worker's client batches them into a single request.
  const blocks = [...new Set(rows.map((r) => r.block))]
  const times = new Map(await Promise.all(blocks.map(async (b) => [b, (await chain.getBlock({ blockNumber: b })).timestamp] as const)))
  return {
    payee: o.payee,
    asset: o.asset,
    head: Number(head),
    searchedFrom: Number(from),
    searchLimitReached: rows.length < limit && from > 0n,
    limit,
    payments: rows.map((r) => ({
      transaction: r.hash,
      block: Number(r.block),
      time: new Date(Number(times.get(r.block)) * 1000).toISOString(),
      from: r.from,
      musd: formatUnits(r.value, 18),
      explorer: txUrl(r.hash),
    })),
  }
}
