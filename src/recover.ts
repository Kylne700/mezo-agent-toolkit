// Settlement recovery. The facilitator broadcasts the transfer and then polls Mezo's public RPC for the receipt. That RPC sometimes answers
// "null" or "method handler crashed" for a transaction that is already mined, and the facilitator then reports a failed settlement although the
// money has moved (seen live: about one paid call in three). Before the server withholds the data it asks the chain directly.
// "The payer's MUSD reached the payee" is not proof enough: an earlier payment of the same size would match. The proof is a transfer of the right
// size, from this payer to this payee, inside a transaction whose calldata carries THIS payment's signature. And a transaction can vouch for one
// answer only, so a payer cannot replay an old payment to get a second answer for free.
// The same proof is asked for when the facilitator reports success: its word alone never releases the data.
import type { AfterSettleHook, FacilitatorClient, OnSettleFailureHook } from '@x402/core/server'
import { isAddress, parseAbiItem } from 'viem'

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const REMEMBER_MAX = 5000

/** The slice of a viem public client recovery needs. Tests pass a fake. */
export interface LogReader {
  getBlockNumber(): Promise<bigint>
  // viem's getLogs and getTransaction are heavily generic; recovery passes plain arguments and reads the results as plain objects.
  getLogs(args: any): Promise<readonly unknown[]> // eslint-disable-line @typescript-eslint/no-explicit-any
  getTransaction(args: any): Promise<unknown> // eslint-disable-line @typescript-eslint/no-explicit-any
}

type TransferLog = { transactionHash: string | null; blockNumber: bigint | null; transactionIndex: number | null; args: { value?: bigint } }

export interface RecoveryOptions {
  /** How far back to look for the transfer, in blocks (about 5 seconds each on Mezo). Default 150, about 12 minutes. */
  windowBlocks?: bigint
  /** How often to look, and how long to wait between looks: Mezo's RPC can fail to show a mined transaction for several seconds (seen live). */
  tries?: number
  waitMs?: number
}

export interface SettlementRecovery {
  afterSettle: AfterSettleHook
  onSettleFailure: OnSettleFailureHook
  /** Settlement transactions the server vouched for after the facilitator had reported a failure. */
  recovered: ReadonlySet<string>
  /** The facilitator, except that a reported success stands only when the chain shows this payment; otherwise it becomes a failure. */
  confirming(f: FacilitatorClient): FacilitatorClient
}

