// The numbers the lens reports, read again straight from the protocol contracts one call at a time and never through the lens, so a script can check
// the lens (and the MCP tools and HTTP answers built on it) against an independent source at the very same block.
// Each reader returns what the answer should say: `raw` (the exact integers), `fields` (plain fields of the answer) and `shown` (the rounded text shown to people).
import { maxUint256, zeroAddress, type Address } from 'viem'
import { hintHelpersAbi, priceFeedAbi, routerAbi, sortedTrovesAbi, troveManagerAbi, veBtcAbi, veMezoAbi } from '../../src/abis.ts'
import { ADDRESSES } from '../../src/config.ts'
import { withRetry, type ReadClient } from '../../src/lens.ts'

export type Plain = Record<string, string | number | boolean | null>
/** [field of the answer, exact contract value, decimals of that value, decimal places the answer shows (truncated, never rounded)] */
export type Shown = [field: string, value: bigint, decimals: number, places: number]
export interface Direct {
  raw: Plain
  fields: Plain
  shown: Shown[]
}

const reader = (pub: ReadClient, block: bigint) => <T>(address: Address, abi: unknown, functionName: string, args: readonly unknown[] = []) =>
  withRetry(() => pub.readContract({ address, abi, functionName, args, blockNumber: block })) as Promise<T>

const A = ADDRESSES
const ratio = (coll: bigint, price: bigint, debt: bigint) => (debt === 0n ? maxUint256 : (coll * price) / debt)

/** Health of an open trove: the same arithmetic as the protocol (collateral * price / debt), from TroveManager and PriceFeed. */
export async function directTrove(pub: ReadClient, borrower: Address, block: bigint): Promise<Direct> {
  const r = reader(pub, block)
  const [price, mcr, status] = await Promise.all([r<bigint>(A.priceFeed, priceFeedAbi, 'fetchPrice'), r<bigint>(A.troveManager, troveManagerAbi, 'MCR'), r<number>(A.troveManager, troveManagerAbi, 'getTroveStatus', [borrower])])
  if (status !== 1) throw new Error(`${borrower} has no open trove at block ${block}`)
  const [coll, principal, interest] = await r<readonly bigint[]>(A.troveManager, troveManagerAbi, 'getEntireDebtAndColl', [borrower])
  const debt = principal! + interest!
  const icr = ratio(coll!, price, debt)
  const liquidationPrice = coll! > 0n ? (mcr * debt) / coll! : 0n
  const drop = coll! > 0n && price > liquidationPrice ? ((price - liquidationPrice) * 10_000n) / price : 0n
  return {
    raw: { status, coll: String(coll), principal: String(principal), interest: String(interest), debt: String(debt), price: String(price), icr: String(icr), mcr: String(mcr), liquidationPrice: String(liquidationPrice), priceDropToLiquidationBps: String(drop) },
    fields: { liquidatable: icr < mcr },
    shown: [
      ['btcPriceUsd', price, 18, 2],
      ['mcrPercent', mcr, 16, 2],
      ['collateralBtc', coll!, 18, 8],
      ['principalMusd', principal!, 18, 6],
      ['interestMusd', interest!, 18, 6],
      ['debtMusd', debt, 18, 6],
      ['icrPercent', icr, 16, 2],
      ['liquidationPriceUsd', liquidationPrice, 18, 2],
      ['priceDropToLiquidationPercent', drop, 2, 2],
    ],
  }
}

/** The trove `fromTail` places in front of the tail of the sorted list (0 is the tail itself, the first one a redemption hits). */
export async function troveFromTail(pub: ReadClient, fromTail: number, block: bigint): Promise<Address> {
  const r = reader(pub, block)
  let node = await r<Address>(A.sortedTroves, sortedTrovesAbi, 'getLast')
  for (let i = 0; i < fromTail; i++) node = await r<Address>(A.sortedTroves, sortedTrovesAbi, 'getPrev', [node])
  if (node === zeroAddress) throw new Error('the trove list is shorter than asked')
  return node
}

/**
 * Walks the sorted list from the tail one node at a time, as a redemption does, and counts what stands in front of `borrower`.
 * Stops at the borrower, or after `maxSteps` nodes (then `found` is false and `next` is the node it would visit next, as the contract reports). Short walks only.
 */
