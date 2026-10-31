// A fake Stability Pool on top of the fake trove world of helpers/trove.ts (same mocked Mezo RPC, same list of troves, same wallet): the pool's reads
// (deposit, compounded deposit, BTC gain, totals, the contracts it asks), the MUSD / BTC allowances of the wallet, and what a send does to them
// (approve, provideToSP, withdrawFromSP, liquidate with its two events). The pool's withdraw rule is re-implemented here from the plain list, not from src/.
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAbiItem, getAddress, keccak256, parseTransaction, toFunctionSelector, toHex, type Abi, type AbiFunction, type Address, type Hex } from 'viem'
import { erc20Abi, stabilityPoolAbi, troveManagerAbi } from '../../src/abis.ts'
import { ADDRESSES } from '../../src/config.ts'
import { e18, troveWorld, type Tx } from './trove.ts'
import { mockRpc } from './write.ts'

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const lc = (a: string) => a.toLowerCase()
const WITHDRAW = toFunctionSelector(getAbiItem({ abi: stabilityPoolAbi, name: 'withdrawFromSP' }) as AbiFunction)

export function spWorld(me: Address) {
  const t = troveWorld(me)
  const { w } = t
  const s = {
    initial: new Map<string, bigint>(), // lower-case depositor -> the deposit as the pool stored it
    compounded: new Map<string, bigint>(), // -> what is left after liquidation losses (unset: the initial deposit)
    gain: new Map<string, bigint>(), // -> pending BTC gain
    total: e18(86_000_000),
    collateral: e18(176),
    allowances: new Map<string, bigint>(), // `musd:<spender>` or `btc:<spender>` (lower-case), given by the wallet
    liqLoss: 0n, // what one liquidation takes from the wallet's deposit ...
    liqGain: 0n, // ... and gives it in BTC
    simPasses: false, // the pool reports "blocked" in its reads but the simulation of a withdrawal does not revert
    logs: [] as { address: Address; topics: Hex[]; data: Hex }[], // what the next receipt carries
  }

  /** The pool's rule, from the plain list: the trove with the lowest collateral / principal (the tail of SortedTroves) has a current ratio under the minimum. */
  const blocked = () => {
    const tail = [...w.troves].sort((a, b) => Number((a.coll * 10n ** 20n) / a.principal - (b.coll * 10n ** 20n) / b.principal))[0]
    return !!tail && (tail.coll * w.price) / (tail.principal + tail.interest) < w.mcr
  }

  type Entry = { abi: Abi; name: string; fn: (...a: any[]) => unknown } // eslint-disable-line @typescript-eslint/no-explicit-any
  const table = () => {
    const m = new Map<string, Entry>()
    const on = (to: Address, abi: Abi, name: string, fn: Entry['fn']) => m.set(`${lc(to)}:${toFunctionSelector(getAbiItem({ abi, name }) as AbiFunction)}`, { abi, name, fn })
    const SP = ADDRESSES.stabilityPool
    on(SP, stabilityPoolAbi, 'deposits', (a: Address) => s.initial.get(lc(a)) ?? 0n)
    on(SP, stabilityPoolAbi, 'getCompoundedMUSDDeposit', (a: Address) => s.compounded.get(lc(a)) ?? s.initial.get(lc(a)) ?? 0n)
    on(SP, stabilityPoolAbi, 'getDepositorCollateralGain', (a: Address) => s.gain.get(lc(a)) ?? 0n)
    on(SP, stabilityPoolAbi, 'getTotalMUSDDeposits', () => s.total)
    on(SP, stabilityPoolAbi, 'getCollateralBalance', () => s.collateral)
    on(SP, stabilityPoolAbi, 'MCR', () => w.mcr)
    on(SP, stabilityPoolAbi, 'sortedTroves', () => ADDRESSES.sortedTroves)
    on(SP, stabilityPoolAbi, 'priceFeed', () => ADDRESSES.priceFeed)
    on(SP, stabilityPoolAbi, 'troveManager', () => ADDRESSES.troveManager)
    for (const [token, name] of [[ADDRESSES.musd, 'musd'], [ADDRESSES.btc, 'btc']] as const)
      on(token, erc20Abi, 'allowance', (_owner: Address, spender: Address) => s.allowances.get(`${name}:${lc(spender)}`) ?? 0n)
    return m
  }

  /** What the fake chain does with each transaction the Stability Pool tools send. */
  const react = (tx: Tx) => {
    const k = lc(me)
    s.logs = [] // a receipt carries only the events of its own transaction
    if (same(tx.to, ADDRESSES.musd) || same(tx.to, ADDRESSES.btc)) {
      const d = decodeFunctionData({ abi: erc20Abi, data: tx.data })
      if (d.functionName !== 'approve') throw new Error(`the fake chain does not know ${d.functionName}`)
      s.allowances.set(`${same(tx.to, ADDRESSES.musd) ? 'musd' : 'btc'}:${lc(d.args[0])}`, d.args[1])
    } else if (same(tx.to, ADDRESSES.stabilityPool)) {
      const d = decodeFunctionData({ abi: stabilityPoolAbi, data: tx.data })
      const amount = d.args?.[0] as bigint
      const left = s.compounded.get(k) ?? s.initial.get(k) ?? 0n
      if (d.functionName === 'provideToSP') {
        s.initial.set(k, left + amount) // a deposit restarts the pool's bookkeeping from what is left
        s.compounded.delete(k)
        s.total += amount
        w.musd -= amount
        w.btc += s.gain.get(k) ?? 0n // the pending gain is paid out with it
        s.gain.delete(k)
        const key = `musd:${lc(ADDRESSES.stabilityPool)}`
        s.allowances.set(key, (s.allowances.get(key) ?? 0n) - amount)
      } else if (d.functionName === 'withdrawFromSP') {
        const out = amount < left ? amount : left
        s.initial.set(k, left - out)
        s.compounded.delete(k)
        s.total -= out
        w.musd += out
      } else throw new Error(`the fake chain does not know ${d.functionName}`)
    } else if (same(tx.to, ADDRESSES.troveManager)) {
      const d = decodeFunctionData({ abi: troveManagerAbi, data: tx.data })
      if (d.functionName !== 'liquidate') throw new Error(`the fake chain does not know ${d.functionName}`)
      const borrower = d.args[0]
      const i = w.troves.findIndex((x) => same(x.owner, borrower))
      const x = w.troves[i]!
      w.troves.splice(i, 1)
      w.closed.set(lc(borrower), 3)
      const comp = (x.coll * 5n) / 1000n // 0.5% of the collateral, and the 200 MUSD reserve, go to the caller
      w.musd += w.gasComp
      w.btc += comp
      s.total -= x.principal + x.interest
      s.collateral += x.coll - comp
      s.compounded.set(k, (s.compounded.get(k) ?? s.initial.get(k) ?? 0n) - s.liqLoss)
      s.gain.set(k, (s.gain.get(k) ?? 0n) + s.liqGain)
      s.logs = [
        { address: ADDRESSES.troveManager, topics: encodeEventTopics({ abi: troveManagerAbi, eventName: 'TroveLiquidated', args: { borrower } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }], [x.principal + x.interest, x.coll, 0]) },
        { address: ADDRESSES.troveManager, topics: encodeEventTopics({ abi: troveManagerAbi, eventName: 'Liquidation' }) as Hex[], data: encodeAbiParameters(Array.from({ length: 5 }, () => ({ type: 'uint256' as const })), [x.principal, x.interest, x.coll, comp, w.gasComp]) },
      ]
    } else throw new Error(`the fake chain has no reaction to a send to ${tx.to}`)
  }

  const base = t.over
  const over = {
    ...base,
    eth_call: (params: any[]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const [tx, block] = params
      const to = lc(String(tx.to))
      const selector = String(tx.data).slice(0, 10)
      if (to === lc(ADDRESSES.stabilityPool) && selector === WITHDRAW && blocked() && !s.simPasses) throw new Error('execution reverted: StabilityPool: Cannot withdraw while there are troves with ICR < MCR')
      const h = table().get(`${to}:${selector}`)
      if (!h || tx.from) return base.eth_call(params)
      if (block !== 'latest' && w.lag.calls > 0) {
        w.lag.calls--
        throw new Error('header not found')
      }
      if (w.failReads.has(h.name)) throw new Error('execution reverted')
      const args = decodeFunctionData({ abi: h.abi, data: tx.data }).args ?? []
      return encodeFunctionResult({ abi: h.abi, functionName: h.name, result: h.fn(...args) } as never)
    },
    eth_sendRawTransaction: ([raw]: Hex[]) => {
      const p = parseTransaction(raw)
      const tx = { to: getAddress(p.to as Address), data: (p.data ?? '0x') as Hex, value: p.value ?? 0n }
      w.sent.push(tx)
      react(tx)
      w.onTx?.(tx)
      return keccak256(raw)
    },
    eth_getTransactionReceipt: (params: any[]) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const r = base.eth_getTransactionReceipt(params) as Record<string, unknown> | null
      if (!r || s.logs.length === 0) return r
      return { ...r, logs: s.logs.map((l, i) => ({ ...l, blockNumber: toHex(w.block), transactionHash: params[0], transactionIndex: '0x0', blockHash: `0x${'33'.repeat(32)}`, logIndex: toHex(i), removed: false })) }
    },
  }
  return { w, s, over, rpc: () => mockRpc(over), lens: t.lens, blocked }
}

export type SpWorld = ReturnType<typeof spWorld>
