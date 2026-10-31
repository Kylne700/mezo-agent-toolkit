// A fake MUSD trove system behind the mocked Mezo RPC of helpers/write.ts: TroveManager, SortedTroves, HintHelpers, BorrowerOperations, the price feed,
// GovernableVariables and the BTC / MUSD balances of one wallet, all in memory. Tests change the world's fields between calls. No network, no real transaction.
// `fakeLens` models the MezoLens redemption walk (tail first, stop at the borrower) over the same list; `expectedPosition` / `expectedHints` are the
// independent oracles the tests compare the planner against: they re-sort a plain array and add up prefixes, and share nothing with src/plan.ts.
import { decodeFunctionData, encodeFunctionResult, formatUnits, getAbiItem, getAddress, keccak256, parseTransaction, parseUnits, toFunctionSelector, toHex, zeroAddress, type Abi, type AbiFunction, type Address, type Hex } from 'viem'
import { borrowerOperationsAbi, erc20Abi, governableVariablesAbi, hintHelpersAbi, priceFeedAbi, sortedTrovesAbi, troveManagerAbi } from '../../src/abis.ts'
import { ADDRESSES } from '../../src/config.ts'
import type { PlanLens } from '../../src/plan.ts'
import { mockRpc } from './write.ts'

export const e18 = (x: number | string) => parseUnits(String(x), 18)
export const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`
export const troveAddr = (i: number) => addr(0xa000 + i)
const GV = addr(0x9001)
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export interface FakeTrove {
  owner: Address
  coll: bigint
  principal: bigint
  interest: bigint
  capacity: bigint
}
export interface Tx {
  to: Address
  data: Hex
  value: bigint
}

/** Seven other troves: a spread of ratios at $77,000 per BTC, one of them (index 4) under the 110% minimum. System ratio about 240%. */
export const OTHERS: readonly [Address, string, string, string][] = [
  [troveAddr(1), '0.1', '3000', '0'], // ICR 256.7%
  [troveAddr(2), '0.05', '2500', '0'], // 154%
  [troveAddr(3), '0.04', '2400', '10'], // 127.8%
  [troveAddr(4), '0.03', '2000', '0'], // 115.5%
  [troveAddr(5), '0.0264', '1900', '0'], // 107%: below the minimum, so a redemption skips it
  [troveAddr(6), '0.2', '4000', '0'], // 385%
  [troveAddr(7), '0.15', '3300', '0'], // 350%
]

export function troveWorld(me: Address) {
  const w = {
    me,
    ts: 1_793_438_189n,
    block: 16_500_000n,
    price: e18(77_000),
    mcr: e18('1.1'),
    ccr: e18('1.5'),
    gasComp: e18(200),
    minNetDebt: e18(1800),
    rate: e18('0.001'),
    exempt: new Set<string>(), // lower-case addresses with no borrowing fee
    btc: e18('0.0457'), // the wallet's BTC and MUSD
    musd: e18('15.7'),
    troves: OTHERS.map(([owner, coll, principal, interest]): FakeTrove => ({ owner, coll: e18(coll), principal: e18(principal), interest: e18(interest), capacity: (e18(coll) * e18(77_000)) / e18('1.1') })),
    closed: new Map<string, number>(), // lower-case address -> a closed status (2 closed by owner...)
    walkComplete: true, // what the fake lens reports
    lensFails: false,
    failReads: new Set<string>(), // a function name: those reads revert
    simRevert: undefined as string | undefined, // makes the write core's eth_call simulation revert
    estimateFails: false,
    txStatus: '0x1',
    silent: false, // no receipt ever arrives
    lag: { receipts: 0, blocks: 0, calls: 0 }, // as in helpers/ve.ts: the next N answers from a lagging node fail
    receiptAsks: 0,
    sent: [] as Tx[],
    onTx: undefined as ((tx: Tx) => void) | undefined, // runs after a send, to make the node lag from that moment on (as in helpers/ve.ts)
  }
  const own = (a: string) => w.troves.find((t) => same(t.owner, a))
  const debtOf = (t: FakeTrove) => t.principal + t.interest
  const nicrOf = (t: FakeTrove) => (t.coll * 10n ** 20n) / t.principal
  const byNicr = () => [...w.troves].sort((a, b) => (nicrOf(a) === nicrOf(b) ? 0 : nicrOf(a) > nicrOf(b) ? -1 : 1)) // head first
  const sysColl = () => w.troves.reduce((s, t) => s + t.coll, 0n)
  const sysDebt = () => w.troves.reduce((s, t) => s + debtOf(t), 0n)
  const cr = (c: bigint, d: bigint, p: bigint) => (d === 0n ? 2n ** 256n - 1n : (c * p) / d)
  const tcr = (p: bigint) => cr(sysColl(), sysDebt(), p)
  const at = (list: FakeTrove[], i: number): Address => (i >= 0 && i < list.length ? list[i]!.owner : zeroAddress)

  type Entry = { abi: Abi; name: string; fn: (...a: any[]) => unknown } // eslint-disable-line @typescript-eslint/no-explicit-any
  const table = () => {
    const t = new Map<string, Entry>()
    const on = (to: Address, abi: Abi, name: string, fn: Entry['fn']) => t.set(`${to.toLowerCase()}:${toFunctionSelector(getAbiItem({ abi, name }) as AbiFunction)}`, { abi, name, fn })
    const TM = ADDRESSES.troveManager
    const ST = ADDRESSES.sortedTroves
    on(TM, troveManagerAbi, 'MCR', () => w.mcr)
    on(TM, troveManagerAbi, 'CCR', () => w.ccr)
    on(TM, troveManagerAbi, 'MUSD_GAS_COMPENSATION', () => w.gasComp)
    on(TM, troveManagerAbi, 'getTroveStatus', (a: Address) => (own(a) ? 1 : (w.closed.get(a.toLowerCase()) ?? 0)))
    on(TM, troveManagerAbi, 'getEntireDebtAndColl', (a: Address) => {
      const x = own(a)
      return x ? [x.coll, x.principal, x.interest, 0n, 0n, 0n] : [0n, 0n, 0n, 0n, 0n, 0n]
    })
    on(TM, troveManagerAbi, 'getTCR', (p: bigint) => tcr(p))
    on(TM, troveManagerAbi, 'getEntireSystemColl', () => sysColl())
    on(TM, troveManagerAbi, 'getEntireSystemDebt', () => sysDebt())
    on(TM, troveManagerAbi, 'checkRecoveryMode', (p: bigint) => tcr(p) < w.ccr)
    on(TM, troveManagerAbi, 'getCurrentICR', (a: Address, p: bigint) => {
      const x = own(a)
      return x ? cr(x.coll, debtOf(x), p) : 0n
    })
    on(TM, troveManagerAbi, 'getTroveMaxBorrowingCapacity', (a: Address) => own(a)?.capacity ?? 0n)
    on(TM, troveManagerAbi, 'getTroveOwnersCount', () => BigInt(w.troves.length))
    on(TM, troveManagerAbi, 'Troves', (a: Address) => {
      const x = own(a)
      return x ? [x.coll, x.principal, x.interest, 0n, 1, 0, 0n, x.capacity, 0n] : [0n, 0n, 0n, 0n, w.closed.get(a.toLowerCase()) ?? 0, 0, 0n, 0n, 0n]
    })

    on(ST, sortedTrovesAbi, 'getFirst', () => at(byNicr(), 0))
    on(ST, sortedTrovesAbi, 'getLast', () => at(byNicr(), w.troves.length - 1))
    on(ST, sortedTrovesAbi, 'getSize', () => BigInt(w.troves.length))
    on(ST, sortedTrovesAbi, 'contains', (a: Address) => !!own(a))
    on(ST, sortedTrovesAbi, 'getPrev', (a: Address) => {
      const l = byNicr()
      return at(l, l.findIndex((x) => same(x.owner, a)) - 1)
    })
    on(ST, sortedTrovesAbi, 'getNext', (a: Address) => {
      const l = byNicr()
      const i = l.findIndex((x) => same(x.owner, a))
      return i < 0 ? zeroAddress : at(l, i + 1)
    })
    // The exact position: between the last node whose ratio is at least `nicr` and the next one. The hints only speed the real contract up.
    on(ST, sortedTrovesAbi, 'findInsertPosition', (nicr: bigint) => {
      const l = byNicr()
      const i = l.findIndex((x) => nicrOf(x) < nicr)
      const lower = i < 0 ? l.length : i
      return [at(l, lower - 1), at(l, lower)]
    })
    on(ADDRESSES.hintHelpers, hintHelpersAbi, 'getApproxHint', (nicr: bigint, _trials: bigint, seed: bigint) => {
      const l = byNicr()
      if (l.length === 0) return [zeroAddress, 0n, seed]
      const diff = (x: FakeTrove) => (nicrOf(x) > nicr ? nicrOf(x) - nicr : nicr - nicrOf(x))
      const best = l.reduce((a, b) => (diff(b) < diff(a) ? b : a))
      return [best.owner, diff(best), seed]
    })

    on(ADDRESSES.borrowerOperations, borrowerOperationsAbi, 'minNetDebt', () => w.minNetDebt)
    on(ADDRESSES.borrowerOperations, borrowerOperationsAbi, 'borrowingRate', () => w.rate)
    on(ADDRESSES.borrowerOperations, borrowerOperationsAbi, 'governableVariables', () => GV)
    on(GV, governableVariablesAbi, 'isAccountFeeExempt', (a: Address) => w.exempt.has(a.toLowerCase()))
    on(ADDRESSES.priceFeed, priceFeedAbi, 'fetchPrice', () => w.price)
    on(ADDRESSES.btc, erc20Abi, 'balanceOf', (a: Address) => (same(a, me) ? w.btc : 0n))
    on(ADDRESSES.musd, erc20Abi, 'balanceOf', (a: Address) => (same(a, me) ? w.musd : 0n))
    return t
  }

  /** What the fake chain does with each transaction the tools send, so a read-back sees the new state. */
  const react = (tx: Tx) => {
    const d = decodeFunctionData({ abi: borrowerOperationsAbi, data: tx.data })
    if (d.functionName === 'openTrove') {
      const debt = d.args[0]
      const rm = tcr(w.price) < w.ccr
      const fee = rm || w.exempt.has(me.toLowerCase()) ? 0n : (debt * w.rate) / 10n ** 18n
      w.troves.push({ owner: me, coll: tx.value, principal: debt + fee + w.gasComp, interest: 0n, capacity: (tx.value * w.price) / w.mcr })
      w.btc -= tx.value
      w.musd += debt
    } else if (d.functionName === 'addColl') {
      own(me)!.coll += tx.value
      w.btc -= tx.value
    } else if (d.functionName === 'repayMUSD') {
      const t = own(me)!
      const paid = d.args[0]
      const interest = paid < t.interest ? paid : t.interest // interest first
      t.interest -= interest
      t.principal -= paid - interest
      w.musd -= paid
    }
  }

  const header = () => ({ number: toHex(w.block), hash: `0x${'11'.repeat(32)}`, timestamp: toHex(w.ts), baseFeePerGas: toHex(130n), transactions: [] })
  const over = {
    eth_blockNumber: () => toHex(w.block),
    eth_getBlockByNumber: () => (w.lag.blocks > 0 ? (w.lag.blocks--, null) : header()),
    eth_getTransactionCount: () => toHex(7 + w.sent.length),
    eth_estimateGas: () => {
      if (w.estimateFails) throw new Error('execution reverted: fake estimate failure')
      return toHex(250_000)
    },
    eth_call: ([tx, block]: any[]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!tx.from && block !== 'latest' && w.lag.calls > 0) {
        w.lag.calls--
        throw new Error('header not found')
      }
      const h = table().get(`${String(tx.to).toLowerCase()}:${String(tx.data).slice(0, 10)}`)
      if (tx.from) {
        // The write core simulates from the signer's address; reads never send `from`.
        if (w.simRevert) throw new Error(`execution reverted: ${w.simRevert}`)
        if (!h) return '0x'
      }
      if (!h) throw new Error('the fake chain has no handler for this call')
      if (w.failReads.has(h.name)) throw new Error('execution reverted')
      const args = decodeFunctionData({ abi: h.abi, data: tx.data }).args ?? []
      return encodeFunctionResult({ abi: h.abi, functionName: h.name, result: h.fn(...args) } as never)
    },
    eth_sendRawTransaction: ([raw]: Hex[]) => {
      const t = parseTransaction(raw)
      const tx = { to: getAddress(t.to as Address), data: (t.data ?? '0x') as Hex, value: t.value ?? 0n }
      w.sent.push(tx)
      react(tx)
      w.onTx?.(tx)
      return keccak256(raw)
    },
    eth_getTransactionByHash: () => {
      if (w.silent) return null
      throw new Error('the mock RPC has no eth_getTransactionByHash')
    },
    eth_getTransactionReceipt: ([hash]: Hex[]) =>
      w.silent || (w.receiptAsks++ > 0 && w.lag.receipts > 0 && (w.lag.receipts--, true))
        ? null
        : { transactionHash: hash, transactionIndex: '0x0', blockHash: `0x${'33'.repeat(32)}`, blockNumber: toHex(w.block), cumulativeGasUsed: '0x5208', gasUsed: '0x3d090', effectiveGasPrice: '0x92', logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: w.txStatus, type: '0x2', contractAddress: null },
  }

  /** The MezoLens redemption walk over the same list: from the tail up to the borrower, not counting the borrower. */
  const lens: PlanLens = {
    async redemptionRisk(borrower) {
      if (w.lensFails) throw new Error('the fake lens is down')
      const asc = byNicr().reverse()
      const stop = asc.findIndex((t) => same(t.owner, borrower))
      let ahead = 0
      let skipped = 0
      let debtAhead = 0n
      for (const t of asc.slice(0, stop < 0 ? 0 : stop)) {
        if (cr(t.coll, debtOf(t), w.price) < w.mcr) skipped++
        else {
          ahead++
          if (debtOf(t) > w.gasComp) debtAhead += debtOf(t) - w.gasComp
        }
      }
      return {
        redeemableTrovesAhead: ahead,
        redeemableMusdAhead: formatUnits(debtAhead, 18),
        skippedBelowMcr: skipped,
        walkComplete: w.walkComplete,
        system: { redemptionsOpen: tcr(w.price) >= w.mcr },
        raw: { debtAhead: debtAhead.toString() },
      } as never
    },
  }

  return { w, over, rpc: () => mockRpc(over), lens, own, debtOf }
}

export type TroveWorld = ReturnType<typeof troveWorld>
export type World = TroveWorld['w']

// ---- the oracles -----------------------------------------------------------------------------------------------------------------------------

interface Row {
  owner: string
  nicr: bigint
  icr: bigint
  debt: bigint
}
const rowOf = (owner: string, coll: bigint, principal: bigint, interest: bigint, price: bigint): Row => ({ owner, nicr: (coll * 10n ** 20n) / principal, icr: (coll * price) / (principal + interest), debt: principal + interest })

/**
 * The list as a plain sorted array, with `me` replaced by its trove after the change (or added, or removed when `after` is null), lowest ratio first.
 * Returns the neighbours the change should be hinted with and what a redemption must take before it reaches `me`.
 */
export function oracle(world: TroveWorld, after: { coll: bigint; principal: bigint; interest: bigint } | null) {
  const { w } = world
  const others = w.troves.filter((t) => !same(t.owner, w.me)).map((t) => rowOf(t.owner, t.coll, t.principal, t.interest, w.price))
  const me = after ? rowOf(w.me, after.coll, after.principal, after.interest, w.price) : undefined
  const asc = [...others, ...(me ? [me] : [])].sort((a, b) => (a.nicr < b.nicr ? -1 : a.nicr > b.nicr ? 1 : 0))
  const i = me ? asc.indexOf(me) : -1
  const below = asc.slice(0, Math.max(i, 0))
  const counted = below.filter((r) => r.icr >= w.mcr)
  return {
    nicr: me?.nicr,
    // asc[i + 1] has a higher ratio than `me` (the upper hint); asc[i - 1] a lower one (the lower hint)
    upper: (i >= 0 && asc[i + 1]?.owner) || zeroAddress,
    lower: (i >= 0 && asc[i - 1]?.owner) || zeroAddress,
    trovesAhead: counted.length,
    skippedBelowMcr: below.length - counted.length,
    debtAhead: counted.reduce((s, r) => s + (r.debt > w.gasComp ? r.debt - w.gasComp : 0n), 0n),
  }
}
