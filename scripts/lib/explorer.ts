// Reads of the Mezo testnet block explorer (Blockscout API), used by the live scripts to confirm that a settlement transaction really exists and moved the MUSD.
import type { Address } from 'viem'
import { ADDRESSES } from '../../src/config.ts'

const API = 'https://api.explorer.test.mezo.org/api/v2'

/** GET a path of the explorer API, retrying (it lags the chain by a few seconds) until `ready` accepts the answer. Returns the last answer, or undefined. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function explorerGet(path: string, ready: (j: any) => boolean, tries = 8, waitMs = 4000): Promise<any> {
  let j: unknown
  for (let i = 0; i < tries && !ready(j); i++) {
    if (i) await new Promise((r) => setTimeout(r, waitMs))
    j = await fetch(`${API}/${path}`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()).catch(() => undefined)
  }
  return j
}

/**
 * What the explorer says about one settlement: it succeeded, was mined after `afterBlock`, was sent by the facilitator and not by the buyer
 * (the buyer needs no BTC for gas), and its token transfers include exactly this payment: `amount` of MUSD from the buyer to the payee.
 */
export async function settlementProblems(hash: string, o: { buyer: Address; payee: Address; amount: bigint; afterBlock: bigint }): Promise<{ problems: string[]; block: string; sender: string }> {
  const tx = await explorerGet(`transactions/${hash}`, (j) => !!j?.status)
  const sender = String(tx?.from?.hash ?? '')
  const problems: string[] = []
  if (tx?.status !== 'ok') problems.push(`${hash}: explorer status is ${tx?.status}`)
  if (!(BigInt(tx?.block_number ?? 0) > o.afterBlock)) problems.push(`${hash}: block ${tx?.block_number} is not after the start of the run (${o.afterBlock})`)
  if (sender.toLowerCase() === o.buyer.toLowerCase()) problems.push(`${hash}: sent by the buyer, not by the facilitator`)
  const moves = await explorerGet(`transactions/${hash}/token-transfers`, (j) => Array.isArray(j?.items))
  const found = (moves?.items ?? []).some(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t: any) =>
      String(t.from?.hash).toLowerCase() === o.buyer.toLowerCase() &&
      String(t.to?.hash).toLowerCase() === o.payee.toLowerCase() &&
      t.total?.value === o.amount.toString() &&
      String(t.token?.address_hash ?? t.token?.address).toLowerCase() === ADDRESSES.musd.toLowerCase(),
  )
  if (!found) problems.push(`${hash}: no MUSD transfer of ${o.amount} base units from the buyer to the payee`)
  return { problems, block: String(tx?.block_number ?? '?'), sender }
}
