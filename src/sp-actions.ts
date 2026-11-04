// The Stability Pool, liquidation and allowance tools: three free reads (sp_status, allowance_status, plan_sp_deposit) and, only when the operator turned writes on, five guarded writers
// (approve MUSD for the pool, deposit, withdraw, liquidate a trove under its minimum ratio, revoke an allowance). A writer reads the chain first, refuses what would revert
// or what the rules forbid and says why, and otherwise hands the exact calldata to the guarded write core (write.ts: allow-list, caps, kill file, simulation).
// What it reads back after a send is best effort: it never turns a mined tx into an error.
import { encodeFunctionData, isAddressEqual, parseEventLogs, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { erc20Abi, priceFeedAbi, sortedTrovesAbi, stabilityPoolAbi, troveManagerAbi } from './abis.ts'
import { ADDRESSES, CHAIN_ID, LEGACY_VE, txUrl } from './config.ts'
import { InputError, parseAddress, parseTokenAmount } from './inputs.ts'
import { TROVE_STATUS, fixed, isoTime, percent, withRetry, type ReadClient } from './lens.ts'
import type { Outcome, Refused, Sent, VeOptions } from './ve-actions.ts'
import type { createWriter } from './write.ts'

type Writer = Pick<ReturnType<typeof createWriter>, 'address' | 'offReason' | 'send'>
type Receipt = Awaited<ReturnType<PublicClient['getTransactionReceipt']>>

export interface SpWrite {
  approveMusd(input: { amount: string }): Promise<Outcome>
  deposit(input: { amount: string }): Promise<Outcome>
  withdraw(input: { amount: string }): Promise<Outcome>
  liquidate(input: { borrower: string }): Promise<Outcome>
  revoke(input: { token: string; spender: string }): Promise<Outcome>
}
export interface Sp {
  /** One depositor's Stability Pool position and whether a withdrawal is blocked. `blockNumber` pins the read (tests and the proof script); the tools read the latest block. */
  status(input: { address: string }, at?: { blockNumber?: bigint }): Promise<Record<string, unknown>>
  /** The non-zero BTC and MUSD allowances one wallet has given to the contracts this toolkit knows, plus one spender the caller names. */
  allowances(input: { address: string; spender?: string }, at?: { blockNumber?: bigint }): Promise<Record<string, unknown>>
  /** What depositing `amount` MUSD would do, worked out before anything is sent: the calldata, the exact approve it needs, the position after and the withdraw lock. Reads only, no signer. A deposit that cannot work comes back as `refused: true`. */
  planDeposit(input: { address: string; amount: string }, at?: { blockNumber?: bigint }): Promise<Record<string, unknown>>
  write?: SpWrite
}

const { stabilityPool: pool, troveManager, priceFeed, musd, btc } = ADDRESSES
const MAX_WALK = 8 // troves read from the tail of the sorted list
const GAS_MARGIN = 12n // the suggested gas limit is the estimate times 12/10, as in plan.ts
const UNLIMITED = 2n ** 128n // an allowance this big is "unlimited" for every practical purpose
const TOKENS = { BTC: btc, MUSD: musd } as const
const SPENDERS: readonly (readonly [string, Address])[] = [
  ['StabilityPool', pool],
  ['BorrowerOperations', ADDRESSES.borrowerOperations],
  ['veBTC', ADDRESSES.veBTC],
  ['veMEZO', ADDRESSES.veMEZO],
  ['permit2', ADDRESSES.permit2],
  ['x402Proxy', ADDRESSES.x402Proxy],
  ['poolRouter', ADDRESSES.poolRouter],
  ['legacy veBTC', LEGACY_VE.veBTC],
]

const isZero = (a: Address) => isAddressEqual(a, zeroAddress)
const messageOf = (e: unknown) => String((e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : e)).slice(0, 200)
const no = (reason: string): Refused => ({ sent: false, reason })

interface Pinned {
  block: bigint
  meta: { blockNumber: number; blockTime: string; chainId: number }
  read<T>(address: Address, abi: readonly unknown[], fn: string, args?: readonly unknown[]): Promise<T>
}
interface Row {
  trove: Address
  icr: bigint
  coll: bigint
  debt: bigint
}
interface PoolState {
  initial: bigint
  compounded: bigint
  gain: bigint
  total: bigint
  collateral: bigint
  mcr: bigint
  price: bigint
  rows: Row[] // the tail of the sorted list first
  complete: boolean // the walk ended at a trove at or above the minimum (or at the head), not at the limit
  blocked: boolean
  lowest?: Row
}

/** Plan = what a writer hands to submit: the call, and what to read back once it is mined. */
interface Plan {
  to: Address
  data: Hex
  after?: (receipt: Receipt) => Promise<Record<string, unknown>>
}

export function createSp(client: PublicClient, writer?: Writer, options: VeOptions = {}): Sp {
  const rc: ReadClient = client
  const patienceMs = options.patienceMs ?? 15_000
  const retryMs = options.retryMs ?? 500

  /** The RPC is several nodes behind one URL and the one that answers can be a block behind: after our own send, ask again until it has the receipt and the block, or the patience is spent. */
  async function patiently<T>(fn: () => Promise<T>): Promise<T> {
    const until = Date.now() + patienceMs
    for (;;) {
      try {
        return await fn()
      } catch (e) {
        if (Date.now() >= until) throw e
        await new Promise((r) => setTimeout(r, retryMs))
      }
    }
  }

  /** Pin every read of one call to one block, so the numbers in an answer agree with each other. `at` is a block we already know exists (our own receipt's), so a read waits for it. */
  async function pin(at?: bigint): Promise<Pinned> {
    const ask: <T>(fn: () => Promise<T>) => Promise<T> = at === undefined ? (fn) => withRetry(fn) : patiently
    const block = at ?? (await withRetry(() => rc.getBlockNumber()))
    const ts = (await ask(() => rc.getBlock({ blockNumber: block }))).timestamp
    return {
      block,
      meta: { blockNumber: Number(block), blockTime: isoTime(ts), chainId: CHAIN_ID },
      read: <T>(address: Address, abi: readonly unknown[], fn: string, args: readonly unknown[] = []) => ask(() => rc.readContract({ address, abi, functionName: fn, args, blockNumber: block }) as Promise<T>),
    }
  }

  /** The pool's own rule: a non-zero withdrawal reverts while the LAST trove of the sorted list has a current ratio under the minimum. Read it the way the contract does, then walk a little further up. */
  async function poolState(p: Pinned, who: Address): Promise<PoolState> {
    const sp = <T>(fn: string, args: readonly unknown[] = []) => p.read<T>(pool, stabilityPoolAbi, fn, args)
    const [initial, compounded, gain, total, collateral, mcr, sorted, feed, tm] = await Promise.all([
      sp<bigint>('deposits', [who]),
      sp<bigint>('getCompoundedMUSDDeposit', [who]),
      sp<bigint>('getDepositorCollateralGain', [who]),
      sp<bigint>('getTotalMUSDDeposits'),
      sp<bigint>('getCollateralBalance'),
      sp<bigint>('MCR'),
      sp<Address>('sortedTroves'),
      sp<Address>('priceFeed'),
      sp<Address>('troveManager'),
    ])
    const [price, last] = await Promise.all([p.read<bigint>(feed, priceFeedAbi, 'fetchPrice'), p.read<Address>(sorted, sortedTrovesAbi, 'getLast')])
    const rows: Row[] = []
    for (let cur = last; !isZero(cur) && rows.length < MAX_WALK; ) {
      // getPrev is only used when this trove is under the minimum, but asked in the same breath the three reads go out as one request (a Worker pays one subrequest for each).
      const [icr, e, prev] = await Promise.all([
        p.read<bigint>(tm, troveManagerAbi, 'getCurrentICR', [cur, price]),
        p.read<readonly bigint[]>(tm, troveManagerAbi, 'getEntireDebtAndColl', [cur]),
        p.read<Address>(sorted, sortedTrovesAbi, 'getPrev', [cur]),
      ])
      rows.push({ trove: cur, icr, coll: e[0]!, debt: e[1]! + e[2]! })
      if (icr >= mcr) break
      cur = prev
    }
    const lowest = rows.reduce<Row | undefined>((a, b) => (!a || b.icr < a.icr ? b : a), undefined)
    return { initial, compounded, gain, total, collateral, mcr, price, rows, complete: rows.length < MAX_WALK || rows[rows.length - 1]!.icr >= mcr, blocked: rows.length > 0 && rows[0]!.icr < mcr, ...(lowest ? { lowest } : {}) }
  }

  const f18 = (x: bigint) => fixed(x, 18, 18)
  function describe(p: Pinned, s: PoolState, who: Address): Record<string, unknown> {
    const under = s.rows.filter((r) => r.icr < s.mcr).map((r) => ({ trove: r.trove, icr: percent(r.icr), collateralBtc: fixed(r.coll, 18, 8), debtMusd: fixed(r.debt, 18, 4) }))
    return {
      ...p.meta,
      address: who,
      deposit: { musd: f18(s.compounded), initialMusd: f18(s.initial), musdLoss: f18(s.initial > s.compounded ? s.initial - s.compounded : 0n), btcGain: f18(s.gain) },
      pool: { totalMusd: fixed(s.total, 18, 6), collateralBtc: fixed(s.collateral, 18, 8) },
      withdraw: {
        blocked: s.blocked,
        ...(s.blocked ? { reason: `the last trove of the sorted list is at ${percent(s.rows[0]!.icr)}%, under the pool's ${percent(s.mcr)}% minimum, so the pool refuses every non-zero withdrawal until that trove is liquidated, topped up or repaid` } : {}),
        mcr: percent(s.mcr),
        btcPriceUsd: fixed(s.price, 18, 2),
        lowestIcr: s.lowest ? percent(s.lowest.icr) : null,
        lowestTrove: s.lowest?.trove ?? null,
        trovesRead: s.rows.length,
        underMcr: under,
        walkComplete: s.complete,
        foundBy: `the pool checks only the LAST trove of the SortedTroves list (ordered by collateral over principal debt, interest not counted) against its price feed and MCR; this read does the same, then walks toward the list head up to ${MAX_WALK} troves and stops at the first one at or above the minimum. lowestIcr is the lowest ratio among the troves read, so a trove further up whose interest pushed it lower is not excluded.`,
      },
      raw: { deposit: s.initial.toString(), compounded: s.compounded.toString(), collateralGain: s.gain.toString(), totalDeposits: s.total.toString(), collateralBalance: s.collateral.toString(), mcr: s.mcr.toString(), price: s.price.toString(), lowestIcr: s.lowest?.icr.toString() ?? null },
    }
  }

  const read: Sp = {
    async status({ address }, at) {
      const who = parseAddress(address)
      const p = await pin(at?.blockNumber)
      return describe(p, await poolState(p, who), who)
    },
    async allowances({ address, spender }, at) {
      const who = parseAddress(address)
      const extra = spender === undefined ? undefined : parseAddress(spender, 'spender')
      const spenders = [...SPENDERS]
      if (extra && !spenders.some(([, a]) => isAddressEqual(a, extra))) spenders.push(['(the spender you named)', extra])
      const p = await pin(at?.blockNumber)
      const rows = (
        await Promise.all(
          (Object.entries(TOKENS) as [keyof typeof TOKENS, Address][]).flatMap(([token, tokenAddress]) =>
            spenders.map(async ([name, a]) => ({ token, name, spender: a, amount: await p.read<bigint>(tokenAddress, erc20Abi, 'allowance', [who, a]) })),
          ),
        )
      ).filter((r) => r.amount > 0n)
      return {
        ...p.meta,
        address: who,
        summary: rows.length ? `${rows.length} non-zero allowance${rows.length === 1 ? '' : 's'} found` : 'no non-zero allowance found',
        allowances: rows.map((r) => ({ token: r.token, spender: r.spender, spenderName: r.name, amount: r.amount >= UNLIMITED ? 'unlimited' : f18(r.amount), raw: r.amount.toString() })),
        checked: { tokens: Object.keys(TOKENS), spenders: spenders.map(([name]) => name) },
      }
    },
    async planDeposit({ address, amount }, at) {
      const who = parseAddress(address, 'address')
      const value = parseTokenAmount(amount, 18, 'amount')
      const p = await pin(at?.blockNumber)
      const [s, allowance, balance] = await Promise.all([poolState(p, who), p.read<bigint>(musd, erc20Abi, 'allowance', [who, pool]), p.read<bigint>(musd, erc20Abi, 'balanceOf', [who])])
      const d = describe(p, s, who) as { pool: unknown; withdraw: { blocked: boolean; reason?: string }; raw: Record<string, string | null> }
      const head = { ...p.meta, action: 'sp_deposit', depositor: who }
      const raw = { ...d.raw, amount: value.toString(), allowance: allowance.toString(), balance: balance.toString() }
      if (balance < value) {
        const reason = `this wallet holds only ${f18(balance)} MUSD, less than the ${f18(value)} MUSD to deposit`
        return { refused: true, ...head, reason, warnings: [], summary: `Refused at block ${p.block}, nothing to send: ${reason}`, raw }
      }
      const warnings: string[] = []
      const needsApproval = allowance < value
      const data = encodeFunctionData({ abi: stabilityPoolAbi, functionName: 'provideToSP', args: [value] })
      let gas: string | null = null
      if (needsApproval) warnings.push(`the Stability Pool may pull only ${f18(allowance)} MUSD from this wallet: send the exact approve below first, then plan again for a gas estimate`)
      else {
        try {
          // At the latest block, as in plan.ts: a node a block behind would refuse a pinned estimate, and gas hardly depends on the block.
          gas = (((await withRetry(() => client.estimateGas({ account: who, to: pool, data }))) * GAS_MARGIN) / 10n).toString()
        } catch (e) {
          warnings.push(`the gas estimate failed (${messageOf(e)}): the chain may still refuse this call, so do not send it until you know why`)
        }
      }
      if (d.withdraw.blocked) warnings.push(`the deposit is accepted, but MUSD put in now cannot be taken out until the pool allows withdrawals again: ${d.withdraw.reason}`)
      if (s.gain > 0n) warnings.push(`the deposit also sends the pending ${f18(s.gain)} BTC gain to this wallet (the pool does this on every deposit)`)
      const after = s.compounded + value
      return {
        refused: false,
        ...head,
        to: pool,
        data,
        value: '0',
        gas,
        approval: {
          needed: needsApproval,
          spender: pool,
          allowanceMusd: f18(allowance),
          ...(needsApproval ? { to: musd, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [pool, value] }), note: 'an exact approve for this deposit; the deposit uses it up' } : {}),
        },
        deposit: { amountMusd: f18(value), musdBefore: f18(s.compounded), musdAfter: f18(after), btcGainPaidOut: f18(s.gain) },
        pool: d.pool,
        withdraw: d.withdraw,
        warnings,
        summary: `Deposit ${f18(value)} MUSD into the Stability Pool at block ${p.block}: the wallet's deposit goes ${f18(s.compounded)} -> ${f18(after)} MUSD${needsApproval ? ', after an exact approve (allowance now ' + f18(allowance) + ')' : ''}. ${d.withdraw.blocked ? 'Withdrawals are blocked right now.' : 'Withdrawals are open right now.'}${warnings.length ? ` ${warnings.length} warning(s).` : ''}`,
        raw,
      }
    },
  }
  if (!writer) return read
  const w: Writer = writer

  // ---- writes --------------------------------------------------------------------------------------------------------------------------------

  /** Send through the write core, then read the receipt. Nothing after the send may throw: a mined tx must come back as a result. */
  async function submit(plan: Plan): Promise<Outcome> {
    let r: Awaited<ReturnType<Writer['send']>>
    try {
      r = await w.send({ to: plan.to, data: plan.data })
    } catch (e) {
      return no(`the write core failed (${messageOf(e)}); check the receipts file before trying again`)
    }
    if (!r.sent) return r
    // An unknown status means the write core already waited for a receipt in vain: ask once more, do not wait again.
    const getReceipt = () => client.getTransactionReceipt({ hash: r.hash })
    const receipt: Receipt | undefined = await (r.status === 'unknown' ? getReceipt() : patiently(getReceipt)).catch(() => undefined)
    const base: Sent = { sent: true, hash: r.hash, status: r.status, explorer: txUrl(r.hash), blockNumber: receipt ? receipt.blockNumber.toString() : null, gasUsed: receipt ? receipt.gasUsed.toString() : null, ...(r.note ? { note: r.note } : {}) }
    if (!plan.after || r.status !== 'success') return base
    // Without the receipt there is no block to pin the read-back to, and a read at "latest" can still be the state before the send: show nothing instead.
    if (!receipt) return { ...base, readBack: 'the transaction succeeded, but the RPC did not return its receipt in time, so the new state is not shown; read it with sp_status or allowance_status in a few seconds' }
    try {
      return { ...base, ...(await plan.after(receipt)) }
    } catch (e) {
      return { ...base, readBack: `the transaction was mined, but reading the result back failed (${messageOf(e)})` }
    }
  }

  /** Check the writer is on, build the plan (chain read errors become a refusal; bad input stays an InputError), then submit. */
  async function run(build: (me: Address) => Promise<Refused | Plan>): Promise<Outcome> {
    const me = w.address
    if (w.offReason || !me) return no(w.offReason ?? 'writes are off')
    let plan: Refused | Plan
    try {
      plan = await build(me)
    } catch (e) {
      if (e instanceof InputError) throw e
      return no(`a chain read failed before anything was sent: ${messageOf(e)}`)
    }
    return 'sent' in plan ? plan : submit(plan)
  }

  /** The pool position of `me` at the receipt's block (the same answer sp_status gives for that block). */
  const poolAt = async (rcpt: Receipt, me: Address) => {
    const p = await pin(rcpt.blockNumber)
    return describe(p, await poolState(p, me), me)
  }
  const allowanceAt = async (rcpt: Receipt, token: Address, me: Address, spender: Address) => (await pin(rcpt.blockNumber)).read<bigint>(token, erc20Abi, 'allowance', [me, spender])

  const write: SpWrite = {
    approveMusd: ({ amount }) =>
      run(async (me) => {
        const value = parseTokenAmount(amount, 18, 'amount')
        const current = await (await pin()).read<bigint>(musd, erc20Abi, 'allowance', [me, pool])
        if (current === value) return no(`the Stability Pool already has an allowance of exactly ${amount} MUSD from this wallet, so no approve was needed`)
        return {
          to: musd,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [pool, value] }),
          after: async (rcpt) => ({ spender: pool, allowanceBefore: f18(current), allowance: f18(await allowanceAt(rcpt, musd, me, pool)) }),
        }
      }),

    deposit: ({ amount }) =>
      run(async (me) => {
        const value = parseTokenAmount(amount, 18, 'amount')
        const p = await pin()
        const [allowance, balance] = await Promise.all([p.read<bigint>(musd, erc20Abi, 'allowance', [me, pool]), p.read<bigint>(musd, erc20Abi, 'balanceOf', [me])])
        if (allowance < value) return no(`the Stability Pool may pull only ${f18(allowance)} MUSD from this wallet; call sp_approve_musd for exactly ${amount} first`)
        if (balance < value) return no(`this wallet holds only ${f18(balance)} MUSD, less than the ${amount} MUSD to deposit`)
        return { to: pool, data: encodeFunctionData({ abi: stabilityPoolAbi, functionName: 'provideToSP', args: [value] }), after: async (rcpt) => ({ spAfter: await poolAt(rcpt, me) }) }
      }),

    withdraw: ({ amount }) =>
      run(async (me) => {
        const value = parseTokenAmount(amount, 18, 'amount')
        const p = await pin()
        const s = await poolState(p, me)
        if (s.compounded === 0n) return no('this wallet has no MUSD deposit in the Stability Pool')
        if (value > s.compounded) return no(`this wallet's deposit is ${f18(s.compounded)} MUSD; withdraw at most that (the contract would pay out the whole deposit for a larger amount, and this tool does not let an amount mean something else)`)
        const data = encodeFunctionData({ abi: stabilityPoolAbi, functionName: 'withdrawFromSP', args: [value] })
        if (s.blocked) {
          const low = s.lowest!
          const sim = await client.call({ account: me, to: pool, data }).then(
            () => 'a simulation of this exact call did not revert just now, so the state may have moved; read sp_status and try again',
            (e) => `a simulation of this exact call reverts: ${messageOf(e)}`,
          )
          return no(`the pool refuses every non-zero withdrawal while a trove is under its ${percent(s.mcr)}% minimum: the lowest ratio found is ${percent(low.icr)}% (trove ${low.trove}) at block ${p.block}; ${sim}`)
        }
        return { to: pool, data, after: async (rcpt) => ({ spAfter: await poolAt(rcpt, me) }) }
      }),

    liquidate: ({ borrower }) =>
      run(async (me) => {
        const target = parseAddress(borrower, 'borrower')
        const p = await pin()
        const [status, price, mcr] = await Promise.all([p.read<number>(troveManager, troveManagerAbi, 'getTroveStatus', [target]), p.read<bigint>(priceFeed, priceFeedAbi, 'fetchPrice'), p.read<bigint>(troveManager, troveManagerAbi, 'MCR')])
        if (Number(status) !== 1) return no(`${target} has no active trove (its status is ${TROVE_STATUS[Number(status)] ?? status})`)
        const icr = await p.read<bigint>(troveManager, troveManagerAbi, 'getCurrentICR', [target, price])
        if (icr >= mcr) return no(`the trove of ${target} is at ${percent(icr)}% at block ${p.block}, not under the ${percent(mcr)}% minimum, so it cannot be liquidated`)
        return {
          to: troveManager,
          data: encodeFunctionData({ abi: troveManagerAbi, functionName: 'liquidate', args: [target] }),
          after: async (rcpt) => {
            const q = await pin(rcpt.blockNumber)
            const logs = parseEventLogs({ abi: troveManagerAbi, logs: rcpt.logs.filter((l) => isAddressEqual(l.address, troveManager)), eventName: ['TroveLiquidated', 'Liquidation'] })
            const out: Record<string, unknown> = { borrower: target, icrBefore: percent(icr), troveStatusAfter: TROVE_STATUS[Number(await q.read<number>(troveManager, troveManagerAbi, 'getTroveStatus', [target]))] }
            for (const l of logs) {
              if (l.eventName === 'TroveLiquidated' && isAddressEqual(l.args.borrower, target)) out.troveLiquidated = { debtMusd: f18(l.args.debt), collateralBtc: f18(l.args.coll) }
              if (l.eventName === 'Liquidation') out.liquidation = { principalMusd: f18(l.args.liquidatedPrincipal), interestMusd: f18(l.args.liquidatedInterest), collateralBtc: f18(l.args.liquidatedColl), collateralCompensationBtc: f18(l.args.collGasCompensation), gasCompensationMusd: f18(l.args.gasCompensation) }
            }
            return { ...out, spAfter: await poolAt(rcpt, me) }
          },
        }
      }),

    revoke: ({ token, spender }) =>
      run(async (me) => {
        const symbol = String(token).trim().toUpperCase()
        if (symbol !== 'BTC' && symbol !== 'MUSD') throw new InputError('token must be BTC or MUSD')
        const to = parseAddress(spender, 'spender')
        if (isZero(to)) throw new InputError('spender must not be the zero address')
        const tokenAddress = TOKENS[symbol]
        const current = await (await pin()).read<bigint>(tokenAddress, erc20Abi, 'allowance', [me, to])
        if (current === 0n) return no(`${to} has no ${symbol} allowance from this wallet, so there is nothing to revoke`)
        return {
          to: tokenAddress,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [to, 0n] }),
          after: async (rcpt) => ({ token: symbol, spender: to, allowanceBefore: f18(current), allowance: f18(await allowanceAt(rcpt, tokenAddress, me, to)) }),
        }
      }),
  }
  return { ...read, write }
}
