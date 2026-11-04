// What the live scripts read about a settlement transaction: its receipt from the Mezo testnet RPC (eth_getTransactionReceipt), which gives the status,
// the block, the sender and every log. No transaction is looked up on the block explorer.
import { parseAbiItem, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem'
import { ADDRESSES } from '../../src/config.ts'

// The ERC-20 shape: src/abis.ts only has the ERC-721 Transfer, which has the same topic but a fourth topic instead of the amount in the data.
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')

export type ReceiptReader = { getTransactionReceipt: (a: { hash: Hex }) => Promise<TransactionReceipt> }

// The public RPC often has no receipt for a mined transaction: 29 of 60 reads of one old settlement failed on 2026-11-04 (not found, no streak over 5), so a
// few tries are not enough. With 15 tries 2 seconds apart, a transaction is missed about 1 time in 30 000 if each try fails half the time.
export const RECEIPT_TRIES = 15

/**
 * The receipt of `hash`, or undefined. The public RPC sometimes answers null, "not found" or "method handler crashed" for a transaction that is already mined
 * (README), so it is asked up to `tries` times, `waitMs` apart.
 */
export async function receiptOf(pub: ReceiptReader, hash: string, tries = RECEIPT_TRIES, waitMs = 2000): Promise<TransactionReceipt | undefined> {
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, waitMs))
    const receipt = await pub.getTransactionReceipt({ hash: hash as Hex }).catch(() => undefined)
    if (receipt) return receipt
  }
  return undefined
}

/**
 * What the receipt says about one settlement: it succeeded, was mined after `afterBlock`, was sent by the facilitator and not by the buyer
 * (the buyer needs no BTC for gas), and its logs include exactly this payment: a Transfer of `amount` of MUSD from the buyer to the payee.
 */
export async function settlementProblems(
  pub: ReceiptReader,
  hash: string,
  o: { buyer: Address; payee: Address; amount: bigint; afterBlock: bigint; tries?: number; waitMs?: number },
): Promise<{ problems: string[]; block: string; sender: string }> {
  const r = await receiptOf(pub, hash, o.tries, o.waitMs)
  if (!r) return { problems: [`${hash}: the RPC gave no receipt for it`], block: '?', sender: '?' }
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const problems: string[] = []
  if (r.status !== 'success') problems.push(`${hash}: the receipt status is ${r.status}`)
  if (!(r.blockNumber > o.afterBlock)) problems.push(`${hash}: block ${r.blockNumber} is not after the start of the run (${o.afterBlock})`)
  if (same(r.from, o.buyer)) problems.push(`${hash}: sent by the buyer, not by the facilitator`)
  const paid = parseEventLogs({ abi: [TRANSFER], logs: r.logs }).some((l) => same(l.address, ADDRESSES.musd) && same(l.args.from, o.buyer) && same(l.args.to, o.payee) && l.args.value === o.amount)
  if (!paid) problems.push(`${hash}: no MUSD transfer of ${o.amount} base units from the buyer to the payee in its logs`)
  return { problems, block: String(r.blockNumber), sender: r.from }
}