export async function directQueue(pub: ReadClient, borrower: Address, block: bigint, maxSteps = 25): Promise<Direct> {
  const r = reader(pub, block)
  const [price, mcr, gasReserve, listSize] = await Promise.all([
    r<bigint>(A.priceFeed, priceFeedAbi, 'fetchPrice'),
    r<bigint>(A.troveManager, troveManagerAbi, 'MCR'),
    r<bigint>(A.troveManager, troveManagerAbi, 'MUSD_GAS_COMPENSATION'),
    r<bigint>(A.sortedTroves, sortedTrovesAbi, 'getSize'),
  ])
  let node = await r<Address>(A.sortedTroves, sortedTrovesAbi, 'getLast')
  let steps = 0
  let ahead = 0n
  let debtAhead = 0n
  let belowMcr = 0
  let borrowerIcr: bigint | undefined
  while (node !== zeroAddress && steps < maxSteps) {
    steps++
    const [coll, principal, interest] = await r<readonly bigint[]>(A.troveManager, troveManagerAbi, 'getEntireDebtAndColl', [node])
    const debt = principal! + interest!
    const icr = ratio(coll!, price, debt)
    if (node.toLowerCase() === borrower.toLowerCase()) {
      borrowerIcr = icr
      break
    }
    if (icr < mcr) belowMcr++
    else {
      ahead++
      if (debt > gasReserve) debtAhead += debt - gasReserve
    }
    node = await r<Address>(A.sortedTroves, sortedTrovesAbi, 'getPrev', [node])
  }
  const found = borrowerIcr !== undefined
  if (!found && node === zeroAddress) throw new Error(`${borrower} is not in the trove list at block ${block}`)
  return {
    raw: { listed: true, found, truncated: !found, next: found ? zeroAddress : node, steps, ahead: String(ahead), debtAhead: String(debtAhead), belowMcr, borrowerIcr: String(borrowerIcr ?? 0n), listSize: String(listSize), price: String(price), mcr: String(mcr), walkComplete: found },
    fields: { listed: true, found, walkComplete: found, stepsWalked: steps, listSize: Number(listSize), redeemableTrovesAhead: Number(ahead), skippedBelowMcr: belowMcr, borrowerRedeemable: found ? borrowerIcr! >= mcr : null },
    shown: [
      ['redeemableMusdAhead', debtAhead, 18, 6],
      ...(found ? ([['borrowerIcrPercent', borrowerIcr!, 16, 2]] as Shown[]) : []),
      ['btcPriceUsd', price, 18, 2],
      ['mcrPercent', mcr, 16, 2],
    ],
  }
}

/** System-wide numbers, and the first trove a redemption would reach, taken from the HintHelpers contract and then confirmed by a short walk from the tail. */
export async function directSystem(pub: ReadClient, block: bigint, maxWalk = 50): Promise<Direct> {
  const r = reader(pub, block)
  const price = await r<bigint>(A.priceFeed, priceFeedAbi, 'fetchPrice')
  const [mcr, ccr, tcr, recoveryMode, size, totalColl, totalDebt, lowest, hint] = await Promise.all([
    r<bigint>(A.troveManager, troveManagerAbi, 'MCR'),
    r<bigint>(A.troveManager, troveManagerAbi, 'CCR'),
    r<bigint>(A.troveManager, troveManagerAbi, 'getTCR', [price]),
    r<boolean>(A.troveManager, troveManagerAbi, 'checkRecoveryMode', [price]),
    r<bigint>(A.sortedTroves, sortedTrovesAbi, 'getSize'),
    r<bigint>(A.troveManager, troveManagerAbi, 'getEntireSystemColl'),
    r<bigint>(A.troveManager, troveManagerAbi, 'getEntireSystemDebt'),
    r<Address>(A.sortedTroves, sortedTrovesAbi, 'getLast'),
    r<readonly [Address, bigint, bigint]>(A.hintHelpers, hintHelpersAbi, 'getRedemptionHints', [10n ** 18n, price, 0n]),
  ])
  const first = hint[0]
  const raw: Plain = { price: String(price), tcr: String(tcr), mcr: String(mcr), ccr: String(ccr), recoveryMode, redemptionsOpen: tcr >= mcr, troveCount: String(size), totalColl: String(totalColl), totalDebt: String(totalDebt), lowestNicr: lowest, firstRedeemable: first }
  const fields: Plain = { recoveryMode, redemptionsOpen: tcr >= mcr, troveCount: Number(size), firstRedeemableTrove: first === zeroAddress ? null : first }
  const shown: Shown[] = [
    ['btcPriceUsd', price, 18, 2],
    ['tcrPercent', tcr, 16, 2],
    ['mcrPercent', mcr, 16, 2],
    ['ccrPercent', ccr, 16, 2],
    ['totalCollateralBtc', totalColl, 18, 8],
    ['totalDebtMusd', totalDebt, 18, 6],
  ]
  if (first === zeroAddress) {
    fields.firstRedeemableIcrPercent = null
  } else {
    // How many troves sit below the first redeemable one, counted from the tail, and its own ratio. Skipped when the walk would be long.
    let node = lowest
    let skipped = 0
    while (node !== zeroAddress && node.toLowerCase() !== first.toLowerCase() && skipped < maxWalk) {
      skipped++
      node = await r<Address>(A.sortedTroves, sortedTrovesAbi, 'getPrev', [node])
    }
    if (node.toLowerCase() === first.toLowerCase()) {
      const [coll, principal, interest] = await r<readonly bigint[]>(A.troveManager, troveManagerAbi, 'getEntireDebtAndColl', [first])
      const icr = ratio(coll!, price, principal! + interest!)
      raw.skippedBelowMcr = skipped
      raw.scanTruncated = false
      raw.firstRedeemableIcr = String(icr)
      fields.skippedBelowMcr = skipped
      fields.scanTruncated = false
      shown.push(['firstRedeemableIcrPercent', icr, 16, 2])
    }
  }
  return { raw, fields, shown }
}

