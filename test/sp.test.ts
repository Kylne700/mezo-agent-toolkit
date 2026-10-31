// The Stability Pool, liquidation and allowance tools (src/sp-actions.ts) against a fake pool on top of the fake trove system (test/helpers/sp.ts).
// No network and no real transaction: the key is a throwaway generated here. A refused call must stop before the write core simulates, estimates or sends.
// Whether a withdrawal is blocked is checked against `blocked()` of the fake world, which re-applies the pool's rule to the plain list of troves and shares no code with src/.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFunctionData, encodeFunctionData, formatUnits, getAddress, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterAll, describe, expect, it } from 'vitest'
import { erc20Abi, stabilityPoolAbi, troveManagerAbi } from '../src/abis.ts'
import { ADDRESSES } from '../src/config.ts'
import { InputError } from '../src/inputs.ts'
import { createSp } from '../src/sp-actions.ts'
import type { Outcome, VeOptions } from '../src/ve-actions.ts'
import { createWriter } from '../src/write.ts'
import { spWorld, type SpWorld } from './helpers/sp.ts'
import { e18, troveAddr } from './helpers/trove.ts'
import { OTHER } from './helpers/write.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const root = mkdtempSync(join(tmpdir(), 'mezo-sp-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const key = generatePrivateKey()
const keyFile = join(root, 'throwaway.key')
writeFileSync(keyFile, key, { mode: 0o600 })
const ME = privateKeyToAccount(key).address
const NOW = new Date('2026-10-31T12:00:00Z')
const SP = ADDRESSES.stabilityPool
const noop = () => {}
const TAIL = getAddress(troveAddr(5)) // the 107% trove: the tail of the fake list
const NEXT = getAddress(troveAddr(4)) // 115.5%, the next one up

type Tweak = (x: SpWorld) => void
const all = (...f: Tweak[]): Tweak => (x) => f.forEach((g) => g(x))
/** A deposit of ours in the pool, as the pool stored it. */
const holds = (musd: string): Tweak => (x) => void x.s.initial.set(ME.toLowerCase(), e18(musd))
/** An allowance the wallet gave (MUSD to the pool unless said otherwise). */
const approved = (amount: string | bigint, spender: string = SP, token: 'musd' | 'btc' = 'musd'): Tweak => (x) => void x.s.allowances.set(`${token}:${spender.toLowerCase()}`, typeof amount === 'bigint' ? amount : e18(amount))
/** The 107% trove is gone, so the tail of the list is at 115.5% and the pool lets deposits out. */
const noTail: Tweak = (x) => void x.w.troves.splice(x.w.troves.findIndex((t) => t.owner === troveAddr(5)), 1)
const trove = (x: SpWorld, i: number) => x.w.troves.find((t) => t.owner === troveAddr(i))!

function chain(tweak: Tweak = noop) {
  const x = spWorld(ME)
  tweak(x)
  const rpc = x.rpc()
  return { x, w: x.w, rpc, sp: createSp(rpc.client) }
}

// ---- the reads -------------------------------------------------------------------------------------------------------------------------------

