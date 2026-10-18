// Settlement recovery. The facilitator broadcasts the transfer and then polls Mezo's public RPC for the receipt. That RPC sometimes answers
// "null" or "method handler crashed" for a transaction that is already mined, and the facilitator then reports a failed settlement although the
// money has moved (seen live: about one paid call in three). Before the server withholds the data it asks the chain directly.
// "The payer's MUSD reached the payee" is not proof enough: an earlier payment of the same size would match. The proof is a transfer of the right
// size, from this payer to this payee, inside a transaction whose calldata carries THIS payment's signature. And a transaction can vouch for one
// answer only, so a payer cannot replay an old payment to get a second answer for free.
import type { AfterSettleHook, OnSettleFailureHook } from '@x402/core/server'
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

type TransferLog = { transactionHash: string | null; args: { value?: bigint } }

export interface RecoveryOptions {
  /** How far back to look for the transfer, in blocks (about 5 seconds each on Mezo). Default 150, about 12 minutes. */
  windowBlocks?: bigint
  /** How often to look, and how long to wait between looks, in case the node answering is a block behind. */
  tries?: number
  waitMs?: number
}

export interface SettlementRecovery {
  afterSettle: AfterSettleHook
  onSettleFailure: OnSettleFailureHook
  /** Settlement transactions the server vouched for after the facilitator had reported a failure. */
  recovered: ReadonlySet<string>
}

export function settlementRecovery(chain: LogReader, o: RecoveryOptions = {}): SettlementRecovery {
  const windowBlocks = o.windowBlocks ?? 150n
  const tries = o.tries ?? 3
  const waitMs = o.waitMs ?? 2000
  const used = new Set<string>() // transactions that already paid for one answer
  const recovered = new Set<string>()
  const remember = (tx: string) => {
    used.add(tx.toLowerCase())
    if (used.size > REMEMBER_MAX) used.delete(used.values().next().value as string)
  }

  const afterSettle: AfterSettleHook = async ({ result }) => {
    if (result.success && result.transaction) remember(result.transaction)
  }

  const onSettleFailure: OnSettleFailureHook = async ({ paymentPayload, requirements }) => {
    const p = paymentPayload.payload as { signature?: unknown; permit2Authorization?: { from?: string }; authorization?: { from?: string } }
    const payer = p.permit2Authorization?.from ?? p.authorization?.from
    if (typeof p.signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(p.signature)) return
    if (!payer || !isAddress(payer) || !isAddress(requirements.payTo) || !isAddress(requirements.asset) || !/^\d{1,78}$/.test(requirements.amount)) return
    const needle = p.signature.slice(2).toLowerCase()
    const want = BigInt(requirements.amount)
    for (let i = 0; i < tries; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, waitMs))
      let logs: readonly TransferLog[]
      try {
        const head = await chain.getBlockNumber()
        logs = (await chain.getLogs({
          address: requirements.asset,
          event: TRANSFER,
          args: { from: payer, to: requirements.payTo },
          fromBlock: head > windowBlocks ? head - windowBlocks : 0n,
          toBlock: head,
        })) as readonly TransferLog[]
      } catch {
        continue // The chain read failed: look again, and in the end leave the facilitator's answer as it was.
      }
      for (const log of [...logs].reverse()) {
        const hash = log.transactionHash
        if (!hash || log.args.value !== want || used.has(hash.toLowerCase())) continue
        try {
          const tx = (await chain.getTransaction({ hash })) as { input?: string } | null
          if (!tx?.input?.toLowerCase().includes(needle)) continue
        } catch {
          continue // This transaction could not be read just now; the next look tries again.
        }
        if (used.has(hash.toLowerCase())) continue // another recovery claimed it while this one waited for the read
        remember(hash)
        recovered.add(hash.toLowerCase())
        return { recovered: true as const, result: { success: true, transaction: hash, network: requirements.network, payer } }
      }
    }
  }

  return { afterSettle, onSettleFailure, recovered }
}