export function settlementRecovery(chain: LogReader, o: RecoveryOptions = {}): SettlementRecovery {
  const windowBlocks = o.windowBlocks ?? 150n
  // 7 looks 2 s apart: 12 s of waiting plus the reads, about 18 s. With verify, the lens and the facilitator's settle (about 5-15 s) that stays under the buyer's 45 s (pay.ts).
  const tries = o.tries ?? 7
  const waitMs = o.waitMs ?? 2000
  const used = new Set<string>() // transactions that already paid for one answer
  const recovered = new Set<string>()
  const searched = new Set<string>() // signatures confirming() already searched for: the failure it reports must not start a second search
  const signatureOf = (pp: { readonly payload: unknown }) => String((pp.payload as { signature?: unknown }).signature)
  const remember = (tx: string) => {
    used.add(tx.toLowerCase())
    if (used.size > REMEMBER_MAX) used.delete(used.values().next().value as string)
  }

  const afterSettle: AfterSettleHook = async ({ result }) => {
    if (result.success && result.transaction) remember(result.transaction)
  }

  /** This payment's transfer on chain, claimed so that no other answer can use it; undefined when it is not found or cannot be read. */
  async function findOnChain(paymentPayload: { readonly payload: unknown }, requirements: { readonly payTo: string; readonly asset: string; readonly amount: string }): Promise<{ hash: string; payer: string } | undefined> {
    const p = paymentPayload.payload as { signature?: unknown; permit2Authorization?: { from?: string }; authorization?: { from?: string } }
    const payer = p.permit2Authorization?.from ?? p.authorization?.from
    if (typeof p.signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(p.signature)) return
    if (!payer || !isAddress(payer) || !isAddress(requirements.payTo) || !isAddress(requirements.asset) || !/^\d{1,78}$/.test(requirements.amount)) return
    const needle = p.signature.slice(2).toLowerCase()
    const want = BigInt(requirements.amount)
    // Every look is a few requests to a public RPC and a Worker gets 50 subrequests in all, so the search is cut to the fewest. The head is read once (the window
    // starts there and always ends at "latest", so a later look also sees what was mined meanwhile). A transaction read in full and found not to carry this signature is
    // never read again (calldata cannot change). Reads started in the same tick go out as one request on a batching client: a look's candidates are read together, and
    // the ones that could not be read at the last look are asked again together with this look's logs. So a look costs one request, two when it shows a new candidate.
    let from: bigint | undefined
    const notThis = new Set<string>()
    let unread: TransferLog[] = []
    const look = async () => {
      from ??= await chain.getBlockNumber().then((head) => (head > windowBlocks ? head - windowBlocks : 0n))
      return (await chain.getLogs({ address: requirements.asset, event: TRANSFER, args: { from: payer, to: requirements.payTo }, fromBlock: from, toBlock: 'latest' })) as readonly TransferLog[]
    }
    const readTx = async (log: TransferLog) => {
      try {
        // By block and index, not by hash: Mezo's RPC was seen answering null by hash for every mined transaction for minutes while this still worked.
        return (await chain.getTransaction({ blockNumber: log.blockNumber, index: log.transactionIndex })) as { hash?: string; input?: string } | null
      } catch {
        return null // this transaction could not be read just now
      }
    }
    /** The transaction among these that carries this payment's signature, claimed so that no other answer can use it. The others are marked foreign, or kept to be read again. */
    const carrying = (logs: TransferLog[], txs: Awaited<ReturnType<typeof readTx>>[]) => {
      for (const [k, log] of logs.entries()) {
        const hash = log.transactionHash!
        const tx = txs[k]
        if (tx?.hash?.toLowerCase() !== hash.toLowerCase() || typeof tx.input !== 'string') unread.push(log) // not the transaction the log names, or not read in full: the next look asks again
        else if (!tx.input.toLowerCase().includes(needle)) notThis.add(hash.toLowerCase())
        else if (!used.has(hash.toLowerCase())) { // else another recovery claimed it while this one waited for the read
          remember(hash)
          return { hash, payer }
        }
      }
    }
    for (let i = 0; i < tries; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, waitMs))
      const again = unread
      unread = []
      const [logs, txs] = await Promise.all([look().catch(() => undefined), Promise.all(again.map(readTx))])
      const found = carrying(again, txs)
      if (found) return found
      if (!logs) continue // The chain read failed: look again. If every look fails, nothing is vouched for.
      const asked = new Set(again.map((log) => log.transactionHash!.toLowerCase()))
      const fresh = [...logs].reverse().filter((log) => {
        const hash = log.transactionHash?.toLowerCase()
        return !!hash && log.blockNumber != null && log.transactionIndex != null && log.args.value === want && !used.has(hash) && !notThis.has(hash) && !asked.has(hash)
      })
      const hit = carrying(fresh, await Promise.all(fresh.map(readTx)))
      if (hit) return hit
    }
  }

  const onSettleFailure: OnSettleFailureHook = async ({ paymentPayload, requirements }) => {
    if (searched.delete(signatureOf(paymentPayload))) return
    const found = await findOnChain(paymentPayload, requirements)
    if (!found) return
    recovered.add(found.hash.toLowerCase())
    return { recovered: true as const, result: { success: true, transaction: found.hash, network: requirements.network, payer: found.payer } }
  }

  const confirming = (f: FacilitatorClient): FacilitatorClient => ({
    verify: (p, r) => f.verify(p, r),
    getSupported: () => f.getSupported(),
    async settle(p, r) {
      const result = await f.settle(p, r)
      if (!result.success) return result
      const found = await findOnChain(p, r)
      if (found) return { ...result, transaction: found.hash, payer: found.payer }
      searched.add(signatureOf(p))
      return { ...result, success: false, errorReason: 'not_confirmed_on_chain', errorMessage: 'the facilitator reported success, but this payment was not found on chain', transaction: '' }
    },
  })

  return { afterSettle, onSettleFailure, recovered, confirming }
}
