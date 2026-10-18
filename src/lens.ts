// Block-pinned TypeScript client for the deployed MezoLens contract.
// Every call reads at one block and returns that block number, so any number can be re-checked with a plain RPC read at the same height.
// Amounts come back twice: truncated human units for people and agents, and exact integers as strings under `raw`.
import { formatUnits, getAddress, isAddressEqual, zeroAddress, type Abi, type Address } from 'viem'
import artifact from '../artifacts/MezoLens.json' with { type: 'json' }
import deployment from '../deployments/testnet.json' with { type: 'json' }
import { erc20Abi } from './abis.ts'
import { ADDRESSES, CHAIN_ID, TOKENS } from './config.ts'
import { parseAddress, parseToken, parseTokenAmount } from './inputs.ts'

export const lensAbi = artifact.abi as Abi
export const deployedLensAddress = (): Address => getAddress(process.env.MEZO_LENS_ADDRESS ?? deployment.MezoLens.address)

/** The slice of a viem public client the lens needs. Tests pass a fake. */
export interface ReadClient {
  getBlockNumber(): Promise<bigint>
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
  // viem's readContract is heavily generic; the lens only passes plain arguments.
  readContract(args: any): Promise<unknown> // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface ReadOpts {
  /** Read at this block instead of the latest one. */
  blockNumber?: bigint
}

export interface Meta {
  blockNumber: number
  blockTime: string
  chainId: number
  lens: Address
}

// ---- formatting ---------------------------------------------------------------------------------------------------------------------------

/** Truncate (never round) a fixed-point value to `places` decimals and drop trailing zeros. */
export function fixed(x: bigint, decimals: number, places: number): string {
  const [i, f = ''] = formatUnits(x, decimals).split('.')
  const frac = f.slice(0, places).replace(/0+$/, '')
  return frac ? `${i}.${frac}` : i
}
/** A ratio where 1e18 is 100%, as a percent string with at most two decimals. */
export const percent = (ratio: bigint): string => fixed(ratio * 100n, 18, 2)
export const bpsPercent = (bps: bigint): string => fixed(bps * 10n ** 16n, 18, 2)
export const isoTime = (unixSeconds: bigint): string => new Date(Number(unixSeconds) * 1000).toISOString()

/** Turn every bigint in a decoded struct into a decimal string so the result is JSON-safe and exact. */
export function raw<T extends object>(struct: T): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(struct)) {
    if (typeof v === 'bigint') out[k] = v.toString()
    else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v
  }
  return out
}

// ---- decoded shapes (field names match the Solidity structs) -----------------------------------------------------------------------------

export interface TroveHealthRaw {
  status: number
  coll: bigint
  principal: bigint
  interest: bigint
  debt: bigint
  price: bigint
  icr: bigint
  mcr: bigint
  liquidationPrice: bigint
  priceDropToLiquidationBps: bigint
}
export interface SystemSnapshotRaw {
  price: bigint
  tcr: bigint
  mcr: bigint
  ccr: bigint
  recoveryMode: boolean
  redemptionsOpen: boolean
  troveCount: bigint
  totalColl: bigint
  totalDebt: bigint
  lowestNicr: Address
  firstRedeemable: Address
  firstRedeemableIcr: bigint
  skippedBelowMcr: bigint
  scanTruncated: boolean
}
export interface RedemptionQueueRaw {
  listed: boolean
  found: boolean
  truncated: boolean
  next: Address
  steps: bigint
  ahead: bigint
  debtAhead: bigint
  belowMcr: bigint
  borrowerIcr: bigint
  listSize: bigint
  price: bigint
  mcr: bigint
}
export interface PoolQuoteRaw {
  poolExists: boolean
  quoteOk: boolean
  pool: Address
  factory: Address
  amountOut: bigint
  reserveIn: bigint
  reserveOut: bigint
  impactBps: bigint
}
export interface LockRaw {
  escrow: Address
  tokenId: bigint
  amount: bigint
  end: bigint
  isPermanent: boolean
  votingPower: bigint
  voted: boolean
  secondsLeft: bigint
  expired: boolean
}

export const TROVE_STATUS = ['nonExistent', 'active', 'closedByOwner', 'closedByLiquidation', 'closedByRedemption'] as const

