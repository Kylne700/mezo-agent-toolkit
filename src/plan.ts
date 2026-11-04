// Trove planning: what opening a trove, adding collateral or repaying MUSD would do, worked out before anything is sent.
// Reads only: no signer, no key, no node: imports, so the same code runs in the MCP server, the CLI and a Worker.
// The checks replay BorrowerOperations (read from its verified source) at ONE pinned block: net debt, the 110% / 150% ratio rules for the
// current mode, the system ratio after the change, the borrow cap and the wallet balances. A plan that breaks a rule comes back as a refusal
// with the reason and no calldata. Ratios are percent strings, BTC and MUSD are decimal strings, `value` is wei, `raw` holds the exact integers.
import { encodeFunctionData, isAddressEqual, zeroAddress, type Abi, type Address, type Hex } from 'viem'
import { borrowerOperationsAbi, erc20Abi, governableVariablesAbi, hintHelpersAbi, priceFeedAbi, sortedTrovesAbi, troveManagerAbi } from './abis.ts'
import { ADDRESSES, CHAIN_ID } from './config.ts'
import { parseAddress, parseTokenAmount } from './inputs.ts'
import { bpsPercent, fixed, isoTime, percent, TROVE_STATUS, withRetry, type Lens, type ReadClient } from './lens.ts'

const E18 = 10n ** 18n
const NICR_PRECISION = 10n ** 20n
const MAX_UINT = 2n ** 256n - 1n
const CAPACITY_RATIO = 110n * 10n ** 16n // BorrowerOperations stores a trove's borrow cap as collateral value / 1.10
const CCR_WARN = 15n * 10n ** 17n // under 150% a trove is exposed once the system falls into Recovery Mode
const TCR_WARN = 16n * 10n ** 17n // a system ratio under 160% is close to that line
const HINT_TRIALS = 15 // Liquity's advice: 15 * sqrt(troves) random trials make the hint very likely close
const GAS_MARGIN = 12n // the suggested gas limit is the estimate times 12/10

const { troveManager, sortedTroves, hintHelpers, priceFeed, borrowerOperations, musd, btc } = ADDRESSES
const isZero = (a: Address) => isAddressEqual(a, zeroAddress)
const computeCR = (coll: bigint, debt: bigint, price: bigint) => (debt > 0n ? (coll * price) / debt : MAX_UINT)
const nominalCR = (coll: bigint, debt: bigint) => (debt > 0n ? (coll * NICR_PRECISION) / debt : MAX_UINT)
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b
/** Round an 18-decimal amount UP to `places` decimals: a suggested minimum must still pass once it is shown with that many. */
const up = (x: bigint, places: number) => ceilDiv(x, 10n ** BigInt(18 - places)) * 10n ** BigInt(18 - places)
const messageOf = (e: unknown) => String((e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : e)).slice(0, 200)
const btcText = (x: bigint) => fixed(x, 18, 8)
const musdText = (x: bigint) => fixed(x, 18, 6)

