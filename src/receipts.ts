// The receipts file: one JSON line per sent write, appended after the send whatever the outcome (success, reverted, unknown).
// It is also the ledger the per-day caps read, so a line it cannot read stops writes instead of being skipped.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Address, Hex } from 'viem'
import type { Amounts } from './policy.ts'

export type Status = 'success' | 'reverted' | 'unknown'

export interface Receipt {
  /** ISO time of the policy check; its UTC day is the day the amounts count against. */
  at: string
  name: string
  from: Address
  to: Address
  selector: Hex
  nonce: number
  hash: Hex
  status: Status
  /** Base units (18 decimals) counted against the caps; btc includes the tx value and the worst-case gas fee. */
  musd: string
  btc: string
  gas: string
  maxFeePerGas: string
  note?: string
}

export function appendReceipt(file: string, r: Receipt): void {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(r)}\n`, { mode: 0o600 })
}

/** What sent writes counted on one UTC day (YYYY-MM-DD). A missing file is an empty ledger; any unreadable line throws. */
export function usedOn(file: string, day: string): Amounts {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { musd: 0n, btc: 0n }
    throw new Error('cannot read the receipts file, so writes stay off')
  }
  const used = { musd: 0n, btc: 0n }
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue
    let r: Partial<Receipt>
    try {
      r = JSON.parse(line)
    } catch {
      r = {}
    }
    if (typeof r.at !== 'string' || !/^\d+$/.test(String(r.musd)) || !/^\d+$/.test(String(r.btc))) {
      throw new Error(`line ${i + 1} of the receipts file is not a valid receipt, so writes stay off until the operator fixes it`)
    }
    if (r.at.slice(0, 10) === day) {
      used.musd += BigInt(r.musd as string)
      used.btc += BigInt(r.btc as string)
    }
  }
  return used
}