// ---- results ------------------------------------------------------------------------------------------------------------------------------

export type TroveHealthResult = Meta & {
  borrower: Address
  status: string
  active: boolean
  btcPriceUsd: string
  mcrPercent: string
  collateralBtc?: string
  principalMusd?: string
  interestMusd?: string
  debtMusd?: string
  icrPercent?: string
  liquidatable?: boolean
  liquidationPriceUsd?: string
  priceDropToLiquidationPercent?: string
  summary: string
  raw: Record<string, string | number | boolean>
}

export type SystemResult = Meta & {
  btcPriceUsd: string
  tcrPercent: string
  mcrPercent: string
  ccrPercent: string
  recoveryMode: boolean
  redemptionsOpen: boolean
  troveCount: number
  totalCollateralBtc: string
  totalDebtMusd: string
  lowestRatioTrove: Address
  firstRedeemableTrove: Address | null
  firstRedeemableIcrPercent: string | null
  skippedBelowMcr: number
  scanTruncated: boolean
  raw: Record<string, string | number | boolean>
}

export type RedemptionRiskResult = Meta & {
  borrower: Address
  listed: boolean
  found: boolean
  /** False when the step cap ran out before the walk reached the borrower: the counts below are lower bounds. */
  walkComplete: boolean
  stepsWalked: number
  listSize: number
  redeemableTrovesAhead: number
  redeemableMusdAhead: string
  skippedBelowMcr: number
  borrowerIcrPercent: string | null
  borrowerRedeemable: boolean | null
  liquidatable: boolean | null
  liquidationPriceUsd: string | null
  priceDropToLiquidationPercent: string | null
  btcPriceUsd: string
  mcrPercent: string
  system: Pick<SystemResult, 'tcrPercent' | 'recoveryMode' | 'redemptionsOpen' | 'troveCount' | 'firstRedeemableTrove' | 'firstRedeemableIcrPercent'>
  summary: string
  raw: Record<string, string | number | boolean>
}

export type TokenInfo = { address: Address; symbol: string; decimals: number }
export type PoolQuoteResult = Meta & {
  tokenIn: TokenInfo
  tokenOut: TokenInfo
  amountIn: string
  stable: boolean
  poolExists: boolean
  quoteOk: boolean
  pool: Address | null
  amountOut: string | null
  reserveIn: string | null
  reserveOut: string | null
  priceImpactPercent: string | null
  summary: string
  raw: Record<string, string | number | boolean>
}

export type LockResult = {
  escrow: 'veBTC' | 'veMEZO'
  tokenId: string
  amount: string
  isPermanent: boolean
  unlocksAt: string | null
  secondsLeft: number
  expired: boolean
  votingPower: string
  voted: boolean
  raw: Record<string, string | number | boolean>
}
export type VeLocksResult = Meta & {
  owner: Address
  veBtcCount: number
  veMezoCount: number
  returned: number
  locks: LockResult[]
  summary: string
}

export interface PoolQuoteInput {
  /** BTC, MUSD, MEZO or a 0x token address. */
  tokenIn: string
  tokenOut: string
  /** Decimal amount in tokenIn units, for example "1000" or "0.5". */
  amountIn: string
  stable?: boolean
}

export interface Lens {
  address: Address
  troveHealth(borrower: Address, o?: ReadOpts): Promise<TroveHealthResult>
  systemSnapshot(o?: ReadOpts & { maxSteps?: number }): Promise<SystemResult>
  redemptionRisk(borrower: Address, o?: ReadOpts & { pageSteps?: number; maxSteps?: number }): Promise<RedemptionRiskResult>
  poolQuote(input: PoolQuoteInput, o?: ReadOpts): Promise<PoolQuoteResult>
  veLocks(owner: Address, o?: ReadOpts & { max?: number }): Promise<VeLocksResult>
}

// ---- helpers ------------------------------------------------------------------------------------------------------------------------------

/** Errors worth a retry: the load-balanced RPC may not have a block yet, or may rate-limit or drop a request. */
const TRANSIENT = /header not found|block .*not found|unknown block|missing trie node|timed? ?out|429|too many requests|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|502|503|504/i