/** A viem public client fits. `estimateGas` is optional: without it `gas` is null and a warning says so. */
export interface PlanClient extends ReadClient {
  estimateGas?(args: any): Promise<bigint> // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** The planner needs one thing from the lens: the redemption walk. */
export type PlanLens = Pick<Lens, 'redemptionRisk'>

export interface PlanMeta {
  blockNumber: number
  blockTime: string
  chainId: number
}
export interface Hints {
  /** SortedTroves neighbour with the higher ratio (the first hint argument). */
  upper: Address
  /** Neighbour with the lower ratio (the second hint argument). */
  lower: Address
  /** The nominal ratio (collateral * 1e20 / principal) the hints were searched for. */
  nicr: string
  approxHint: Address
}
export interface McrDistance {
  /** Percentage points of ICR above the minimum ratio. */
  marginPoints: string
  priceDropToLiquidationPercent: string
  liquidationPriceUsd: string
}
export interface RedemptionPosition {
  /** Redeemable MUSD that a redemption must take before it reaches this trove. */
  musdAhead: string
  trovesAhead: number
  skippedBelowMcr: number
  /** False when the walk hit its step cap: the figures are lower bounds. */
  walkComplete: boolean
  redemptionsOpen: boolean
  basis: string
}
export interface TroveNumbers {
  collateralBtc: string
  principalMusd: string
  interestMusd: string
  debtMusd: string
  /** Debt without the 200 MUSD gas reserve: what minNetDebt is checked against. */
  netDebtMusd: string
}

export type Action = 'open' | 'top_up' | 'repay'
export interface PlanOk extends PlanMeta {
  refused: false
  action: Action
  borrower: Address
  to: Address
  data: Hex
  /** Wei of BTC the transaction carries. */
  value: string
  /** Suggested gas limit (estimate +20%), or null when the simulation failed (see warnings). */
  gas: string | null
  hints: Hints
  trove: { before: TroveNumbers | null; after: TroveNumbers }
  /** Only for an open: the 0.1% borrowing fee in MUSD (0 in Recovery Mode or for a fee-exempt account). */
  feeMusd?: string
  icrBefore: string | null
  icrAfter: string
  mcrDistance: McrDistance
  recoveryMode: boolean
  tcr: string
  tcrAfter: string
  /** The trove's stored borrow cap in MUSD (set at open; adding collateral does not raise it). */
  maxBorrowingCapacity: string
  redemptionPosition: RedemptionPosition | null
  warnings: string[]
  summary: string
  raw: Record<string, string>
}
export interface PlanRefused extends PlanMeta {
  refused: true
  action: Action
  borrower: Address
  reason: string
  recoveryMode: boolean
  tcr: string
  icrBefore: string | null
  icrAfter: string | null
  maxBorrowingCapacity: string | null
  warnings: string[]
  summary: string
  raw: Record<string, string>
}
export type Plan = PlanOk | PlanRefused

export interface TroveStatus extends PlanMeta {
  borrower: Address
  status: string
  active: boolean
  trove: TroveNumbers | null
  icr: string | null
  mcrDistance: McrDistance | null
  liquidatable: boolean | null
  btcPriceUsd: string
  tcr: string
  recoveryMode: boolean
  maxBorrowingCapacity: string | null
  redemptionPosition: RedemptionPosition | null
  warnings: string[]
  summary: string
  raw: Record<string, string>
}

export interface PlanOptions {
  /** Read at this block instead of the latest one. */
  blockNumber?: bigint
}
export interface Planner {
  open(input: { address: string; collateralBtc: string; debtMusd: string }, o?: PlanOptions): Promise<Plan>
  topUp(input: { address: string; amountBtc: string }, o?: PlanOptions): Promise<Plan>
  repay(input: { address: string; amountMusd: string }, o?: PlanOptions): Promise<Plan>
  status(input: { address: string }, o?: PlanOptions): Promise<TroveStatus>
}

interface World extends PlanMeta {
  block: bigint
  price: bigint
  mcr: bigint
  ccr: bigint
  gasComp: bigint
  minNetDebt: bigint
  rate: bigint
  sysColl: bigint
  sysDebt: bigint
  tcr: bigint
  recoveryMode: boolean
  /** The number of troves in the list, for the hint search. */
  troveCount: bigint
  read<T>(address: Address, abi: Abi, fn: string, args?: readonly unknown[]): Promise<T>
}
interface Own {
  status: number
  active: boolean
  coll: bigint
  principal: bigint
  interest: bigint
  debt: bigint
  capacity: bigint
  icr: bigint
}

const BASIS =
  'A redemption takes the lowest-ratio trove first and walks toward the highest, skipping troves under the minimum ratio; each trove offers its debt (principal + interest) minus the 200 MUSD gas reserve. ' +
  'musdAhead adds that up for the redeemable troves the sorted list puts before this trove, read with the MezoLens redemption walk at this block; a redemption has to be larger than it to reach this trove.'

export function createPlanner(client: PlanClient, lens: PlanLens): Planner {
  async function world(at?: bigint): Promise<World> {
    const block = at ?? (await withRetry(() => client.getBlockNumber()))
    const read = <T>(address: Address, abi: Abi, fn: string, args: readonly unknown[] = []) =>
      withRetry(() => client.readContract({ address, abi, functionName: fn, args, blockNumber: block }) as Promise<T>)
    const [b, price, mcr, ccr, gasComp, sysColl, sysDebt, minNetDebt, rate, troveCount] = await Promise.all([
      withRetry(() => client.getBlock({ blockNumber: block })),
      read<bigint>(priceFeed, priceFeedAbi, 'fetchPrice'),
      read<bigint>(troveManager, troveManagerAbi, 'MCR'),
      read<bigint>(troveManager, troveManagerAbi, 'CCR'),
      read<bigint>(troveManager, troveManagerAbi, 'MUSD_GAS_COMPENSATION'),
      read<bigint>(troveManager, troveManagerAbi, 'getEntireSystemColl'),
      read<bigint>(troveManager, troveManagerAbi, 'getEntireSystemDebt'),
      read<bigint>(borrowerOperations, borrowerOperationsAbi, 'minNetDebt'),
      read<bigint>(borrowerOperations, borrowerOperationsAbi, 'borrowingRate'),
      read<bigint>(troveManager, troveManagerAbi, 'getTroveOwnersCount'),
    ])
    const tcr = computeCR(sysColl, sysDebt, price)
    return { block, blockNumber: Number(block), blockTime: isoTime(b.timestamp), chainId: CHAIN_ID, price, mcr, ccr, gasComp, minNetDebt, rate, sysColl, sysDebt, tcr, recoveryMode: tcr < ccr, troveCount, read }
  }

  async function ownOf(w: World, who: Address): Promise<Own> {
    const [status, e, capacity] = await Promise.all([
      w.read<number>(troveManager, troveManagerAbi, 'getTroveStatus', [who]),
      w.read<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>(troveManager, troveManagerAbi, 'getEntireDebtAndColl', [who]),
      w.read<bigint>(troveManager, troveManagerAbi, 'getTroveMaxBorrowingCapacity', [who]),
    ])
    const [coll, principal, interest] = e // pending redistribution and accrued interest are already inside these three
    const debt = principal + interest
    return { status: Number(status), active: Number(status) === 1, coll, principal, interest, debt, capacity, icr: computeCR(coll, debt, w.price) }
  }

  const numbers = (coll: bigint, principal: bigint, interest: bigint, gasComp: bigint): TroveNumbers => ({
    collateralBtc: btcText(coll),
    principalMusd: musdText(principal),
    interestMusd: musdText(interest),
    debtMusd: musdText(principal + interest),
    netDebtMusd: musdText(principal + interest > gasComp ? principal + interest - gasComp : 0n),
  })

  function distance(w: World, coll: bigint, debt: bigint, icr: bigint): McrDistance {
    const liquidationPrice = coll > 0n ? (w.mcr * debt) / coll : 0n
    const dropBps = w.price > liquidationPrice ? ((w.price - liquidationPrice) * 10_000n) / w.price : 0n
    return { marginPoints: icr > w.mcr ? percent(icr - w.mcr) : '0', priceDropToLiquidationPercent: bpsPercent(dropBps), liquidationPriceUsd: fixed(liquidationPrice, 18, 2) }
  }

  const refuse = (w: World, action: Action, borrower: Address, reason: string, more: { icrBefore?: bigint; icrAfter?: bigint; capacity?: bigint; raw?: Record<string, string> } = {}): PlanRefused => ({
    refused: true,
    action,
    borrower,
    blockNumber: w.blockNumber,
    blockTime: w.blockTime,
    chainId: w.chainId,
    reason,
    recoveryMode: w.recoveryMode,
    tcr: percent(w.tcr),
    icrBefore: more.icrBefore === undefined ? null : percent(more.icrBefore),
    icrAfter: more.icrAfter === undefined ? null : percent(more.icrAfter),
    maxBorrowingCapacity: more.capacity === undefined ? null : musdText(more.capacity),
    warnings: [],
    summary: `Refused at block ${w.blockNumber}, nothing to send: ${reason}`,
    raw: { price: w.price.toString(), tcr: w.tcr.toString(), ...more.raw },
  })

  /** The SortedTroves neighbours for a trove with this nominal ratio. For a trove already in the list the lookup still sees its old node, so a neighbour that is the trove itself is replaced by the node beyond it. */
  async function hintsFor(w: World, nicr: bigint, own?: Address): Promise<Hints> {
    const size = w.troveCount
    if (size === 0n) return { upper: zeroAddress, lower: zeroAddress, nicr: nicr.toString(), approxHint: zeroAddress }
    const trials = BigInt(Math.ceil(HINT_TRIALS * Math.sqrt(Number(size))))
    const [approx] = await w.read<readonly [Address, bigint, bigint]>(hintHelpers, hintHelpersAbi, 'getApproxHint', [nicr, trials, w.block])
    let [upper, lower] = await w.read<readonly [Address, Address]>(sortedTroves, sortedTrovesAbi, 'findInsertPosition', [nicr, approx, approx])
    if (own && isAddressEqual(upper, own)) upper = await w.read<Address>(sortedTroves, sortedTrovesAbi, 'getPrev', [own])
    if (own && isAddressEqual(lower, own)) lower = await w.read<Address>(sortedTroves, sortedTrovesAbi, 'getNext', [own])
    return { upper, lower, nicr: nicr.toString(), approxHint: approx }
  }

  /** What one trove adds to a redemption walk: counted only at or above the minimum ratio, and only its debt above the gas reserve (as the lens counts it). */
  const share = (w: World, coll: bigint, debt: bigint) => (computeCR(coll, debt, w.price) >= w.mcr ? { counted: true, musd: debt > w.gasComp ? debt - w.gasComp : 0n } : { counted: false, musd: 0n })

  /**
   * Debt a redemption must take before it reaches a trove sitting at the spot below `upper` (the new spot after a change). The lens walk from the
   * tail up to `upper` counts every node strictly below it, which is every node the new spot is above. When there is no upper neighbour the spot is
   * the head: the walk to the head plus the head itself. A trove that already exists sits below that spot (its ratio only goes up), so its old
   * share is taken out. An unchanged ratio keeps the spot: that is just the trove's current position.
   */
  async function positionAfter(w: World, hints: Hints, self: { address: Address; own: Own } | null, unchanged: boolean): Promise<RedemptionPosition | null> {
    if (self && unchanged) return positionOf(await lens.redemptionRisk(self.address, { blockNumber: w.block }), 'This is the trove\'s current spot: the change does not move it.')
    let anchor = hints.upper
    let head: { counted: boolean; musd: bigint } | null = null
    if (isZero(anchor)) {
      anchor = await w.read<Address>(sortedTroves, sortedTrovesAbi, 'getFirst')
      if (isZero(anchor)) return { musdAhead: '0', trovesAhead: 0, skippedBelowMcr: 0, walkComplete: true, redemptionsOpen: w.tcr >= w.mcr, basis: `${BASIS} The list is empty, so nothing is ahead.` }
      const h = await w.read<readonly [bigint, bigint, bigint]>(troveManager, troveManagerAbi, 'getEntireDebtAndColl', [anchor])
      head = share(w, h[0], h[1] + h[2])
    }
    const r = await lens.redemptionRisk(anchor, { blockNumber: w.block })
    let musdAhead = BigInt(r.raw.debtAhead as string)
    let trovesAhead = r.redeemableTrovesAhead
    let skipped = r.skippedBelowMcr
    const move = (s: { counted: boolean; musd: bigint }, sign: 1 | -1) => {
      musdAhead += BigInt(sign) * s.musd
      if (s.counted) trovesAhead += sign
      else skipped += sign
    }
    if (head) move(head, 1)
    if (self) move(share(w, self.own.coll, self.own.debt), -1)
    return {
      musdAhead: musdText(musdAhead),
      trovesAhead,
      skippedBelowMcr: skipped,
      walkComplete: r.walkComplete,
      redemptionsOpen: r.system.redemptionsOpen,
      basis: `${BASIS} Counted for the spot after this change (between ${hints.upper} and ${hints.lower}${self ? "; the trove's own old debt is taken out" : ''}).`,
    }
  }

  const positionOf = (r: Awaited<ReturnType<Lens['redemptionRisk']>>, note: string): RedemptionPosition => ({
    musdAhead: r.redeemableMusdAhead,
    trovesAhead: r.redeemableTrovesAhead,
    skippedBelowMcr: r.skippedBelowMcr,
    walkComplete: r.walkComplete,
    redemptionsOpen: r.system.redemptionsOpen,
    basis: `${BASIS} ${note}`,
  })

  /** Hints, position, gas and warnings for a plan that passed every rule. */
  async function build(
    w: World,
    p: {
      action: Action
      borrower: Address
      value: bigint
      encode(upper: Address, lower: Address): Hex
      self: { address: Address; own: Own } | null
      after: { coll: bigint; principal: bigint; interest: bigint }
      icrAfter: bigint
      tcrAfter: bigint
      capacity: bigint
      fee?: bigint
      sentence: string
      warnings: string[]
      raw: Record<string, string>
    },
  ): Promise<PlanOk> {
    const warnings = [...p.warnings]
    const nicr = nominalCR(p.after.coll, p.after.principal)
    const hints = await hintsFor(w, nicr, p.self?.address)
    const data = p.encode(hints.upper, hints.lower)
    const unchanged = p.self !== null && nominalCR(p.self.own.coll, p.self.own.principal) === nicr
    let position: RedemptionPosition | null = null
    try {
      position = await positionAfter(w, hints, p.self, unchanged)
    } catch (e) {
      warnings.push(`the redemption position could not be read (${messageOf(e)}); the rest of the plan is unaffected`)
    }
    let gas: string | null = null
    if (!client.estimateGas) warnings.push('this client cannot simulate, so there is no gas estimate')
    else {
      try {
        // At the latest block, not the plan's: a node a block behind (or one that pruned that block) would refuse a pinned estimate; gas hardly depends on the block.
        gas = ((await withRetry(() => client.estimateGas!({ account: p.borrower, to: borrowerOperations, data, value: p.value }))) * GAS_MARGIN / 10n).toString()
      } catch (e) {
        warnings.push(`the gas estimate failed (${messageOf(e)}): the chain may still refuse this call, so do not send it until you know why`)
      }
    }
    const debt = p.after.principal + p.after.interest
    if (p.icrAfter < CCR_WARN) warnings.push(`the ratio after this is ${percent(p.icrAfter)}%, under ${percent(CCR_WARN)}%: if the system falls into Recovery Mode this trove can be liquidated`)
    if (p.tcrAfter < TCR_WARN) warnings.push(`the system ratio after this is ${percent(p.tcrAfter)}%, close to the ${percent(w.ccr)}% Recovery Mode line`)
    if (w.recoveryMode) warnings.push(`the system is in Recovery Mode (system ratio ${percent(w.tcr)}% is under ${percent(w.ccr)}%)`)
    if (position && !position.walkComplete) warnings.push('the redemption walk hit its step cap, so the position is a lower bound')
    if (position && position.trovesAhead === 0 && position.walkComplete) warnings.push('no redeemable trove is ahead of this one: it is first in line for a redemption')
    const before = p.self ? numbers(p.self.own.coll, p.self.own.principal, p.self.own.interest, w.gasComp) : null
    const after = numbers(p.after.coll, p.after.principal, p.after.interest, w.gasComp)
    const d = distance(w, p.after.coll, debt, p.icrAfter)
    return {
      refused: false,
      action: p.action,
      borrower: p.borrower,
      blockNumber: w.blockNumber,
      blockTime: w.blockTime,
      chainId: w.chainId,
      to: borrowerOperations,
      data,
      value: p.value.toString(),
      gas,
      hints,
      trove: { before, after },
      ...(p.fee === undefined ? {} : { feeMusd: musdText(p.fee) }),
      icrBefore: p.self ? percent(p.self.own.icr) : null,
      icrAfter: percent(p.icrAfter),
      mcrDistance: d,
      recoveryMode: w.recoveryMode,
      tcr: percent(w.tcr),
      tcrAfter: percent(p.tcrAfter),
      maxBorrowingCapacity: musdText(p.capacity),
      redemptionPosition: position,
      warnings,
      summary: `${p.sentence} Ratio after: ${percent(p.icrAfter)}%, ${d.marginPoints} points above the ${percent(w.mcr)}% minimum (liquidation if BTC falls ${d.priceDropToLiquidationPercent}% to $${d.liquidationPriceUsd}). ${
        w.recoveryMode ? 'The system is in Recovery Mode' : 'The system is not in Recovery Mode'
      } (system ratio ${percent(w.tcr)}%).${position ? ` Redemption position: ${position.musdAhead} MUSD of redeemable debt across ${position.trovesAhead} trove(s) is ahead of it.` : ''}${warnings.length ? ` ${warnings.length} warning(s).` : ''}`,
      raw: {
        ...p.raw,
        price: w.price.toString(),
        icrAfter: p.icrAfter.toString(),
        tcr: w.tcr.toString(),
        tcrAfter: p.tcrAfter.toString(),
        nicr: nicr.toString(),
        maxBorrowingCapacity: p.capacity.toString(),
        collateralAfter: p.after.coll.toString(),
        principalAfter: p.after.principal.toString(),
        interestAfter: p.after.interest.toString(),
      },
    }
  }

  /** The ratio rules of the current mode, as BorrowerOperations applies them. Returns a reason, or undefined when the change is allowed. */
  function modeRule(w: World, icrAfter: bigint, tcrAfter: bigint, open: boolean): string | undefined {
    if (w.recoveryMode) {
      // In Recovery Mode an open must reach the 150% line; adding collateral or repaying is allowed as it is.
      return open && icrAfter < w.ccr ? `the system is in Recovery Mode (system ratio ${percent(w.tcr)}% is under ${percent(w.ccr)}%), where a new trove needs a ratio of at least ${percent(w.ccr)}%; this one would have ${percent(icrAfter)}%` : undefined
    }
    if (icrAfter < w.mcr) return `the trove would have a ratio of ${percent(icrAfter)}%, under the ${percent(w.mcr)}% minimum`
    if (tcrAfter < w.ccr) return `the change would push the system ratio from ${percent(w.tcr)}% to ${percent(tcrAfter)}%, under the ${percent(w.ccr)}% line (the system would fall into Recovery Mode)`
    return undefined
  }

  const planner: Planner = {
    async open(input, o) {
      const borrower = parseAddress(input.address, 'address')
      const coll = parseTokenAmount(input.collateralBtc, 18, 'collateralBtc')
      const debt = parseTokenAmount(input.debtMusd, 18, 'debtMusd')
      const w = await world(o?.blockNumber)
      const [own, exemptRegistry, balance] = await Promise.all([
        ownOf(w, borrower),
        w.read<Address>(borrowerOperations, borrowerOperationsAbi, 'governableVariables'),
        w.read<bigint>(btc, erc20Abi, 'balanceOf', [borrower]),
      ])
      if (own.active) return refuse(w, 'open', borrower, `${borrower} already has an open trove (ratio ${percent(own.icr)}%); use plan_top_up or plan_repay on it`, { icrBefore: own.icr, capacity: own.capacity })
      const exempt = isZero(exemptRegistry) ? false : await w.read<boolean>(exemptRegistry, governableVariablesAbi, 'isAccountFeeExempt', [borrower])
      const fee = w.recoveryMode || exempt ? 0n : (debt * w.rate) / E18
      const netDebt = debt + fee
      const composite = netDebt + w.gasComp
      const icr = computeCR(coll, composite, w.price)
      const capacity = (coll * w.price) / CAPACITY_RATIO
      const tcrAfter = computeCR(w.sysColl + coll, w.sysDebt + composite, w.price)
      const raw = { collateral: coll.toString(), debt: debt.toString(), fee: fee.toString(), netDebt: netDebt.toString(), compositeDebt: composite.toString(), minNetDebt: w.minNetDebt.toString() }
      if (netDebt < w.minNetDebt) {
        let need = ceilDiv(w.minNetDebt * E18, E18 + (w.recoveryMode || exempt ? 0n : w.rate))
        while (need + (w.recoveryMode || exempt ? 0n : (need * w.rate) / E18) < w.minNetDebt) need++
        return refuse(w, 'open', borrower, `the net debt would be ${musdText(netDebt)} MUSD (${musdText(debt)} requested + ${musdText(fee)} fee), under the ${musdText(w.minNetDebt)} MUSD minimum; ask for at least ${musdText(up(need, 6))} MUSD`, { icrAfter: icr, capacity, raw })
      }
      const rule = modeRule(w, icr, tcrAfter, true)
      if (rule) {
        // The stored borrow cap (collateral value / 1.10) is the same limit as the 110% rule, so it is named here rather than checked twice.
        const room = capacity > w.gasComp ? capacity - w.gasComp : 0n
        return refuse(w, 'open', borrower, `${rule}; this collateral carries at most ${musdText(capacity)} MUSD of total debt (about ${musdText(room)} MUSD borrowed after the ${musdText(w.gasComp)} MUSD gas reserve, before the fee)`, { icrAfter: icr, capacity, raw })
      }
      if (balance < coll) return refuse(w, 'open', borrower, `the wallet holds ${btcText(balance)} BTC, less than the ${btcText(coll)} BTC collateral`, { icrAfter: icr, capacity, raw })
      const warnings = exempt ? ['this account is exempt from the borrowing fee'] : []
      return build(w, {
        action: 'open',
        borrower,
        value: coll,
        encode: (upper, lower) => encodeFunctionData({ abi: borrowerOperationsAbi, functionName: 'openTrove', args: [debt, upper, lower] }),
        self: null,
        after: { coll, principal: composite, interest: 0n },
        icrAfter: icr,
        tcrAfter,
        capacity,
        fee,
        sentence: `Open a trove at block ${w.blockNumber}: deposit ${btcText(coll)} BTC and receive ${musdText(debt)} MUSD (fee ${musdText(fee)} MUSD; ${musdText(w.gasComp)} MUSD more is held back as the gas reserve), so the debt is ${musdText(composite)} MUSD.`,
        warnings,
        raw,
      })
    },

    async topUp(input, o) {
      const borrower = parseAddress(input.address, 'address')
      const add = parseTokenAmount(input.amountBtc, 18, 'amountBtc')
      const w = await world(o?.blockNumber)
      const [own, balance] = await Promise.all([ownOf(w, borrower), w.read<bigint>(btc, erc20Abi, 'balanceOf', [borrower])])
      if (!own.active) return refuse(w, 'top_up', borrower, `${borrower} has no open trove to add collateral to (status: ${TROVE_STATUS[own.status] ?? own.status})`)
      const newColl = own.coll + add
      const icr = computeCR(newColl, own.debt, w.price)
      const tcrAfter = computeCR(w.sysColl + add, w.sysDebt, w.price)
      const raw = { added: add.toString(), icrBefore: own.icr.toString() }
      const rule = modeRule(w, icr, tcrAfter, false)
      if (rule) {
        const needed = ceilDiv(w.mcr * own.debt, w.price) // smallest collateral that reaches the minimum ratio
        const more = needed > own.coll ? needed - own.coll : 0n
        return refuse(w, 'top_up', borrower, `${rule} (outside Recovery Mode even a pure top-up must leave the trove at ${percent(w.mcr)}% or more; adding at least ${btcText(up(more, 8))} BTC would)`, { icrBefore: own.icr, icrAfter: icr, capacity: own.capacity, raw })
      }
      if (balance < add) return refuse(w, 'top_up', borrower, `the wallet holds ${btcText(balance)} BTC, less than the ${btcText(add)} BTC to add`, { icrBefore: own.icr, icrAfter: icr, capacity: own.capacity, raw })
      const warnings = own.icr < w.mcr ? [`the trove is below the ${percent(w.mcr)}% minimum now (${percent(own.icr)}%): it can be liquidated until this is mined`] : []
      return build(w, {
        action: 'top_up',
        borrower,
        value: add,
        encode: (upper, lower) => encodeFunctionData({ abi: borrowerOperationsAbi, functionName: 'addColl', args: [upper, lower] }),
        self: { address: borrower, own },
        after: { coll: newColl, principal: own.principal, interest: own.interest },
        icrAfter: icr,
        tcrAfter,
        capacity: own.capacity,
        sentence: `Add ${btcText(add)} BTC to the trove at block ${w.blockNumber}: collateral ${btcText(own.coll)} -> ${btcText(newColl)} BTC, ratio ${percent(own.icr)}% -> ${percent(icr)}%. The borrow cap stays ${musdText(own.capacity)} MUSD and only limits borrowing more, which this does not do.`,
        warnings,
        raw,
      })
    },

    async repay(input, o) {
      const borrower = parseAddress(input.address, 'address')
      const amount = parseTokenAmount(input.amountMusd, 18, 'amountMusd')
      const w = await world(o?.blockNumber)
      const [own, balance] = await Promise.all([ownOf(w, borrower), w.read<bigint>(musd, erc20Abi, 'balanceOf', [borrower])])
      if (!own.active) return refuse(w, 'repay', borrower, `${borrower} has no open trove to repay (status: ${TROVE_STATUS[own.status] ?? own.status})`)
      const netDebt = own.debt > w.gasComp ? own.debt - w.gasComp : 0n
      const raw = { repaid: amount.toString(), debt: own.debt.toString(), netDebt: netDebt.toString(), minNetDebt: w.minNetDebt.toString(), musdBalance: balance.toString() }
      if (amount > netDebt) return refuse(w, 'repay', borrower, `${musdText(amount)} MUSD is more than the trove can repay: its debt is ${musdText(own.debt)} MUSD and the ${musdText(w.gasComp)} MUSD gas reserve stays, so at most ${musdText(netDebt)} MUSD`, { icrBefore: own.icr, capacity: own.capacity, raw })
      if (netDebt - amount < w.minNetDebt) {
        const most = netDebt > w.minNetDebt ? netDebt - w.minNetDebt : 0n
        return refuse(w, 'repay', borrower, `the net debt would fall to ${musdText(netDebt - amount)} MUSD, under the ${musdText(w.minNetDebt)} MUSD minimum; repay at most ${musdText(most)} MUSD`, { icrBefore: own.icr, capacity: own.capacity, raw })
      }
      const newDebt = own.debt - amount
      const icr = computeCR(own.coll, newDebt, w.price)
      const tcrAfter = computeCR(w.sysColl, w.sysDebt - amount, w.price)
      const rule = modeRule(w, icr, tcrAfter, false)
      if (rule) {
        const fits = (own.coll * w.price) / w.mcr // the most debt that keeps the minimum ratio
        return refuse(w, 'repay', borrower, `${rule}; repaying at least ${musdText(up(own.debt > fits ? own.debt - fits : 0n, 6))} MUSD would reach ${percent(w.mcr)}%`, { icrBefore: own.icr, icrAfter: icr, capacity: own.capacity, raw })
      }
      if (balance < amount) return refuse(w, 'repay', borrower, `the wallet holds ${musdText(balance)} MUSD, less than the ${musdText(amount)} MUSD to repay`, { icrBefore: own.icr, icrAfter: icr, capacity: own.capacity, raw })
      // The repayment pays the interest first; only what is left reduces the principal (and so the trove's place in the sorted list).
      const interestPaid = amount < own.interest ? amount : own.interest
      const warnings = own.icr < w.mcr ? [`the trove is below the ${percent(w.mcr)}% minimum now (${percent(own.icr)}%): it can be liquidated until this is mined`] : []
      return build(w, {
        action: 'repay',
        borrower,
        value: 0n,
        encode: (upper, lower) => encodeFunctionData({ abi: borrowerOperationsAbi, functionName: 'repayMUSD', args: [amount, upper, lower] }),
        self: { address: borrower, own },
        after: { coll: own.coll, principal: own.principal - (amount - interestPaid), interest: own.interest - interestPaid },
        icrAfter: icr,
        tcrAfter,
        capacity: own.capacity,
        sentence: `Repay ${musdText(amount)} MUSD at block ${w.blockNumber}: debt ${musdText(own.debt)} -> ${musdText(newDebt)} MUSD (net debt ${musdText(netDebt - amount)}, minimum ${musdText(w.minNetDebt)}), ratio ${percent(own.icr)}% -> ${percent(icr)}%. Interest is paid first (${musdText(interestPaid)} MUSD of it).`,
        warnings,
        raw,
      })
    },

    async status(input, o): Promise<TroveStatus> {
      const borrower = parseAddress(input.address, 'address')
      const w = await world(o?.blockNumber)
      const own = await ownOf(w, borrower)
      const base = { borrower, blockNumber: w.blockNumber, blockTime: w.blockTime, chainId: w.chainId, btcPriceUsd: fixed(w.price, 18, 2), tcr: percent(w.tcr), recoveryMode: w.recoveryMode }
      const status = TROVE_STATUS[own.status] ?? `unknown(${own.status})`
      if (!own.active) {
        return { ...base, status, active: false, trove: null, icr: null, mcrDistance: null, liquidatable: null, maxBorrowingCapacity: null, redemptionPosition: null, warnings: [], summary: `No open trove for ${borrower} at block ${w.blockNumber} (status: ${status}).`, raw: { price: w.price.toString(), tcr: w.tcr.toString() } }
      }
      const warnings: string[] = []
      let position: RedemptionPosition | null = null
      try {
        position = positionOf(await lens.redemptionRisk(borrower, { blockNumber: w.block }), 'This is the trove\'s current spot in the list.')
      } catch (e) {
        warnings.push(`the redemption position could not be read (${messageOf(e)})`)
      }
      if (position && !position.walkComplete) warnings.push('the redemption walk hit its step cap, so the position is a lower bound')
      const liquidatable = own.icr < w.mcr
      if (liquidatable) warnings.push(`the trove is under the ${percent(w.mcr)}% minimum ratio and can be liquidated`)
      const d = distance(w, own.coll, own.debt, own.icr)
      return {
        ...base,
        status,
        active: true,
        trove: numbers(own.coll, own.principal, own.interest, w.gasComp),
        icr: percent(own.icr),
        mcrDistance: d,
        liquidatable,
        maxBorrowingCapacity: musdText(own.capacity),
        redemptionPosition: position,
        warnings,
        summary: `Trove ${borrower} at block ${w.blockNumber}: ${btcText(own.coll)} BTC against ${musdText(own.debt)} MUSD of debt, ratio ${percent(own.icr)}% (${d.marginPoints} points above the ${percent(w.mcr)}% minimum). The system ratio is ${percent(w.tcr)}%${w.recoveryMode ? ' (Recovery Mode)' : ''}.${position ? ` ${position.musdAhead} MUSD of redeemable debt is ahead of it in the redemption queue.` : ''}`,
        raw: { price: w.price.toString(), collateral: own.coll.toString(), principal: own.principal.toString(), interest: own.interest.toString(), debt: own.debt.toString(), icr: own.icr.toString(), tcr: w.tcr.toString(), maxBorrowingCapacity: own.capacity.toString() },
      }
    },
  }
  return planner
}