/** A swap quote from the DEX router: the output, the reserves, and the price impact worked out from a one-percent probe, as the lens does. */
export async function directPool(pub: ReadClient, tokenIn: Address, tokenOut: Address, amountIn: bigint, stable: boolean, block: bigint, decimals = 18): Promise<Direct> {
  const r = reader(pub, block)
  const factory = await r<Address>(A.poolRouter, routerAbi, 'defaultFactory')
  const [pool, reserves] = await Promise.all([r<Address>(A.poolRouter, routerAbi, 'poolFor', [tokenIn, tokenOut, stable, factory]), r<readonly [bigint, bigint]>(A.poolRouter, routerAbi, 'getReserves', [tokenIn, tokenOut, stable, factory])])
  const routes = [{ from: tokenIn, to: tokenOut, stable, factory }]
  const out = (await r<readonly bigint[]>(A.poolRouter, routerAbi, 'getAmountsOut', [amountIn, routes]))[1]!
  const probe = amountIn / 100n
  const small = probe > 0n ? (await r<readonly bigint[]>(A.poolRouter, routerAbi, 'getAmountsOut', [probe, routes]))[1]! : 0n
  const ideal = small * 100n
  const impact = ideal > out ? ((ideal - out) * 10_000n) / ideal : 0n
  return {
    raw: { poolExists: true, quoteOk: true, pool, factory, amountOut: String(out), reserveIn: String(reserves[0]), reserveOut: String(reserves[1]), impactBps: String(impact), amountIn: String(amountIn) },
    fields: { poolExists: true, quoteOk: true, pool, stable },
    shown: [
      ['amountOut', out, decimals, 8],
      ['reserveIn', reserves[0], decimals, 8],
      ['reserveOut', reserves[1], decimals, 8],
      ['priceImpactPercent', impact, 2, 2],
    ],
  }
}

export interface DirectLocks {
  fields: Plain
  locks: (Direct & { fields: Plain })[]
}

