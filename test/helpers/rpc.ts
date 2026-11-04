// The public RPC stubbed at fetch, for counting what a Worker sends: every fetch to the RPC is one subrequest (the free plan allows 50 for a whole request), and a
// batch of JSON-RPC calls is one fetch. Tests build a real viem client over it. It answers the head, the Transfer logs of one price from `payer` to the payee, one
// transaction per log (by block and index) and block headers, and keeps the calls of every request.
import { pad, toEventSelector, toHex, type Address } from 'viem'
import { vi } from 'vitest'
import { ADDRESSES } from '../../src/config.ts'
import { PAYEE, PRICE_BASE_UNITS, txHash } from './x402.ts'

export interface RpcStub {
  /** The calls in each request, 0 for a request that was not a batch. */
  shape(): number[]
  /** Stops stubbing fetch. */
  restore(): void
}

export function stubRpc(o: {
  payer: Address
  /** Which transfers (by number, 1 and up) the n-th eth_getLogs call shows; the last entry stays for the later calls. Default: 1 and 2 at every call. */
  logs?: number[][]
  /** The calldata of transfer n's transaction; default 0x, which carries no signature. */
  input?: (n: number) => string
  /** True when the node cannot show transfer n's transaction (answers null). */
  unreadable?: (n: number) => boolean
}): RpcStub {
  const bodies: unknown[] = []
  let getLogs = 0
  const log = (n: number) => ({
    address: ADDRESSES.musd,
    blockNumber: toHex(4_990 + n),
    blockHash: txHash(n),
    transactionHash: txHash(n),
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
    topics: [toEventSelector('Transfer(address,address,uint256)'), pad(o.payer), pad(PAYEE)],
    data: toHex(BigInt(PRICE_BASE_UNITS), { size: 32 }),
  })
  const result = (method: string, params: string[]) => {
    if (method === 'eth_blockNumber') return '0x1388'
    if (method === 'eth_getLogs') {
      const shown = o.logs ?? [[1, 2]]
      return shown[Math.min(getLogs++, shown.length - 1)]!.map(log)
    }
    if (method === 'eth_getTransactionByBlockNumberAndIndex') {
      const n = Number(BigInt(params[0]!)) - 4_990
      return o.unreadable?.(n) ? null : { hash: txHash(n), input: o.input?.(n) ?? '0x', blockNumber: params[0], transactionIndex: params[1] }
    }
    return { number: '0x1', hash: txHash(1), timestamp: '0x6900a000', transactions: [] }
  }
  const answer = ({ id, method, params }: { id: number; method: string; params: string[] }) => ({ jsonrpc: '2.0', id, result: result(method, params) })
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    bodies.push(body)
    return Response.json(Array.isArray(body) ? body.map(answer) : answer(body))
  })
  return { shape: () => bodies.map((b) => (Array.isArray(b) ? b.length : 0)), restore: () => vi.unstubAllGlobals() }
}