export async function withRetry<T>(fn: () => Promise<T>, tries = 4, delayMs = 250): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      const text = `${(e as { shortMessage?: string }).shortMessage ?? ''} ${(e as Error).message ?? ''}`
      if (attempt >= tries || !TRANSIENT.test(text)) throw e
      await new Promise((r) => setTimeout(r, delayMs * attempt))
    }
  }
}

const KNOWN = Object.entries(TOKENS).map(([symbol, address]) => ({ symbol, address: getAddress(address), decimals: 18 }))

/** Queue steps per eth_call (about 25.7k gas each) and in total. A single call over 255 steps (about 6.6M gas) was measured on the live RPC; pages stay well inside that. */
export const DEFAULT_PAGE_STEPS = 200
export const DEFAULT_MAX_STEPS = 2000

export function createLens(client: ReadClient, address: Address = deployedLensAddress()): Lens {
  const read = <T>(block: bigint, functionName: string, args: readonly unknown[] = []): Promise<T> =>
    withRetry(() => client.readContract({ address, abi: lensAbi, functionName, args, blockNumber: block }) as Promise<T>)

  const pin = async (o?: ReadOpts): Promise<bigint> => o?.blockNumber ?? (await withRetry(() => client.getBlockNumber()))

  const meta = async (block: bigint): Promise<Meta> => {
    const b = await withRetry(() => client.getBlock({ blockNumber: block }))
    return { blockNumber: Number(block), blockTime: isoTime(b.timestamp), chainId: CHAIN_ID, lens: address }
  }

  const tokenInfo = async (token: string, block: bigint): Promise<TokenInfo> => {
    const norm = parseToken(token)
    const known = KNOWN.find((k) => k.symbol === norm || k.address === norm)
    if (known) return known
    const tokenAddress = norm as Address
    const [decimals, symbol] = await Promise.all([
      withRetry(() => client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals', blockNumber: block }) as Promise<number>),
      withRetry(() => client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'symbol', blockNumber: block }) as Promise<string>).catch(() => 'UNKNOWN'),
    ])
    return { address: tokenAddress, symbol, decimals: Number(decimals) }
  }

  const lens: Lens = {
    address,

    async troveHealth(borrower, o) {
      borrower = parseAddress(borrower)
      const block = await pin(o)
      const [m, h] = await Promise.all([meta(block), read<TroveHealthRaw>(block, 'troveHealth', [borrower])])
      const active = h.status === 1
      const base = {
        ...m,
        borrower,
        status: TROVE_STATUS[h.status] ?? `unknown(${h.status})`,
        active,
        btcPriceUsd: fixed(h.price, 18, 2),
        mcrPercent: percent(h.mcr),
        raw: raw(h),
      }
      if (!active) return { ...base, summary: `No open trove for ${borrower} at block ${m.blockNumber} (status: ${base.status}).` }
      const liquidatable = h.icr < h.mcr
      return {
        ...base,
        collateralBtc: fixed(h.coll, 18, 8),
        principalMusd: fixed(h.principal, 18, 6),
        interestMusd: fixed(h.interest, 18, 6),
        debtMusd: fixed(h.debt, 18, 6),
        icrPercent: percent(h.icr),
        liquidatable,
        liquidationPriceUsd: fixed(h.liquidationPrice, 18, 2),
        priceDropToLiquidationPercent: bpsPercent(h.priceDropToLiquidationBps),
        summary: liquidatable
          ? `Trove is below the ${percent(h.mcr)}% minimum ratio (${percent(h.icr)}%) and can be liquidated.`
          : `Trove holds ${percent(h.icr)}% collateral against a ${percent(h.mcr)}% minimum; BTC can fall ${bpsPercent(h.priceDropToLiquidationBps)}% to about $${fixed(h.liquidationPrice, 18, 2)} before liquidation.`,
      }
    },

    async systemSnapshot(o) {
      const block = await pin(o)
      const [m, s] = await Promise.all([meta(block), read<SystemSnapshotRaw>(block, 'systemSnapshot', [BigInt(o?.maxSteps ?? DEFAULT_PAGE_STEPS)])])
      return {
        ...m,
        btcPriceUsd: fixed(s.price, 18, 2),
        tcrPercent: percent(s.tcr),
        mcrPercent: percent(s.mcr),
        ccrPercent: percent(s.ccr),
        recoveryMode: s.recoveryMode,
        redemptionsOpen: s.redemptionsOpen,
        troveCount: Number(s.troveCount),
        totalCollateralBtc: fixed(s.totalColl, 18, 8),
        totalDebtMusd: fixed(s.totalDebt, 18, 6),
        lowestRatioTrove: s.lowestNicr,
        firstRedeemableTrove: isZero(s.firstRedeemable) ? null : s.firstRedeemable,
        firstRedeemableIcrPercent: isZero(s.firstRedeemable) ? null : percent(s.firstRedeemableIcr),
        skippedBelowMcr: Number(s.skippedBelowMcr),
        scanTruncated: s.scanTruncated,
        raw: raw(s),
      }
    },

    async redemptionRisk(borrower, o) {
      borrower = parseAddress(borrower)
      const block = await pin(o)
      const pageSteps = Math.min(Math.max(1, o?.pageSteps ?? DEFAULT_PAGE_STEPS), 300)
      const maxSteps = Math.max(pageSteps, o?.maxSteps ?? DEFAULT_MAX_STEPS)
      const [m, health, sys] = await Promise.all([
        meta(block),
        read<TroveHealthRaw>(block, 'troveHealth', [borrower]),
        read<SystemSnapshotRaw>(block, 'systemSnapshot', [BigInt(DEFAULT_PAGE_STEPS)]), // its own scan, as in systemSnapshot(): a small page size must not cut it short
      ])
      // Page through the queue at this one block, adding up the per-page counters. Stop when the borrower is found, the list ends or the global cap hits.
      let cursor: Address = zeroAddress
      let steps = 0
      let ahead = 0n
      let debtAhead = 0n
      let belowMcr = 0
      let last!: RedemptionQueueRaw
      let capped = false
      for (;;) {
        last = await read<RedemptionQueueRaw>(block, 'redemptionQueue', [borrower, cursor, BigInt(pageSteps)])
        steps += Number(last.steps)
        ahead += last.ahead
        debtAhead += last.debtAhead
        belowMcr += Number(last.belowMcr)
        if (!last.listed || last.found || !last.truncated) break
        if (steps >= maxSteps) {
          capped = true
          break
        }
        cursor = last.next
      }
      const active = health.status === 1
      const walkComplete = !capped
      const redeemable = last.found ? last.borrowerIcr >= last.mcr : null
      const liquidatable = active ? health.icr < health.mcr : null
      const rawOut = { ...raw(last), steps, ahead: ahead.toString(), debtAhead: debtAhead.toString(), belowMcr, walkComplete }
      let summary: string
      if (!last.listed) summary = `No open trove for ${borrower} at block ${m.blockNumber}, so there is no redemption position.`
      else if (capped) summary = `Stopped after ${steps} queue nodes without reaching this trove: at least ${ahead} redeemable troves (${fixed(debtAhead, 18, 2)} MUSD) are ahead of it.`
      else if (redeemable === false) summary = `This trove is below the ${percent(last.mcr)}% minimum ratio, so a redemption skips it; it is a liquidation risk instead.`
      else
        summary = `${ahead} redeemable trove(s) holding ${fixed(debtAhead, 18, 2)} MUSD of redeemable debt are ahead of this trove; ${belowMcr} below-minimum trove(s) are skipped. Redemptions are ${sys.redemptionsOpen ? 'open' : 'closed (system ratio is below the minimum)'}.`
      return {
        ...m,
        borrower,
        listed: last.listed,
        found: last.found,
        walkComplete,
        stepsWalked: steps,
        listSize: Number(last.listSize),
        redeemableTrovesAhead: Number(ahead),
        redeemableMusdAhead: fixed(debtAhead, 18, 6),
        skippedBelowMcr: belowMcr,
        borrowerIcrPercent: last.found ? percent(last.borrowerIcr) : null,
        borrowerRedeemable: redeemable,
        liquidatable,
        liquidationPriceUsd: active ? fixed(health.liquidationPrice, 18, 2) : null,
        priceDropToLiquidationPercent: active ? bpsPercent(health.priceDropToLiquidationBps) : null,
        btcPriceUsd: fixed(last.price, 18, 2),
        mcrPercent: percent(last.mcr),
        system: {
          tcrPercent: percent(sys.tcr),
          recoveryMode: sys.recoveryMode,
          redemptionsOpen: sys.redemptionsOpen,
          troveCount: Number(sys.troveCount),
          firstRedeemableTrove: isZero(sys.firstRedeemable) ? null : sys.firstRedeemable,
          firstRedeemableIcrPercent: isZero(sys.firstRedeemable) ? null : percent(sys.firstRedeemableIcr),
        },
        summary,
        raw: rawOut,
      }
    },

    async poolQuote(input, o) {
      const block = await pin(o)
      const [tokenIn, tokenOut] = await Promise.all([tokenInfo(input.tokenIn, block), tokenInfo(input.tokenOut, block)])
      const amountIn = parseTokenAmount(input.amountIn, tokenIn.decimals)
      const stable = input.stable ?? false
      const [m, q] = await Promise.all([meta(block), read<PoolQuoteRaw>(block, 'poolQuote', [tokenIn.address, tokenOut.address, amountIn, stable])])
      const out = (x: bigint) => fixed(x, tokenOut.decimals, 8)
      return {
        ...m,
        tokenIn,
        tokenOut,
        amountIn: fixed(amountIn, tokenIn.decimals, tokenIn.decimals),
        stable,
        poolExists: q.poolExists,
        quoteOk: q.quoteOk,
        pool: q.poolExists ? q.pool : null,
        amountOut: q.quoteOk ? out(q.amountOut) : null,
        reserveIn: q.poolExists ? fixed(q.reserveIn, tokenIn.decimals, 8) : null,
        reserveOut: q.poolExists ? out(q.reserveOut) : null,
        priceImpactPercent: q.quoteOk ? bpsPercent(q.impactBps) : null,
        summary: !q.poolExists
          ? `No ${stable ? 'stable' : 'volatile'} pool for ${tokenIn.symbol}/${tokenOut.symbol} on the Mezo DEX.`
          : !q.quoteOk
            ? `The pool exists but the router could not quote ${input.amountIn} ${tokenIn.symbol}.`
            : `${input.amountIn} ${tokenIn.symbol} buys about ${out(q.amountOut)} ${tokenOut.symbol} (price impact ${bpsPercent(q.impactBps)}%).`,
        raw: { ...raw(q), amountIn: amountIn.toString() },
      }
    },

    async veLocks(owner, o) {
      owner = parseAddress(owner, 'owner')
      const block = await pin(o)
      const max = BigInt(Math.min(Math.max(1, o?.max ?? 25), 100))
      const [m, res] = await Promise.all([meta(block), read<readonly [LockRaw[], bigint, bigint]>(block, 'veLocks', [owner, max])])
      const [locks, veBtcCount, veMezoCount] = res
      const out: LockResult[] = locks.map((k) => ({
        escrow: isAddressEqual(k.escrow, ADDRESSES.veBTC) ? 'veBTC' : 'veMEZO',
        tokenId: k.tokenId.toString(),
        amount: fixed(k.amount, 18, 8),
        isPermanent: k.isPermanent,
        unlocksAt: k.isPermanent ? null : isoTime(k.end),
        secondsLeft: Number(k.secondsLeft),
        expired: k.expired,
        votingPower: fixed(k.votingPower, 18, 8),
        voted: k.voted,
        raw: raw(k),
      }))
      return {
        ...m,
        owner,
        veBtcCount: Number(veBtcCount),
        veMezoCount: Number(veMezoCount),
        returned: out.length,
        locks: out,
        summary:
          Number(veBtcCount) + Number(veMezoCount) === 0
            ? `${owner} holds no veBTC or veMEZO locks at block ${m.blockNumber}.`
            : `${owner} holds ${veBtcCount} veBTC and ${veMezoCount} veMEZO lock(s); ${out.length} returned${out.some((l) => l.expired) ? ', some expired' : ''}.`,
      }
    },
  }
  return lens
}

const isZero = (a: Address) => isAddressEqual(a, zeroAddress)