describe('sp_status', () => {
  it('with a trove under 110% at the tail of the list: blocked, with the ratio, the trove and what was walked', async () => {
    const c = chain()
    const r: Json = await c.sp.status({ address: ME })
    expect(r).toMatchObject({
      blockNumber: 16_500_000, blockTime: new Date(1_793_438_189_000).toISOString(), chainId: 31611, address: ME,
      deposit: { musd: '0', initialMusd: '0', musdLoss: '0', btcGain: '0' },
      pool: { totalMusd: '86000000', collateralBtc: '176' },
      withdraw: { blocked: true, mcr: '110', btcPriceUsd: '77000', lowestIcr: '106.98', lowestTrove: TAIL, trovesRead: 2, walkComplete: true, underMcr: [{ trove: TAIL, icr: '106.98', collateralBtc: '0.0264', debtMusd: '1900' }] },
    })
    expect(r.withdraw.reason).toMatch(/last trove of the sorted list is at 106\.98%, under the pool's 110% minimum, so the pool refuses every non-zero withdrawal/)
    expect(r.withdraw.foundBy).toMatch(/checks only the LAST trove/)
    expect(r.withdraw.blocked).toBe(c.x.blocked())
    // the numbers are exact in wei: the ratio the TroveManager reports for that trove
    expect(r.raw).toMatchObject({ mcr: e18('1.1').toString(), price: e18(77_000).toString(), lowestIcr: ((e18('0.0264') * e18(77_000)) / e18(1900)).toString() })
  })

  it('without that trove the tail is at 115.5%: not blocked, no reason, nothing under the minimum', async () => {
    const c = chain(noTail)
    const r: Json = await c.sp.status({ address: ME })
    expect(r.withdraw).toMatchObject({ blocked: false, lowestIcr: '115.5', lowestTrove: NEXT, trovesRead: 1, walkComplete: true, underMcr: [] })
    expect(r.withdraw).not.toHaveProperty('reason')
    expect(c.x.blocked()).toBe(false)
  })

  it('blocked follows the pool rule (the tail of the list only) in several worlds', async () => {
    const worlds: [string, Tweak, boolean][] = [
      ['default', noop, true],
      ['the tail is gone', noTail, false],
      ['BTC at $100,000', (x) => (x.w.price = e18(100_000)), false],
      ['BTC at $60,000', (x) => (x.w.price = e18(60_000)), true],
      ['the tail is fine, a trove above it is under 110% through interest the list order ignores: the pool is NOT blocked', all(noTail, (x) => (trove(x, 3).interest = e18(500))), false],
      ['the tail is under 110% through interest', all(noTail, (x) => (trove(x, 4).interest = e18(300))), true],
    ]
    for (const [name, tweak, blocked] of worlds) {
      const c = chain(tweak)
      expect(c.x.blocked(), `${name}: the fake rule`).toBe(blocked)
      const r: Json = await c.sp.status({ address: ME })
      expect(r.withdraw.blocked, name).toBe(blocked)
    }
  })

  it('walks up from the tail while troves stay under 110% and stops at the first one above', async () => {
    const c = chain((x) => (x.w.price = e18(60_000)))
    const r: Json = await c.sp.status({ address: ME })
    expect(r.withdraw).toMatchObject({ blocked: true, lowestIcr: '83.36', trovesRead: 4, walkComplete: true })
    expect(r.withdraw.underMcr.map((u: Json) => u.icr)).toEqual(['83.36', '90', '99.58']) // the fourth trove read is at 120%
  })

  it('says when the walk hit its limit of eight troves', async () => {
    const deep = chain((x) => {
      x.w.price = e18(20_000) // every trove is under 110%
      for (let i = 8; i <= 10; i++) x.w.troves.push({ owner: troveAddr(i), coll: e18('0.01'), principal: e18(2000), interest: 0n, capacity: 0n })
    })
    const r: Json = await deep.sp.status({ address: ME })
    expect(r.withdraw).toMatchObject({ blocked: true, trovesRead: 8, walkComplete: false })
  })

  it('lowestIcr is the lowest ratio read: a trove above the tail can be lower, because the list order ignores interest', async () => {
    const c = chain((x) => (trove(x, 4).interest = e18(300)))
    const r: Json = await c.sp.status({ address: ME })
    expect(r.withdraw).toMatchObject({ blocked: true, lowestIcr: '100.43', lowestTrove: NEXT, trovesRead: 3 })
    expect(r.withdraw.reason).toContain('at 106.98%') // the tail is what the pool checks
  })

  it('shows the deposit, the MUSD lost to liquidations and the BTC gained, exactly', async () => {
    const c = chain((x) => {
      holds('10')(x)
      x.s.compounded.set(ME.toLowerCase(), e18(10) - 200_000_000_000_000n)
      x.s.gain.set(ME.toLowerCase(), 3_000_000_000n)
    })
    const r: Json = await c.sp.status({ address: ME })
    expect(r.deposit).toEqual({ musd: '9.9998', initialMusd: '10', musdLoss: '0.0002', btcGain: '0.000000003' })
    expect(r.raw).toMatchObject({ deposit: e18(10).toString(), compounded: (e18(10) - 200_000_000_000_000n).toString(), collateralGain: '3000000000' })
  })

  it('a pinned read asks that block for everything and never asks which block is the latest', async () => {
    const c = chain()
    const r: Json = await c.sp.status({ address: ME }, { blockNumber: 16_499_000n })
    expect(r.blockNumber).toBe(16_499_000)
    const calls = c.rpc.calls.filter((x) => x.method === 'eth_call')
    expect(calls.length).toBeGreaterThan(10)
    expect([...new Set(calls.map((x) => x.params[1]))]).toEqual([toHex(16_499_000n)])
    expect(c.rpc.methods()).not.toContain('eth_blockNumber')
  })

  it('a bad address is an input error and costs no chain read', async () => {
    const c = chain()
    await expect(c.sp.status({ address: 'nobody' })).rejects.toThrow(InputError)
    await expect(c.sp.allowances({ address: 'nobody' })).rejects.toThrow(InputError)
    await expect(c.sp.allowances({ address: ME, spender: '0x12' })).rejects.toThrow(InputError)
    expect(c.rpc.calls).toEqual([])
  })
})

describe('allowance_status', () => {
  it('lists only the non-zero BTC and MUSD allowances to the known contracts, in wei and as unlimited', async () => {
    const c = chain(all(approved('10'), approved(2n ** 256n - 1n, ADDRESSES.veBTC, 'btc'), approved(5n, OTHER)))
    const r: Json = await c.sp.allowances({ address: ME })
    expect(r.summary).toBe('2 non-zero allowances found') // OTHER is not a contract the toolkit knows
    expect(r.allowances).toEqual([
      { token: 'BTC', spender: ADDRESSES.veBTC, spenderName: 'veBTC', amount: 'unlimited', raw: (2n ** 256n - 1n).toString() },
      { token: 'MUSD', spender: SP, spenderName: 'StabilityPool', amount: '10', raw: e18(10).toString() },
    ])
    expect(r.checked.tokens).toEqual(['BTC', 'MUSD'])
    expect(r.checked.spenders).toEqual(['StabilityPool', 'BorrowerOperations', 'veBTC', 'veMEZO', 'permit2', 'x402Proxy', 'poolRouter', 'legacy veBTC'])
  })

  it('also reads the one spender the caller names; a known spender is not read twice', async () => {
    const c = chain(approved(5n, OTHER))
    const r: Json = await c.sp.allowances({ address: ME, spender: OTHER })
    expect(r.allowances).toEqual([{ token: 'MUSD', spender: getAddress(OTHER), spenderName: '(the spender you named)', amount: '0.000000000000000005', raw: '5' }])
    expect(r.checked.spenders).toHaveLength(9)
    const known: Json = await chain().sp.allowances({ address: ME, spender: SP })
    expect(known.checked.spenders).toHaveLength(8)
    expect(known.summary).toBe('no non-zero allowance found')
    expect(known.allowances).toEqual([])
  })
})

describe('planDeposit (the plan_sp_deposit tool and the /plan/sp-deposit route: reads only, no signer)', () => {
  const provide = (amount: bigint) => encodeFunctionData({ abi: stabilityPoolAbi, functionName: 'provideToSP', args: [amount] })
  const noSend = (c: ReturnType<typeof chain>) => {
    expect(c.rpc.methods()).not.toContain('eth_sendRawTransaction')
    expect(c.rpc.calls.filter((x) => x.method === 'eth_call' && x.params[0]?.from)).toEqual([])
  }

  it('a covered deposit: the exact provideToSP call, a gas estimate, the position before and after, and the withdraw lock as a warning, not a refusal', async () => {
    const c = chain(all(holds('10'), approved('5')))
    const r: Json = await c.sp.planDeposit({ address: ME, amount: '5' })
    expect(r).toMatchObject({ refused: false, action: 'sp_deposit', depositor: ME, to: SP, data: provide(e18(5)), value: '0', gas: '300000', blockNumber: 16_500_000 })
    expect(r.approval).toEqual({ needed: false, spender: SP, allowanceMusd: '5' })
    expect(r.deposit).toEqual({ amountMusd: '5', musdBefore: '10', musdAfter: '15', btcGainPaidOut: '0' })
    expect(r.withdraw).toMatchObject({ blocked: true, underMcr: [expect.objectContaining({ trove: TAIL })] })
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/cannot be taken out/)
    expect(r.raw).toMatchObject({ amount: e18(5).toString(), allowance: e18(5).toString(), compounded: e18(10).toString() })
    noSend(c)
  })

  it('an allowance that is too small: the exact approve to send first, no gas estimate, a warning', async () => {
    const c = chain(approved('2'))
    const r: Json = await c.sp.planDeposit({ address: ME, amount: '5' })
    expect(r).toMatchObject({ refused: false, to: SP, data: provide(e18(5)), gas: null })
    expect(r.approval).toEqual({
      needed: true,
      spender: SP,
      allowanceMusd: '2',
      to: ADDRESSES.musd,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SP, e18(5)] }),
      note: expect.stringMatching(/exact approve/),
    })
    expect(r.warnings[0]).toMatch(/may pull only 2 MUSD.*approve below first/)
    expect(c.rpc.methods()).not.toContain('eth_estimateGas')
    noSend(c)
  })

  it('a free pool and a pending BTC gain: no lock warning, the gain is named, and it is what the pool pays out with the deposit', async () => {
    const c = chain(all(noTail, holds('10'), approved('5'), (x) => void x.s.gain.set(ME.toLowerCase(), 3_000_000_000n)))
    const r: Json = await c.sp.planDeposit({ address: ME, amount: '5' })
    expect(r.withdraw).toMatchObject({ blocked: false, underMcr: [] })
    expect(r.deposit.btcGainPaidOut).toBe('0.000000003')
    expect(r.warnings).toEqual([expect.stringMatching(/pending 0\.000000003 BTC gain/)])
    expect(r.summary).toMatch(/Withdrawals are open/)
  })

  it('more MUSD than the wallet holds is a refusal with the reason and nothing to send', async () => {
    const c = chain()
    const r: Json = await c.sp.planDeposit({ address: ME, amount: '1000' })
    expect(r).toMatchObject({ refused: true, action: 'sp_deposit', blockNumber: 16_500_000 })
    expect(r.reason).toMatch(/holds only 15\.7 MUSD, less than the 1000 MUSD/)
    expect(r).not.toHaveProperty('data')
    expect(r).not.toHaveProperty('to')
    expect(c.rpc.methods()).not.toContain('eth_estimateGas')
  })

  it('a failing gas estimate is a warning and a null gas, not an exception', async () => {
    const c = chain(all(approved('5'), (x) => void (x.w.estimateFails = true)))
    const r: Json = await c.sp.planDeposit({ address: ME, amount: '5' })
    expect(r).toMatchObject({ refused: false, gas: null, data: provide(e18(5)) })
    expect(r.warnings.join(' ')).toMatch(/the gas estimate failed .*fake estimate failure/)
  })

  it('a pinned plan asks that block for every state read', async () => {
    const c = chain(approved('5'))
    const r: Json = await c.sp.planDeposit({ address: ME, amount: '5' }, { blockNumber: 16_499_000n })
    expect(r.blockNumber).toBe(16_499_000)
    const calls = c.rpc.calls.filter((x) => x.method === 'eth_call')
    expect(calls.length).toBeGreaterThan(10)
    expect([...new Set(calls.map((x) => x.params[1]))]).toEqual([toHex(16_499_000n)])
  })

  it('bad input is an input error and costs no chain read', async () => {
    const c = chain()
    for (const bad of [
      { address: 'nobody', amount: '5' },
      { address: ME, amount: '0' },
      { address: ME, amount: '-1' },
      { address: ME, amount: '1e3' },
      { address: ME, amount: 'abc' },
      { address: ME, amount: '1.0000000000000000001' },
      { address: ME, amount: 5 as unknown as string },
    ])
      await expect(c.sp.planDeposit(bad)).rejects.toThrow(InputError)
    expect(c.rpc.calls).toEqual([])
  })
})