/** The first `take` locks of one owner from veBTC and veMEZO (veBTC first, as the lens lists them), with expiry worked out from the timestamp of the block. */
export async function directVe(pub: ReadClient, owner: Address, block: bigint, take = 5): Promise<DirectLocks> {
  const r = reader(pub, block)
  const timestamp = (await withRetry(() => pub.getBlock({ blockNumber: block }))).timestamp
  const [nBtc, nMezo] = await Promise.all([r<bigint>(A.veBTC, veBtcAbi, 'balanceOf', [owner]), r<bigint>(A.veMEZO, veMezoAbi, 'balanceOf', [owner])])
  const n = Math.min(Number(nBtc + nMezo), take)
  const locks: DirectLocks['locks'] = []
  for (let i = 0; i < n; i++) {
    const btc = BigInt(i) < nBtc
    const escrow = btc ? A.veBTC : A.veMEZO
    const abi = btc ? veBtcAbi : veMezoAbi
    const index = btc ? BigInt(i) : BigInt(i) - nBtc
    const tokenId = await r<bigint>(escrow, abi, 'ownerToNFTokenIdList', [owner, index])
    const l = await r<{ amount: bigint; end: bigint; isPermanent: boolean }>(escrow, abi, 'locked', [tokenId])
    const votingPower = await r<bigint>(escrow, abi, btc ? 'balanceOfNFT' : 'votingPowerOfNFT', [tokenId])
    const voted = await r<boolean>(escrow, abi, 'voted', [tokenId])
    const amount = l.amount > 0n ? l.amount : 0n
    const expired = !l.isPermanent && l.end <= timestamp
    const secondsLeft = l.isPermanent || expired ? 0n : l.end - timestamp
    locks.push({
      raw: { escrow, tokenId: String(tokenId), amount: String(amount), end: String(l.end), isPermanent: l.isPermanent, votingPower: String(votingPower), voted, secondsLeft: String(secondsLeft), expired },
      fields: { escrow: btc ? 'veBTC' : 'veMEZO', tokenId: String(tokenId), isPermanent: l.isPermanent, unlocksAt: l.isPermanent ? null : new Date(Number(l.end) * 1000).toISOString(), secondsLeft: Number(secondsLeft), expired, voted },
      shown: [
        ['amount', amount, 18, 8],
        ['votingPower', votingPower, 18, 8],
      ],
    })
  }
  return { fields: { veBtcCount: Number(nBtc), veMezoCount: Number(nMezo), returned: Math.min(Number(nBtc + nMezo), 25) }, locks }
}

// ---- comparison ------------------------------------------------------------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase()

/** Every key of `want` must be in `got` with the same value (addresses compared without case). Returns one line per difference. */
export function compare(label: string, answer: object | undefined, want: Plain): string[] {
  if (!answer) return [`${label}: missing`]
  const got = answer as Record<string, unknown>
  return Object.entries(want).flatMap(([k, w]) => (same(got[k], w) ? [] : [`${label}.${k}: answer says ${String(got[k])}, direct read says ${String(w)}`]))
}

/** The text shown to people, such as "1.5", against the exact contract value: the shown digits must be the exact value cut off (not rounded) at that many places. */
export function checkShown(label: string, answer: object, table: Shown[]): string[] {
  return table.flatMap(([field, value, decimals, places]) => {
    const got = (answer as Record<string, unknown>)[field]
    const want = value / 10n ** BigInt(decimals - places)
    const m = typeof got === 'string' ? /^(\d+)(?:\.(\d+))?$/.exec(got) : null
    const fraction = m?.[2] ?? ''
    const shown = m && fraction.length <= places ? BigInt(m[1]! + fraction.padEnd(places, '0')) : undefined
    return shown === want ? [] : [`${label}.${field}: shows ${String(got)}, but the contract value ${value} is ${want} in units of 10^-${places}`]
  })
}

/** Everything that differs between one answer and its direct reads: the exact integers under `raw`, the plain fields, and the text shown to people. */
export function differences(label: string, answer: object, want: Direct): string[] {
  return [...compare(`${label}.raw`, (answer as { raw?: object }).raw, want.raw), ...compare(label, answer, want.fields), ...checkShown(label, answer, want.shown)]
}

/** The same for a list of locks: the counts, then each lock that the direct reads cover. */
export function lockDifferences(answer: { locks: object[] }, want: DirectLocks): string[] {
  const out = compare('answer', answer, want.fields)
  if (answer.locks.length < want.locks.length) out.push(`the answer lists ${answer.locks.length} locks, direct reads found at least ${want.locks.length}`)
  want.locks.forEach((w, i) => {
    const g = answer.locks[i]
    if (g) out.push(...differences(`lock[${i}]`, g, w))
  })
  return out
}

/** The system part of a redemption answer carries only some of the system fields: compare those that are there. */
export function systemDifferences(label: string, part: object, want: Direct): string[] {
  const has = (k: string) => k in part
  return [...compare(label, part, Object.fromEntries(Object.entries(want.fields).filter(([k]) => has(k)))), ...checkShown(label, part, want.shown.filter(([f]) => has(f)))]
}
