// What a write may do. Pure logic plus one read of the operator's policy file at start-up, so it is unit-tested without a chain.
//
// The limits come only from the operator: environment variables, optionally tightened by a policy file (MEZO_POLICY_FILE).
// A write request carries nothing but to, data and value, so no tool argument or prompt can raise a cap.
// Every write must match an allow-list entry (contract + function selector). The entry decodes what the call moves from the
// calldata that will be signed, and the transaction value always counts as BTC, so a caller cannot under-declare an amount.
// Unset caps are 0 (fail closed): a call that moves MUSD or BTC (gas fees included) is refused until the operator sets a cap.
import { readFileSync } from 'node:fs'
import { decodeFunctionData, formatUnits, getAbiItem, isAddressEqual, parseUnits, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex } from 'viem'
import { borrowerOperationsAbi, erc20Abi, poolsVoterAbi, rewardsDistributorAbi, veBtcAbi } from './abis.ts'
import { ADDRESSES } from './config.ts'

export type Env = Record<string, string | undefined>

/** One contract function the write path may call. */
export interface AllowEntry {
  name: string
  contract: Address
  /** The 4-byte function selector, e.g. toFunctionSelector('transfer(address,uint256)'). */
  selector: Hex
  /** A risky action (opening a trove, a long lock): refused unless the operator sets MEZO_WRITE_RISKY=1. */
  risky?: boolean
  /** MUSD and BTC (base units, 18 decimals) the call itself moves, decoded from its calldata. The core adds the tx value as BTC. */
  amounts: (data: Hex) => { musd: bigint; btc: bigint }
}

const selectorOf = (abi: Abi, name: string): Hex => toFunctionSelector(getAbiItem({ abi, name }) as AbiFunction)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const argsOf = (abi: Abi, data: Hex): any[] => [...(decodeFunctionData({ abi, data }).args ?? [])]
const NO_FUNDS = { musd: 0n, btc: 0n }

/** A lock lasts at most 28 days (the veBTC contract also rounds the unlock time down to a Thursday 00:00 UTC). */
export const MAX_LOCK_SECONDS = 28n * 86_400n
/** More BTC than will ever exist: an approval above it is an unlimited approval. */
const UNLIMITED_BTC = 21_000_000n * 10n ** 18n
/** The poolsVoter allows at most 30 pools per vote (maxVotingNum) and the claim tool stays under the same bound. */
export const MAX_POOLS_PER_CALL = 30

// Every veBTC action moves BTC only through the exact approve and the lock; votes, pokes and claims move none of the wallet's funds.
// An amounts() that throws makes checkWrite refuse, so each entry also rejects the calldata shapes the tools never send.
const VE: readonly AllowEntry[] = [
  {
    name: 've_approve_btc',
    contract: ADDRESSES.btc,
    selector: selectorOf(erc20Abi, 'approve'),
    amounts: (data) => {
      const [spender, amount] = argsOf(erc20Abi, data)
      if (!isAddressEqual(spender, ADDRESSES.veBTC)) throw new Error('the spender must be the veBTC contract')
      if (amount === 0n || amount > UNLIMITED_BTC) throw new Error('an approval must be an exact, non-zero amount')
      return { musd: 0n, btc: amount } // counted like the lock it pays for, so the caps also bound the approval
    },
  },
  {
    name: 've_lock',
    contract: ADDRESSES.veBTC,
    selector: selectorOf(veBtcAbi, 'createLock'),
    risky: true, // the BTC stays locked until the unlock time
    amounts: (data) => {
      const [value, duration] = argsOf(veBtcAbi, data)
      if (value === 0n) throw new Error('a lock needs a non-zero amount')
      if (duration === 0n || duration > MAX_LOCK_SECONDS) throw new Error('a lock lasts at most 28 days')
      return { musd: 0n, btc: value }
    },
  },
  {
    name: 've_vote',
    contract: ADDRESSES.poolsVoter,
    selector: selectorOf(poolsVoterAbi, 'vote'),
    amounts: (data) => {
      const [, pools, weights] = argsOf(poolsVoterAbi, data)
      if (pools.length === 0 || pools.length > MAX_POOLS_PER_CALL || pools.length !== weights.length || weights.some((w: bigint) => w === 0n)) {
        throw new Error('a vote needs 1 to 30 pools with a non-zero weight each')
      }
      return NO_FUNDS
    },
  },
  { name: 've_poke', contract: ADDRESSES.poolsVoter, selector: selectorOf(poolsVoterAbi, 'poke'), amounts: () => NO_FUNDS },
  {
    name: 've_claim_rewards',
    contract: ADDRESSES.poolsVoter,
    selector: selectorOf(poolsVoterAbi, 'claimFeesAndBribes'),
    amounts: (data) => {
      const [rewards, tokens] = argsOf(poolsVoterAbi, data)
      if (rewards.length === 0 || rewards.length > MAX_POOLS_PER_CALL * 2 || rewards.length !== tokens.length) throw new Error('a claim needs matching lists of reward contracts and tokens')
      return NO_FUNDS
    },
  },
  { name: 've_claim_rebase', contract: ADDRESSES.rewardsDistributor, selector: selectorOf(rewardsDistributorAbi, 'claim'), amounts: () => NO_FUNDS },
]