// ---- the writers -----------------------------------------------------------------------------------------------------------------------------

/** Caps for the cases: a bit above 10 MUSD per call, and a little BTC for gas. */
const CAPS = { MEZO_WRITE_MAX_MUSD_PER_CALL: '11', MEZO_WRITE_MAX_MUSD_PER_DAY: '50', MEZO_WRITE_MAX_BTC_PER_CALL: '0.001', MEZO_WRITE_MAX_BTC_PER_DAY: '0.01', MEZO_WRITE_RISKY: '1' }

/** A fake chain, a writer on the SHIPPED allow-list (a fresh receipts ledger and kill file per case) and the tools on top. */
function setup(env: Record<string, string | undefined> = {}, tweak: Tweak = noop, patience: VeOptions = { patienceMs: 0 }) {
  const x = spWorld(ME)
  tweak(x)
  const rpc = x.rpc()
  const dir = mkdtempSync(join(root, 'case-'))
  const receipts = join(dir, 'receipts.jsonl')
  const writer = createWriter({ env: { MEZO_WRITE_ENABLE: 'testnet', MEZO_KEY_FILE: keyFile, MEZO_WRITE_RECEIPTS_FILE: receipts, ...CAPS, ...env }, client: rpc.client, now: () => NOW, receiptTimeoutMs: 200 })
  const sp = createSp(rpc.client, writer, patience)
  const lines = (): Json[] => (existsSync(receipts) ? readFileSync(receipts, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  return { x, w: x.w, s: x.s, rpc, dir, sp, write: sp.write!, lines }
}
type Case = ReturnType<typeof setup>
const reason = async (p: Promise<Outcome>) => {
  const r = await p
  return r.sent ? 'sent' : r.reason
}
/** Nothing was sent or simulated by the write core. */
const unsent = (c: Case) => {
  expect(c.rpc.methods()).not.toContain('eth_sendRawTransaction')
  expect(c.rpc.calls.filter((x) => x.method === 'eth_call' && x.params[0]?.from)).toEqual([])
  expect(c.lines()).toEqual([])
}
/** The tool refused on its own reads: the write core was never reached, so not even the gas was estimated or the chain id asked. */
const beforeCore = (c: Case) => {
  unsent(c)
  expect(c.rpc.methods()).not.toContain('eth_estimateGas')
  expect(c.rpc.methods()).not.toContain('eth_chainId')
}
/** The pool the way the StabilityPool itself reports it at the receipt block. */
async function direct(c: Case) {
  const rd = (fn: string, args: unknown[] = []) => c.rpc.client.readContract({ address: SP, abi: stabilityPoolAbi, functionName: fn, args, blockNumber: c.w.block } as never).then(String)
  return { deposit: await rd('deposits', [ME]), compounded: await rd('getCompoundedMUSDDeposit', [ME]), collateralGain: await rd('getDepositorCollateralGain', [ME]), totalDeposits: await rd('getTotalMUSDDeposits'), collateralBalance: await rd('getCollateralBalance'), mcr: await rd('MCR') }
}
const poolRaw = ({ deposit, compounded, collateralGain, totalDeposits, collateralBalance, mcr }: Json) => ({ deposit, compounded, collateralGain, totalDeposits, collateralBalance, mcr })
const call = (c: Case, i: number) => c.w.sent[i]!

describe('without a writer, or with writes off', () => {
  it('no writer: the three reads only', () => {
    const { rpc } = chain()
    expect(Object.keys(createSp(rpc.client)).sort()).toEqual(['allowances', 'planDeposit', 'status'])
  })

  it('writes off: every writer refuses with the writer\'s reason and reads nothing', async () => {
    const off = setup({ MEZO_WRITE_ENABLE: 'mainnet' })
    for (const r of [off.write.approveMusd({ amount: '10' }), off.write.deposit({ amount: '10' }), off.write.withdraw({ amount: '1' }), off.write.liquidate({ borrower: troveAddr(5) }), off.write.revoke({ token: 'MUSD', spender: SP })])
      expect(await reason(r)).toMatch(/writes are off \(the operator sets MEZO_WRITE_ENABLE=testnet/)
    expect(off.rpc.calls).toEqual([])
  })
})

describe('sp_approve_musd', () => {
  it('approves exactly the amount for the pool: calldata, a ledger line counted as MUSD, the allowance read back at the receipt block', async () => {
    const c = setup()
    const r: Json = await c.write.approveMusd({ amount: ' 10 ' })
    expect(r).toMatchObject({ sent: true, status: 'success', blockNumber: '16500000', gasUsed: '250000', spender: SP, allowanceBefore: '0', allowance: '10' })
    expect(r.explorer).toMatch(/^https:\/\/explorer\.test\.mezo\.org\/tx\/0x[0-9a-f]{64}$/)
    expect(c.w.sent).toHaveLength(1)
    expect(call(c, 0)).toMatchObject({ to: ADDRESSES.musd, value: 0n })
    expect(decodeFunctionData({ abi: erc20Abi, data: call(c, 0).data })).toEqual({ functionName: 'approve', args: [SP, e18(10)] })
    expect(c.lines()).toMatchObject([{ name: 'sp_approve_musd', from: ME, to: ADDRESSES.musd, status: 'success', musd: e18(10).toString() }])
    expect(BigInt(c.lines()[0].btc)).toBeLessThan(e18('0.0001')) // gas only
    expect(c.s.allowances.get(`musd:${SP.toLowerCase()}`)).toBe(e18(10))
  })

  it('refuses when the pool already has exactly that allowance; bad amounts are input errors; the core\'s MUSD cap still applies', async () => {
    const same = setup({}, approved('10'))
    expect(await reason(same.write.approveMusd({ amount: '10' }))).toMatch(/already has an allowance of exactly 10 MUSD from this wallet, so no approve was needed/)
    beforeCore(same)
    const a = setup()
    for (const bad of ['0', '-1', '1e18', 'abc', '']) await expect(a.write.approveMusd({ amount: bad }), bad).rejects.toThrow(InputError)
    expect(a.rpc.calls).toEqual([])
    const big = setup()
    expect(await reason(big.write.approveMusd({ amount: '12' }))).toMatch(/12 MUSD is over the per-call cap of 11 MUSD/)
    unsent(big)
  })
})

describe('sp_deposit', () => {
  it('deposits the approved amount; the position is read back at the receipt block and equals the pool\'s own reads', async () => {
    const c = setup({}, approved('10'))
    const r: Json = await c.write.deposit({ amount: '10' })
    expect(r).toMatchObject({ sent: true, status: 'success', blockNumber: '16500000' })
    expect(c.w.sent).toHaveLength(1)
    expect(call(c, 0)).toMatchObject({ to: SP, value: 0n })
    expect(decodeFunctionData({ abi: stabilityPoolAbi, data: call(c, 0).data })).toEqual({ functionName: 'provideToSP', args: [e18(10)] })
    expect(r.spAfter).toMatchObject({ blockNumber: 16_500_000, deposit: { musd: '10', initialMusd: '10', musdLoss: '0', btcGain: '0' }, pool: { totalMusd: '86000010' }, withdraw: { blocked: true, lowestIcr: '106.98' } })
    expect(poolRaw(r.spAfter.raw)).toEqual(await direct(c)) // what the tool shows is what the pool reports at that block, to the wei
    expect(c.lines()).toMatchObject([{ name: 'sp_deposit', to: SP, status: 'success', musd: e18(10).toString() }])
    expect(BigInt(c.lines()[0].btc)).toBeLessThan(e18('0.0001'))
    expect(c.w.musd).toBe(e18('5.7'))
  })

  it('refuses with too little allowance or too little MUSD before the write core is reached; the core\'s cap still applies', async () => {
    const none = setup()
    expect(await reason(none.write.deposit({ amount: '10' }))).toMatch(/may pull only 0 MUSD from this wallet; call sp_approve_musd for exactly 10 first/)
    const part = setup({}, approved('5'))
    expect(await reason(part.write.deposit({ amount: '10' }))).toMatch(/may pull only 5 MUSD from this wallet; call sp_approve_musd for exactly 10 first/)
    const poor = setup({}, all(approved('10'), (x) => (x.w.musd = e18(5))))
    expect(await reason(poor.write.deposit({ amount: '10' }))).toMatch(/this wallet holds only 5 MUSD, less than the 10 MUSD to deposit/)
    for (const c of [none, part, poor]) beforeCore(c)
    const big = setup({}, approved('12'))
    expect(await reason(big.write.deposit({ amount: '12' }))).toMatch(/12 MUSD is over the per-call cap of 11 MUSD/)
    unsent(big)
    await expect(none.write.deposit({ amount: '0' })).rejects.toThrow(InputError)
  })
})

describe('sp_withdraw', () => {
  const ONE = { amount: '1' }

  it('refuses while a trove is under 110%: names the lowest ratio, shows the simulated revert, and sends nothing', async () => {
    const c = setup({}, holds('10'))
    const why = await reason(c.write.withdraw(ONE))
    expect(why).toMatch(/^the pool refuses every non-zero withdrawal while a trove is under its 110% minimum: the lowest ratio found is 106\.98% \(trove 0x[0-9a-fA-F]{40}\) at block 16500000; a simulation of this exact call reverts: /)
    expect(why).toContain(TAIL)
    expect(why).toMatch(/Cannot withdraw while there are troves with ICR < MCR/)
    expect(c.w.sent).toEqual([])
    expect(c.rpc.methods()).not.toContain('eth_sendRawTransaction')
    expect(c.lines()).toEqual([])
    // the simulation was of the exact call, from our wallet to the pool, and it is the only call that carried a sender
    const sim = c.rpc.calls.filter((x) => x.method === 'eth_call' && x.params[0]?.from)
    expect(sim).toHaveLength(1)
    expect(sim[0]!.params[0].data).toBe(encodeFunctionData({ abi: stabilityPoolAbi, functionName: 'withdrawFromSP', args: [e18(1)] }))
    expect([String(sim[0]!.params[0].from).toLowerCase(), String(sim[0]!.params[0].to).toLowerCase()]).toEqual([ME.toLowerCase(), SP.toLowerCase()])
    expect(c.rpc.methods()).not.toContain('eth_estimateGas')
  })

  it('if the simulation does not revert although the reads say blocked, it still refuses and says the state may have moved', async () => {
    const c = setup({}, all(holds('10'), (x) => (x.s.simPasses = true)))
    expect(await reason(c.write.withdraw(ONE))).toMatch(/the lowest ratio found is 106\.98%.*a simulation of this exact call did not revert just now, so the state may have moved/)
    expect(c.rpc.methods()).not.toContain('eth_sendRawTransaction')
    expect(c.rpc.calls.filter((x) => x.method === 'eth_call' && x.params[0]?.from)).toHaveLength(1) // the tool's own simulation, not the write core's
    expect(c.rpc.methods()).not.toContain('eth_estimateGas')
    expect(c.lines()).toEqual([])
  })

  it('refuses with no deposit, or for more than the deposit, before the write core is reached', async () => {
    const none = setup({}, noTail)
    expect(await reason(none.write.withdraw(ONE))).toMatch(/this wallet has no MUSD deposit in the Stability Pool/)
    const more = setup({}, all(holds('10'), noTail))
    expect(await reason(more.write.withdraw({ amount: '11' }))).toMatch(/this wallet's deposit is 10 MUSD; withdraw at most that/)
    for (const c of [none, more]) beforeCore(c)
    await expect(more.write.withdraw({ amount: '0' })).rejects.toThrow(InputError)
  })

  it('when the pool is not blocked: withdraws, reads the position back at the receipt block, and the MUSD comes back', async () => {
    const c = setup({}, all(holds('10'), noTail))
    const r: Json = await c.write.withdraw(ONE)
    expect(r).toMatchObject({ sent: true, status: 'success', blockNumber: '16500000' })
    expect(call(c, 0)).toMatchObject({ to: SP, value: 0n })
    expect(decodeFunctionData({ abi: stabilityPoolAbi, data: call(c, 0).data })).toEqual({ functionName: 'withdrawFromSP', args: [e18(1)] })
    expect(r.spAfter).toMatchObject({ deposit: { musd: '9', initialMusd: '9' }, pool: { totalMusd: '85999999' }, withdraw: { blocked: false } })
    expect(poolRaw(r.spAfter.raw)).toEqual(await direct(c))
    expect(c.lines()).toMatchObject([{ name: 'sp_withdraw', to: SP, status: 'success', musd: e18(1).toString() }])
    expect(c.w.musd).toBe(e18('16.7'))
  })

  it('the write core still simulates what the tool allows: a revert there sends nothing', async () => {
    const c = setup({}, all(holds('10'), noTail, (x) => (x.w.simRevert = 'fake revert')))
    expect(await reason(c.write.withdraw(ONE))).toMatch(/the simulation reverted, so nothing was sent/)
    expect(c.rpc.methods()).not.toContain('eth_sendRawTransaction')
    expect(c.lines()).toEqual([])
  })
})

describe('trove_liquidate', () => {
  const TARGET = { borrower: troveAddr(5) }

  it('liquidates a trove under 110%: exact calldata, the two events decoded, the trove closed, the pool position read back', async () => {
    const c = setup({}, all(holds('10'), (x) => ((x.s.liqLoss = 200_000_000_000_000n), (x.s.liqGain = 3_000_000_000n))))
    const before = { musd: c.w.musd, btc: c.w.btc }
    const r: Json = await c.write.liquidate(TARGET)
    expect(r).toMatchObject({
      sent: true, status: 'success', blockNumber: '16500000', borrower: TAIL, icrBefore: '106.98', troveStatusAfter: 'closedByLiquidation',
      troveLiquidated: { debtMusd: '1900', collateralBtc: '0.0264' },
      liquidation: { principalMusd: '1900', interestMusd: '0', collateralBtc: '0.0264', collateralCompensationBtc: '0.000132', gasCompensationMusd: '200' },
    })
    expect(c.w.sent).toHaveLength(1)
    expect(call(c, 0)).toMatchObject({ to: ADDRESSES.troveManager, value: 0n })
    expect(decodeFunctionData({ abi: troveManagerAbi, data: call(c, 0).data })).toEqual({ functionName: 'liquidate', args: [TAIL] })
    // our deposit lost a little MUSD and gained a little BTC, the pool is no longer blocked, and all of it is what the pool reports at that block
    expect(r.spAfter).toMatchObject({
      deposit: { musd: '9.9998', initialMusd: '10', musdLoss: '0.0002', btcGain: '0.000000003' },
      pool: { totalMusd: '85998100', collateralBtc: '176.026268' },
      withdraw: { blocked: false, lowestIcr: '115.5', lowestTrove: NEXT },
    })
    expect(poolRaw(r.spAfter.raw)).toEqual(await direct(c))
    // the caller is paid: 200 MUSD and 0.5% of the collateral
    expect(c.w.musd - before.musd).toBe(e18(200))
    expect(c.w.btc - before.btc).toBe(e18('0.000132'))
    // a liquidation moves no funds of ours: the ledger counts 0 MUSD and gas only
    expect(c.lines()).toMatchObject([{ name: 'trove_liquidate', to: ADDRESSES.troveManager, status: 'success', musd: '0' }])
    expect(BigInt(c.lines()[0].btc)).toBeLessThan(e18('0.0001'))
  })

  it('refuses a trove at or above 110%, a trove that is not active, and a closed one, before the write core is reached', async () => {
    const above = setup()
    expect(await reason(above.write.liquidate({ borrower: troveAddr(4) }))).toMatch(new RegExp(`the trove of ${NEXT} is at 115\\.5% at block 16500000, not under the 110% minimum, so it cannot be liquidated`))
    const none = setup()
    expect(await reason(none.write.liquidate({ borrower: troveAddr(99) }))).toMatch(/has no active trove \(its status is nonExistent\)/)
    const closed = setup({}, (x) => void x.w.closed.set(troveAddr(9).toLowerCase(), 3))
    expect(await reason(closed.write.liquidate({ borrower: troveAddr(9) }))).toMatch(/has no active trove \(its status is closedByLiquidation\)/)
    for (const c of [above, none, closed]) beforeCore(c)
    await expect(above.write.liquidate({ borrower: 'nobody' })).rejects.toThrow(InputError)
  })

  it('is a risky action: refused unless the operator allows it, and the core still simulates it', async () => {
    const risky = setup({ MEZO_WRITE_RISKY: undefined })
    expect(await reason(risky.write.liquidate(TARGET))).toMatch(/trove_liquidate is a risky action, refused unless the operator sets MEZO_WRITE_RISKY=1/)
    unsent(risky)
    const sim = setup({}, (x) => (x.w.simRevert = 'nothing to liquidate'))
    expect(await reason(sim.write.liquidate(TARGET))).toMatch(/the simulation reverted, so nothing was sent/)
    expect(sim.rpc.methods()).not.toContain('eth_sendRawTransaction')
    expect(sim.lines()).toEqual([])
  })
})

describe('approve_revoke', () => {
  it('sets a MUSD allowance to zero: approve(spender, 0) on the token, the allowance read back as 0, no funds counted', async () => {
    const c = setup({}, approved('3', ADDRESSES.veBTC))
    const r: Json = await c.write.revoke({ token: 'MUSD', spender: ADDRESSES.veBTC })
    expect(r).toMatchObject({ sent: true, status: 'success', blockNumber: '16500000', token: 'MUSD', spender: ADDRESSES.veBTC, allowanceBefore: '3', allowance: '0' })
    expect(call(c, 0)).toMatchObject({ to: ADDRESSES.musd, value: 0n })
    expect(decodeFunctionData({ abi: erc20Abi, data: call(c, 0).data })).toEqual({ functionName: 'approve', args: [ADDRESSES.veBTC, 0n] })
    expect(c.lines()).toMatchObject([{ name: 'approve_revoke_musd', to: ADDRESSES.musd, status: 'success', musd: '0' }])
    expect(BigInt(c.lines()[0].btc)).toBeLessThan(e18('0.0001'))
  })

  it('works for BTC too, with the token in any case and an unlimited allowance', async () => {
    const c = setup({}, approved(2n ** 256n - 1n, ADDRESSES.permit2, 'btc'))
    const r: Json = await c.write.revoke({ token: ' btc ', spender: ADDRESSES.permit2 })
    expect(r).toMatchObject({ sent: true, status: 'success', token: 'BTC', allowance: '0' })
    expect(r.allowanceBefore).toBe(formatUnits(2n ** 256n - 1n, 18)) // an unlimited value is shown in full
    expect(call(c, 0).to).toBe(ADDRESSES.btc)
    expect(c.lines()).toMatchObject([{ name: 'approve_revoke_btc', to: ADDRESSES.btc, musd: '0' }])
    expect((await c.sp.allowances({ address: ME }) as Json).allowances).toEqual([])
  })

  it('refuses when nothing is approved; a bad token or spender is an input error with no chain read', async () => {
    const c = setup()
    expect(await reason(c.write.revoke({ token: 'MUSD', spender: SP }))).toMatch(/has no MUSD allowance from this wallet, so there is nothing to revoke/)
    beforeCore(c)
    const bad = setup()
    await expect(bad.write.revoke({ token: 'MEZO', spender: SP })).rejects.toThrow(/token must be BTC or MUSD/)
    await expect(bad.write.revoke({ token: 'MUSD', spender: 'nobody' })).rejects.toThrow(InputError)
    await expect(bad.write.revoke({ token: 'MUSD', spender: '0x0000000000000000000000000000000000000000' })).rejects.toThrow(/must not be the zero address/)
    expect(bad.rpc.calls).toEqual([])
  })

  it('a leftover allowance after a deposit is found by allowance_status and cleared by the revoke', async () => {
    const c = setup({ MEZO_WRITE_MAX_MUSD_PER_CALL: '60', MEZO_WRITE_MAX_MUSD_PER_DAY: '100' }, approved('50'))
    expect(await reason(c.write.deposit({ amount: '10' }))).toBe('sent')
    expect(((await c.sp.allowances({ address: ME })) as Json).allowances).toMatchObject([{ token: 'MUSD', spender: SP, amount: '40' }])
    const r: Json = await c.write.revoke({ token: 'MUSD', spender: SP })
    expect(r).toMatchObject({ sent: true, allowanceBefore: '40', allowance: '0' })
    expect(((await c.sp.allowances({ address: ME })) as Json).summary).toBe('no non-zero allowance found')
  })
})

describe('what a mined transaction reports, and a node that is behind', () => {
  const DEPOSIT = { amount: '10' }

  it('a read-back that fails after the send still reports the mined transaction', async () => {
    const c = setup({}, all(approved('10'), (x) => (x.w.onTx = () => x.w.failReads.add('getCompoundedMUSDDeposit'))))
    const r: Json = await c.write.deposit(DEPOSIT)
    expect(r).toMatchObject({ sent: true, status: 'success', readBack: expect.stringMatching(/mined, but reading the result back failed/) })
    expect(r.spAfter).toBeUndefined()
    expect(c.w.sent).toHaveLength(1)
    expect(c.lines()).toHaveLength(1)
  })

  it('asks again for the receipt and the block, then reads the position back at that block', async () => {
    const c = setup({}, all(approved('10'), (x) => (x.w.onTx = () => void Object.assign(x.w.lag, { receipts: 2, blocks: 2, calls: 2 }))), { patienceMs: 5_000, retryMs: 1 })
    const r: Json = await c.write.deposit(DEPOSIT)
    expect(r).toMatchObject({ sent: true, status: 'success', blockNumber: '16500000', spAfter: { blockNumber: 16_500_000, deposit: { musd: '10' } } })
    expect(c.w.lag).toEqual({ receipts: 0, blocks: 0, calls: 0 }) // every answer from the lagging node was met with another ask
  })

  it('a receipt that does not arrive in time is said so; the state from before the send is not shown as the result', async () => {
    const c = setup({}, all(approved('10'), (x) => (x.w.onTx = () => void Object.assign(x.w.lag, { receipts: 1_000 }))), { patienceMs: 20, retryMs: 5 })
    const r: Json = await c.write.deposit(DEPOSIT)
    expect(r).toMatchObject({ sent: true, status: 'success', blockNumber: null, gasUsed: null, readBack: expect.stringMatching(/did not return its receipt in time.*sp_status or allowance_status/) })
    expect(r).not.toHaveProperty('spAfter')
    expect(c.w.sent).toHaveLength(1)
  })

  it('a reverted receipt is status reverted, with no read-back and the spend still recorded', async () => {
    const c = setup({}, all(approved('10'), (x) => (x.w.txStatus = '0x0')))
    const r: Json = await c.write.deposit(DEPOSIT)
    expect(r).toMatchObject({ sent: true, status: 'reverted' })
    expect(r.spAfter).toBeUndefined()
    expect(c.lines()).toMatchObject([{ name: 'sp_deposit', status: 'reverted', musd: e18(10).toString() }])
  })

  it('a receipt that never arrives is status unknown with no block, and the hash to look up', async () => {
    const c = setup({}, all(approved('10'), (x) => (x.w.silent = true)))
    const r = await c.write.deposit(DEPOSIT)
    expect(r).toMatchObject({ sent: true, status: 'unknown', blockNumber: null, gasUsed: null, hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) })
    expect(c.lines()).toMatchObject([{ name: 'sp_deposit', status: 'unknown' }])
  })
})

describe('the real run, rehearsed on the fake chain: approve, deposit, a blocked withdrawal, one liquidation, the withdrawal', () => {
  it('works under the caps of the real run, and the day cap leaves no room for more MUSD', async () => {
    const c = setup({ MEZO_WRITE_MAX_MUSD_PER_CALL: '10.5', MEZO_WRITE_MAX_MUSD_PER_DAY: '21', MEZO_WRITE_MAX_BTC_PER_CALL: '0.001', MEZO_WRITE_MAX_BTC_PER_DAY: '0.002' }, (x) => ((x.s.liqLoss = 200_000_000_000_000n), (x.s.liqGain = 3_000_000_000n)))
    expect(await c.write.approveMusd({ amount: '10' })).toMatchObject({ sent: true, status: 'success', allowance: '10' })
    const dep: Json = await c.write.deposit({ amount: '10' })
    expect(dep).toMatchObject({ sent: true, status: 'success', spAfter: { deposit: { musd: '10' }, withdraw: { blocked: true } } })
    expect(c.s.allowances.get(`musd:${SP.toLowerCase()}`)).toBe(0n) // the deposit used the whole approval, so there is nothing left to revoke
    expect(await reason(c.write.withdraw({ amount: '1' }))).toMatch(/refuses every non-zero withdrawal/)
    expect(c.w.sent).toHaveLength(2) // the refusal sent nothing
    const liq: Json = await c.write.liquidate({ borrower: troveAddr(5) })
    expect(liq).toMatchObject({ sent: true, status: 'success', icrBefore: '106.98', spAfter: { deposit: { musdLoss: '0.0002' }, withdraw: { blocked: false } } })
    expect(await c.write.withdraw({ amount: '1' })).toMatchObject({ sent: true, status: 'success', spAfter: { deposit: { musd: '8.9998' } } })
    expect(c.lines().map((l) => l.name)).toEqual(['sp_approve_musd', 'sp_deposit', 'trove_liquidate', 'sp_withdraw'])
    expect(c.w.sent.map((t) => t.to)).toEqual([ADDRESSES.musd, SP, ADDRESSES.troveManager, SP])
    expect(c.lines().reduce((sum, l) => sum + BigInt(l.musd), 0n)).toBe(e18(21))
    expect(c.lines().reduce((sum, l) => sum + BigInt(l.btc), 0n)).toBeLessThan(e18('0.002')) // gas only
    // 21 MUSD is the day cap: not one more
    expect(await reason(c.write.approveMusd({ amount: '1' }))).toMatch(/would pass the per-day cap of 21 MUSD/)
    expect(c.w.sent).toHaveLength(4)
  })
})
