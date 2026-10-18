// Hard spend limits for the agent's wallet. Pure logic with no I/O, so it is unit-tested without a chain.
//
// What it enforces, for every payment the x402 client is about to sign:
//   - the scheme is "exact", the network is Mezo testnet and the asset is MUSD (nothing else can be paid);
//   - one payment is at most `perCall`;
//   - everything paid so far in this process plus this payment is at most `perSession`.
// The check and the reservation are one synchronous step, so two calls running at once cannot both squeeze under the limit.
// Reservations are never refunded: a payment that later fails still counts against the session. That errs on the side of spending less.
// The limits come from the operator (environment variables at start-up), never from tool arguments, so a prompt cannot raise them.
import { formatUnits, parseUnits } from 'viem'
import { ADDRESSES, NETWORK } from './config.ts'

export const MUSD_DECIMALS = 18
export const DEFAULT_PER_CALL_MUSD = '0.01'
export const DEFAULT_PER_SESSION_MUSD = '0.1'

export interface SpendLimits {
  /** Largest single payment, in MUSD base units (18 decimals). */
  perCall: bigint
  /** Most this process may pay in total, in MUSD base units. */
  perSession: bigint
}

/** The parts of an x402 payment requirement the guard looks at. */
export interface Requirement {
  scheme: string
  network: string
  asset: string
  amount: string
}

export type Decision = { ok: true; amount: bigint } | { ok: false; reason: string }

export interface SpendSnapshot {
  perCallMusd: string
  perSessionMusd: string
  spentMusd: string
  remainingMusd: string
  payments: number
}

const musd = (x: bigint) => formatUnits(x, MUSD_DECIMALS)

/** "0.01" -> base units. Plain decimals only: no signs, exponents or separators. */
export function parseMusd(text: string, name: string): bigint {
  if (!/^\d{1,9}(\.\d{1,18})?$/.test(text.trim())) throw new Error(`${name} must be a plain decimal MUSD amount such as 0.01`)
  return parseUnits(text.trim(), MUSD_DECIMALS)
}

export function limitsFromEnv(env: Record<string, string | undefined> = process.env): SpendLimits {
  return {
    perCall: parseMusd(env.MEZO_MAX_PER_CALL_MUSD ?? DEFAULT_PER_CALL_MUSD, 'MEZO_MAX_PER_CALL_MUSD'),
    perSession: parseMusd(env.MEZO_MAX_PER_SESSION_MUSD ?? DEFAULT_PER_SESSION_MUSD, 'MEZO_MAX_PER_SESSION_MUSD'),
  }
}

export class SpendGuard {
  readonly perCall: bigint
  readonly perSession: bigint
  private spent = 0n
  private payments = 0

  constructor(limits: SpendLimits) {
    if (limits.perCall <= 0n || limits.perSession <= 0n) throw new Error('spend limits must be greater than zero')
    if (limits.perCall > limits.perSession) throw new Error('the per-call limit cannot be larger than the per-session limit')
    this.perCall = limits.perCall
    this.perSession = limits.perSession
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): SpendGuard {
    return new SpendGuard(limitsFromEnv(env))
  }

  /** Decide and, when allowed, reserve the amount in the same synchronous step. */
  authorize(req: Requirement): Decision {
    if (req.scheme !== 'exact') return { ok: false, reason: `payment scheme "${req.scheme}" is not allowed (only "exact")` }
    if (req.network !== NETWORK) return { ok: false, reason: `network "${req.network}" is not allowed (only ${NETWORK}, Mezo testnet)` }
    if (typeof req.asset !== 'string' || req.asset.toLowerCase() !== ADDRESSES.musd.toLowerCase()) {
      return { ok: false, reason: `asset ${req.asset} is not allowed (only MUSD ${ADDRESSES.musd})` }
    }
    // A canonical non-negative integer only: "01", "1e3", "-5", "1.5" and " 7" are refused instead of being guessed at.
    if (typeof req.amount !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(req.amount)) return { ok: false, reason: `payment amount "${String(req.amount).slice(0, 40)}" is not a whole number of base units` }
    const amount = BigInt(req.amount)
    if (amount > this.perCall) return { ok: false, reason: `payment of ${musd(amount)} MUSD is over the per-call limit of ${musd(this.perCall)} MUSD` }
    if (this.spent + amount > this.perSession) {
      return { ok: false, reason: `payment of ${musd(amount)} MUSD would take this session to ${musd(this.spent + amount)} MUSD, over the session limit of ${musd(this.perSession)} MUSD (${musd(this.perSession - this.spent)} MUSD left)` }
    }
    this.spent += amount
    this.payments += 1
    return { ok: true, amount }
  }

  snapshot(): SpendSnapshot {
    return {
      perCallMusd: musd(this.perCall),
      perSessionMusd: musd(this.perSession),
      spentMusd: musd(this.spent),
      remainingMusd: musd(this.perSession - this.spent),
      payments: this.payments,
    }
  }
}