// The trove calls go straight to BorrowerOperations. openTrove and addColl are payable: the BTC they carry is the tx value, which the core counts as BTC,
// so their btc is 0 here (counting it again would double it). openTrove mints MUSD (counted at the requested debt, the fee comes on top) and repayMUSD burns it.
const TROVE: readonly AllowEntry[] = [
  {
    name: 'trove_open',
    contract: ADDRESSES.borrowerOperations,
    selector: selectorOf(borrowerOperationsAbi, 'openTrove'),
    risky: true, // the collateral is locked in the trove and can be liquidated or redeemed against
    amounts: (data) => {
      const [debt] = argsOf(borrowerOperationsAbi, data)
      if (debt === 0n) throw new Error('a trove needs a non-zero debt')
      return { musd: debt, btc: 0n }
    },
  },
  { name: 'trove_add_coll', contract: ADDRESSES.borrowerOperations, selector: selectorOf(borrowerOperationsAbi, 'addColl'), amounts: () => NO_FUNDS },
  {
    name: 'trove_repay',
    contract: ADDRESSES.borrowerOperations,
    selector: selectorOf(borrowerOperationsAbi, 'repayMUSD'),
    amounts: (data) => {
      const [amount] = argsOf(borrowerOperationsAbi, data)
      if (amount === 0n) throw new Error('a repayment needs a non-zero amount')
      return { musd: amount, btc: 0n }
    },
  },
]

/** Every contract function the write path may call: the LIVE ve system and the trove calls (see docs/THREAT-MODEL.md). Nothing else is allowed, and the operator's caps still apply to each call. */
export const ALLOW: readonly AllowEntry[] = [...VE, ...TROVE]

/** Gas cap of one write; a policy file can only lower it. */
export const DEFAULT_MAX_GAS = 3_000_000n

export interface Policy {
  musdPerCall: bigint
  musdPerDay: bigint
  btcPerCall: bigint
  btcPerDay: bigint
  maxGas: bigint
  risky: boolean
  allow: readonly AllowEntry[]
}

export interface Amounts {
  musd: bigint
  btc: bigint
}

export type Check = ({ ok: true; entry: AllowEntry } & Amounts) | { ok: false; reason: string }

const FILE_KEYS = ['maxMusdPerCall', 'maxMusdPerDay', 'maxBtcPerCall', 'maxBtcPerDay', 'maxGas', 'allow', 'risky']
const fmt = (x: bigint) => formatUnits(x, 18)
const min = (a: bigint, b: bigint) => (a < b ? a : b)

/** "0.01" -> base units (MUSD and BTC both have 18 decimals). Plain decimals only, as in spend.ts. */
function amount(text: unknown, name: string): bigint {
  if (typeof text !== 'string' || !/^\d{1,9}(\.\d{1,18})?$/.test(text.trim())) throw new Error(`${name} must be a plain decimal amount such as 0.01`)
  return parseUnits(text.trim(), 18)
}

export function policyFromEnv(env: Env, allow: readonly AllowEntry[] = ALLOW): Policy {
  const p: Policy = {
    musdPerCall: amount(env.MEZO_WRITE_MAX_MUSD_PER_CALL ?? '0', 'MEZO_WRITE_MAX_MUSD_PER_CALL'),
    musdPerDay: amount(env.MEZO_WRITE_MAX_MUSD_PER_DAY ?? '0', 'MEZO_WRITE_MAX_MUSD_PER_DAY'),
    btcPerCall: amount(env.MEZO_WRITE_MAX_BTC_PER_CALL ?? '0', 'MEZO_WRITE_MAX_BTC_PER_CALL'),
    btcPerDay: amount(env.MEZO_WRITE_MAX_BTC_PER_DAY ?? '0', 'MEZO_WRITE_MAX_BTC_PER_DAY'),
    maxGas: DEFAULT_MAX_GAS,
    risky: env.MEZO_WRITE_RISKY === '1',
    allow,
  }
  if (p.musdPerCall > p.musdPerDay || p.btcPerCall > p.btcPerDay) throw new Error('a per-call cap cannot be larger than its per-day cap')
  if (!env.MEZO_POLICY_FILE) return p

  // Tighten only: each cap is the smaller of the env value and the file value, the allow-list can only shrink, risky can only be turned off.
  let f: Record<string, unknown>
  try {
    f = JSON.parse(readFileSync(env.MEZO_POLICY_FILE, 'utf8'))
  } catch {
    throw new Error('MEZO_POLICY_FILE is set but the file cannot be read as JSON')
  }
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error('the policy file must hold one JSON object')
  const unknown = Object.keys(f).filter((k) => !FILE_KEYS.includes(k))
  if (unknown.length > 0) throw new Error(`the policy file has unknown keys: ${unknown.join(', ')}`)
  const cap = (key: string, now: bigint) => (f[key] === undefined ? now : min(now, amount(f[key], `policy file ${key}`)))
  p.musdPerCall = cap('maxMusdPerCall', p.musdPerCall)
  p.musdPerDay = cap('maxMusdPerDay', p.musdPerDay)
  p.btcPerCall = cap('maxBtcPerCall', p.btcPerCall)
  p.btcPerDay = cap('maxBtcPerDay', p.btcPerDay)
  if (f.maxGas !== undefined) {
    if (!Number.isSafeInteger(f.maxGas) || (f.maxGas as number) <= 0) throw new Error('policy file maxGas must be a positive whole number')
    p.maxGas = min(p.maxGas, BigInt(f.maxGas as number))
  }
  if (f.allow !== undefined) {
    if (!Array.isArray(f.allow) || !f.allow.every((n) => typeof n === 'string')) throw new Error('policy file allow must be a list of entry names')
    const names = f.allow as string[]
    p.allow = p.allow.filter((e) => names.includes(e.name))
  }
  if (f.risky !== undefined) {
    if (typeof f.risky !== 'boolean') throw new Error('policy file risky must be true or false')
    p.risky = p.risky && f.risky
  }
  return p
}

/**
 * Decide one write from exactly what will be signed. `used` is what earlier writes used today; `fee` is the worst-case gas fee
 * in BTC once it is known (gas limit times max fee per gas), so it counts against the BTC caps too.
 */
export function checkWrite(p: Policy, tx: { to: Address; data: Hex; value: bigint }, used: Amounts, fee = 0n): Check {
  const selector = tx.data.slice(0, 10).toLowerCase()
  const entry = p.allow.find((e) => isAddressEqual(e.contract, tx.to) && e.selector.toLowerCase() === selector)
  if (!entry) return { ok: false, reason: `no allow-list entry for selector ${selector} on ${tx.to}` }
  if (entry.risky && !p.risky) return { ok: false, reason: `${entry.name} is a risky action, refused unless the operator sets MEZO_WRITE_RISKY=1` }
  let moved: Amounts
  try {
    moved = entry.amounts(tx.data)
  } catch {
    return { ok: false, reason: `cannot read the amounts in the ${entry.name} calldata` }
  }
  if (moved.musd < 0n || moved.btc < 0n || tx.value < 0n || fee < 0n) return { ok: false, reason: 'negative amounts are not allowed' }
  const musd = moved.musd
  const btc = moved.btc + tx.value + fee
  if (musd > p.musdPerCall) return { ok: false, reason: `${fmt(musd)} MUSD is over the per-call cap of ${fmt(p.musdPerCall)} MUSD` }
  if (btc > p.btcPerCall) return { ok: false, reason: `${fmt(btc)} BTC (gas fee included) is over the per-call cap of ${fmt(p.btcPerCall)} BTC` }
  if (used.musd + musd > p.musdPerDay) return { ok: false, reason: `${fmt(musd)} MUSD would pass the per-day cap of ${fmt(p.musdPerDay)} MUSD (${fmt(p.musdPerDay - min(used.musd, p.musdPerDay))} MUSD left today)` }
  if (used.btc + btc > p.btcPerDay) return { ok: false, reason: `${fmt(btc)} BTC would pass the per-day cap of ${fmt(p.btcPerDay)} BTC (${fmt(p.btcPerDay - min(used.btc, p.btcPerDay))} BTC left today)` }
  return { ok: true, entry, musd, btc }
}
