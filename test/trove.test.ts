// The trove planner (src/plan.ts) and the three trove writers (src/trove-actions.ts) against a fake trove system (test/helpers/trove.ts).
// No network and no real transaction: the key is a throwaway generated here. A refused plan must stop before the write core simulates, estimates or sends.
// The hints and the redemption position are checked against an oracle (helpers/trove.ts) that re-sorts a plain array and shares no code with plan.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFunctionData, formatUnits, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterAll, describe, expect, it } from 'vitest'
import { borrowerOperationsAbi, priceFeedAbi, sortedTrovesAbi, troveManagerAbi } from '../src/abis.ts'
import { ADDRESSES } from '../src/config.ts'
import { InputError } from '../src/inputs.ts'
import { createPlanner, type Plan, type PlanOk, type PlanRefused, type Planner } from '../src/plan.ts'
import { createTrove } from '../src/trove-actions.ts'
import type { Outcome, VeOptions } from '../src/ve-actions.ts'
import { createWriter } from '../src/write.ts'
import { e18, oracle, troveWorld, type World } from './helpers/trove.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const root = mkdtempSync(join(tmpdir(), 'mezo-trove-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const key = generatePrivateKey()
const keyFile = join(root, 'throwaway.key')
writeFileSync(keyFile, key, { mode: 0o600 })
const ME = privateKeyToAccount(key).address
const NOW = new Date('2026-10-31T12:00:00Z')
const noop = () => {}

/** The wallet's own trove, put into the fake list (its borrow cap is what BorrowerOperations stored when it was opened: collateral value / 1.10). */
const mine = (coll: string, principal: string, interest = '0') => (w: World) => void w.troves.push({ owner: ME, coll: e18(coll), principal: e18(principal), interest: e18(interest), capacity: (e18(coll) * w.price) / w.mcr })
const recovery = (w: World) => void (w.ccr = e18('2.5')) // the system ratio is 240.3%: under a 250% line it is in Recovery Mode
const all = (...f: ((w: World) => void)[]) => (w: World) => f.forEach((g) => g(w))

function chain(tweak: (w: World) => void = noop) {
  const world = troveWorld(ME)
  tweak(world.w)
  const rpc = world.rpc()
  return { world, w: world.w, rpc, lens: world.lens, planner: createPlanner(rpc.client, world.lens) }
}
const ok = (p: Plan): PlanOk => {
  if (p.refused) throw new Error(`the plan was refused: ${p.reason}`)
  return p
}
const no = (p: Plan): PlanRefused => {
  if (!p.refused) throw new Error('the plan was not refused')
  return p
}
const lc = (a: string) => a.toLowerCase()
const OPEN = { address: ME, collateralBtc: '0.045', debtMusd: '1900' }

/** The hints the plan carries are the oracle's neighbours, are the last two arguments of its calldata, and the redemption position is the oracle's prefix sum. */
function spot(p: PlanOk, o: ReturnType<typeof oracle>) {
  expect([lc(p.hints.upper), lc(p.hints.lower), p.hints.nicr]).toEqual([o.upper, o.lower, String(o.nicr)])
  expect(p.redemptionPosition).toMatchObject({ trovesAhead: o.trovesAhead, skippedBelowMcr: o.skippedBelowMcr, musdAhead: formatUnits(o.debtAhead, 18), walkComplete: true })
  const d = decodeFunctionData({ abi: borrowerOperationsAbi, data: p.data })
  expect((d.args as readonly unknown[]).slice(-2)).toEqual([p.hints.upper, p.hints.lower])
}

describe('plan_open', () => {
  it('the real run: 0.045 BTC against 1,900 MUSD is a 164.85% trove, with the exact calldata, a hinted spot and no warning', async () => {
    const { planner, world, rpc } = chain()
    const p = ok(await planner.open(OPEN))
    expect(p).toMatchObject({
      action: 'open', borrower: ME, to: ADDRESSES.borrowerOperations, value: '45000000000000000', gas: '300000', blockNumber: 16_500_000, chainId: 31611,
      feeMusd: '1.9', icrBefore: null, icrAfter: '164.85', tcr: '240.3', tcrAfter: '232.83', recoveryMode: false, maxBorrowingCapacity: '3150', warnings: [],
      trove: { before: null, after: { collateralBtc: '0.045', principalMusd: '2101.9', interestMusd: '0', debtMusd: '2101.9', netDebtMusd: '1901.9' } },
      mcrDistance: { marginPoints: '54.85', priceDropToLiquidationPercent: '33.27', liquidationPriceUsd: '51379.77' },
      redemptionPosition: { musdAhead: '6310', trovesAhead: 3, skippedBelowMcr: 1, walkComplete: true, redemptionsOpen: true },
      raw: { debt: e18(1900).toString(), fee: e18('1.9').toString(), netDebt: e18('1901.9').toString(), compositeDebt: e18('2101.9').toString(), minNetDebt: e18(1800).toString() },
    })
    expect(p.redemptionPosition!.basis).toMatch(/lowest-ratio trove first.*minus the 200 MUSD gas reserve.*Counted for the spot after this change/)
    expect(p.summary).toMatch(/deposit 0\.045 BTC and receive 1900 MUSD \(fee 1\.9 MUSD; 200 MUSD more.*debt is 2101\.9 MUSD.*Ratio after: 164\.85%/)
    expect(decodeFunctionData({ abi: borrowerOperationsAbi, data: p.data })).toEqual({ functionName: 'openTrove', args: [e18(1900), p.hints.upper, p.hints.lower] })
    spot(p, oracle(world, { coll: e18('0.045'), principal: e18('2101.9'), interest: 0n }))
    // every read is pinned to the one block the plan names
    expect(new Set(rpc.calls.filter((c) => c.method === 'eth_call').map((c) => c.params[1]))).toEqual(new Set([toHex(16_500_000n)]))
  })

  it('reads at the block it is given and names it', async () => {
    const { planner, rpc } = chain()
    const p = ok(await planner.open(OPEN, { blockNumber: 16_499_990n }))
    expect(p.blockNumber).toBe(16_499_990)
    expect(new Set(rpc.calls.filter((c) => c.method === 'eth_call').map((c) => c.params[1]))).toEqual(new Set([toHex(16_499_990n)]))
    expect(rpc.methods()).not.toContain('eth_blockNumber')
  })

  it('refuses a trove that is already open and points at the other tools', async () => {
    const { planner } = chain(mine('0.045', '2101.9'))
    const r = no(await planner.open(OPEN))
    expect(r.reason).toMatch(/already has an open trove \(ratio 164\.85%\); use plan_top_up or plan_repay/)
    expect(r).toMatchObject({ action: 'open', icrBefore: '164.85', maxBorrowingCapacity: '3150' })
    expect(r).not.toHaveProperty('data')
  })

  it('refuses a net debt under the minimum, names the fee and a suggestion that passes; the minimum itself passes, one wei less does not', async () => {
    const { planner } = chain()
    const r = no(await planner.open({ ...OPEN, debtMusd: '1500' }))
    expect(r.reason).toMatch(/the net debt would be 1501\.5 MUSD \(1500 requested \+ 1\.5 fee\), under the 1800 MUSD minimum; ask for at least 1798\.201799 MUSD/)
    expect(ok(await planner.open({ ...OPEN, debtMusd: '1798.201799' })).trove.after.netDebtMusd).toBe('1800')
    // net debt 1800 exactly: 1798.201798201798201799 + the 0.1% fee (1.798201798201798201, rounded down) = 1800 to the wei
    expect(ok(await planner.open({ ...OPEN, debtMusd: '1798.201798201798201799' })).trove.after.principalMusd).toBe('2000')
    expect(no(await planner.open({ ...OPEN, debtMusd: '1798.201798201798201798' })).reason).toMatch(/under the 1800 MUSD minimum/)
  })

  it('refuses a ratio under 110% and names the borrow cap of that collateral', async () => {
    const { planner } = chain()
    const r = no(await planner.open({ ...OPEN, collateralBtc: '0.03', debtMusd: '2000' }))
    expect(r.reason).toMatch(/the trove would have a ratio of 104\.9%, under the 110% minimum; this collateral carries at most 2100 MUSD of total debt \(about 1900 MUSD borrowed after the 200 MUSD gas reserve, before the fee\)/)
    expect(r).toMatchObject({ icrAfter: '104.9', maxBorrowingCapacity: '2100' })
  })

  it('exactly 110% passes and a wei less of collateral is refused', async () => {
    // BTC at $100,000, no fee: 0.0231 BTC = $2,310 against 2,100 MUSD of debt is exactly 1.10
    const tweak = (w: World) => ((w.price = e18(100_000)), w.exempt.add(ME.toLowerCase()))
    expect(ok(await chain(tweak).planner.open({ ...OPEN, collateralBtc: '0.0231' })).icrAfter).toBe('110')
    expect(no(await chain(tweak).planner.open({ ...OPEN, collateralBtc: '0.023099999999999999' })).reason).toMatch(/under the 110% minimum/)
  })

  it('refuses a trove that would push the system under 150%, outside Recovery Mode', async () => {
    const { planner } = chain((w) => (w.ccr = e18('2.4')))
    const r = no(await planner.open(OPEN))
    expect(r.reason).toMatch(/the change would push the system ratio from 240\.3% to 232\.83%, under the 240% line \(the system would fall into Recovery Mode\)/)
    expect(r.recoveryMode).toBe(false)
  })

  it('in Recovery Mode a new trove needs 150%, pays no fee, and the plan says so', async () => {
    const r = no(await chain(recovery).planner.open(OPEN))
    expect(r.reason).toMatch(/the system is in Recovery Mode \(system ratio 240\.3% is under 250%\), where a new trove needs a ratio of at least 250%; this one would have 165%/)
    expect(r.recoveryMode).toBe(true)
    const p = ok(await chain(all(recovery, (w) => (w.btc = e18(1)))).planner.open({ ...OPEN, collateralBtc: '0.1' }))
    expect(p).toMatchObject({ recoveryMode: true, feeMusd: '0', icrAfter: '366.66', trove: { after: { debtMusd: '2100', netDebtMusd: '1900' } } })
    expect(p.warnings).toEqual([expect.stringMatching(/the system is in Recovery Mode \(system ratio 240\.3% is under 250%\)/)])
  })

  it('a fee-exempt account pays no fee, and the plan says why', async () => {
    const p = ok(await chain((w) => w.exempt.add(ME.toLowerCase())).planner.open(OPEN))
    expect(p).toMatchObject({ feeMusd: '0', trove: { after: { debtMusd: '2100' } }, warnings: ['this account is exempt from the borrowing fee'] })
  })

  it('refuses when the wallet holds less BTC than the collateral', async () => {
    const r = no(await chain((w) => (w.btc = e18('0.01'))).planner.open(OPEN))
    expect(r.reason).toMatch(/the wallet holds 0\.01 BTC, less than the 0\.045 BTC collateral/)
  })

  it('warns when the margin is thin: under 150% for the trove, under 160% for the system, first in line for a redemption', async () => {
    // BTC at $50,000: the system sits at 156.04%, and 0.05 BTC against 1,900 MUSD is a 118.94% trove that drags it to 152.36%
    const p = ok(await chain((w) => ((w.price = e18(50_000)), (w.btc = e18(1)))).planner.open({ ...OPEN, collateralBtc: '0.05' }))
    expect(p).toMatchObject({ refused: false, icrAfter: '118.94', tcr: '156.04', tcrAfter: '152.36' })
    expect(p.warnings).toEqual([
      expect.stringMatching(/the ratio after this is 118\.94%, under 150%: if the system falls into Recovery Mode this trove can be liquidated/),
      expect.stringMatching(/the system ratio after this is 152\.36%, close to the 150% Recovery Mode line/),
      expect.stringMatching(/no redeemable trove is ahead of this one: it is first in line/),
    ])
  })

  it('bad inputs are input errors and cost no chain read', async () => {
    const { planner, rpc } = chain()
    for (const bad of ['0', '-1', '1e18', 'abc', '', '0.0000000000000000001']) {
      await expect(planner.open({ ...OPEN, collateralBtc: bad }), bad).rejects.toThrow(InputError)
      await expect(planner.open({ ...OPEN, debtMusd: bad }), bad).rejects.toThrow(InputError)
    }
    await expect(planner.open({ ...OPEN, address: '0x123' })).rejects.toThrow(InputError)
    expect(rpc.calls).toEqual([])
  })

  it('a gas estimate that fails, or a client that cannot estimate, leaves gas null and says so; the plan itself still stands', async () => {
    const failing = ok(await chain((w) => (w.estimateFails = true)).planner.open(OPEN))
    expect(failing.gas).toBeNull()
    expect(failing.warnings).toEqual([expect.stringMatching(/the gas estimate failed .*do not send it until you know why/)])
    const { rpc, lens } = chain()
    const c = rpc.client
    const bare = createPlanner({ getBlockNumber: () => c.getBlockNumber(), getBlock: (a) => c.getBlock(a), readContract: (a) => c.readContract(a) }, lens)
    const p = ok(await bare.open(OPEN))
    expect(p.gas).toBeNull()
    expect(p.warnings).toEqual(['this client cannot simulate, so there is no gas estimate'])
  })

  it('a redemption position that cannot be read, or that the walk cut short, is a warning and never a failure', async () => {
    const down = ok(await chain((w) => (w.lensFails = true)).planner.open(OPEN))
    expect(down.redemptionPosition).toBeNull()
    expect(down.warnings).toEqual([expect.stringMatching(/the redemption position could not be read \(the fake lens is down\); the rest of the plan is unaffected/)])
    const cut = ok(await chain((w) => (w.walkComplete = false)).planner.open(OPEN))
    expect(cut.redemptionPosition).toMatchObject({ walkComplete: false })
    expect(cut.warnings).toEqual(['the redemption walk hit its step cap, so the position is a lower bound'])
  })

  it('a chain read that fails is an error, not a half-made plan', async () => {
    await expect(chain((w) => w.failReads.add('getEntireSystemDebt')).planner.open(OPEN)).rejects.toThrow()
  })
})

describe('plan_top_up', () => {
  it('the real run: adding 0.0003 BTC to the 164.85% trove (the cap stays what it was)', async () => {
    const { planner, world } = chain(mine('0.045', '2101.9'))
    const p = ok(await planner.topUp({ address: ME, amountBtc: '0.0003' }))
    expect(p).toMatchObject({
      action: 'top_up', to: ADDRESSES.borrowerOperations, value: '300000000000000', icrBefore: '164.85', icrAfter: '165.94', tcr: '232.83', tcrAfter: '232.93', recoveryMode: false,
      maxBorrowingCapacity: '3150', warnings: [],
      trove: { before: { collateralBtc: '0.045', debtMusd: '2101.9' }, after: { collateralBtc: '0.0453', principalMusd: '2101.9', debtMusd: '2101.9', netDebtMusd: '1901.9' } },
      mcrDistance: { marginPoints: '55.94', priceDropToLiquidationPercent: '33.71', liquidationPriceUsd: '51039.51' },
      redemptionPosition: { musdAhead: '6310', trovesAhead: 3, skippedBelowMcr: 1 },
    })
    expect(p).not.toHaveProperty('feeMusd')
    expect(p.summary).toMatch(/collateral 0\.045 -> 0\.0453 BTC, ratio 164\.85% -> 165\.94%\. The borrow cap stays 3150 MUSD and only limits borrowing more/)
    expect(decodeFunctionData({ abi: borrowerOperationsAbi, data: p.data })).toEqual({ functionName: 'addColl', args: [p.hints.upper, p.hints.lower] })
    spot(p, oracle(world, { coll: e18('0.0453'), principal: e18('2101.9'), interest: 0n }))
  })

  it('refuses a wallet with no trove, and says what became of a closed one', async () => {
    expect(no(await chain().planner.topUp({ address: ME, amountBtc: '0.0003' })).reason).toMatch(/has no open trove to add collateral to \(status: nonExistent\)/)
    expect(no(await chain((w) => w.closed.set(ME.toLowerCase(), 2)).planner.topUp({ address: ME, amountBtc: '0.0003' })).reason).toMatch(/\(status: closedByOwner\)/)
  })

  it('outside Recovery Mode even a pure top-up must reach 110%; the suggested amount does', async () => {
    const { planner } = chain(mine('0.04', '3000')) // 102.66% now
    const r = no(await planner.topUp({ address: ME, amountBtc: '0.0001' }))
    expect(r.reason).toMatch(/the trove would have a ratio of 102\.92%, under the 110% minimum \(outside Recovery Mode even a pure top-up must leave the trove at 110% or more; adding at least 0\.00285715 BTC would\)/)
    expect(r).toMatchObject({ icrBefore: '102.66', icrAfter: '102.92', maxBorrowingCapacity: '2800' })
    expect(ok(await planner.topUp({ address: ME, amountBtc: '0.00285715' })).icrAfter).toBe('110')
    expect(no(await planner.topUp({ address: ME, amountBtc: '0.00285713' })).reason).toMatch(/under the 110% minimum/)
  })

  it('in Recovery Mode a top-up is allowed as it is, with warnings about the trove', async () => {
    const p = ok(await chain(all(mine('0.04', '3000'), recovery)).planner.topUp({ address: ME, amountBtc: '0.0001' }))
    expect(p).toMatchObject({ recoveryMode: true, icrBefore: '102.66', icrAfter: '102.92' })
    expect(p.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/the trove is below the 110% minimum now \(102\.66%\): it can be liquidated until this is mined/), expect.stringMatching(/the system is in Recovery Mode/)]))
  })

  it('refuses when the wallet holds less BTC than it adds', async () => {
    const r = no(await chain(all(mine('0.045', '2101.9'), (w) => (w.btc = e18('0.0001')))).planner.topUp({ address: ME, amountBtc: '0.0003' }))
    expect(r.reason).toMatch(/the wallet holds 0\.0001 BTC, less than the 0\.0003 BTC to add/)
  })

  it('bad inputs are input errors and cost no chain read', async () => {
    const { planner, rpc } = chain()
    for (const bad of ['0', '-1', 'x', '']) await expect(planner.topUp({ address: ME, amountBtc: bad }), bad).rejects.toThrow(InputError)
    expect(rpc.calls).toEqual([])
  })
})

describe('plan_repay', () => {
  it('the real run: repaying 10 MUSD of the 2,101.9 MUSD debt (net debt stays above 1,800)', async () => {
    const { planner } = chain(mine('0.045', '2101.9'))
    const p = ok(await planner.repay({ address: ME, amountMusd: '10' }))
    expect(p).toMatchObject({
      action: 'repay', to: ADDRESSES.borrowerOperations, value: '0', icrBefore: '164.85', icrAfter: '165.63', tcrAfter: '232.94', maxBorrowingCapacity: '3150', warnings: [],
      trove: { before: { debtMusd: '2101.9' }, after: { principalMusd: '2091.9', interestMusd: '0', debtMusd: '2091.9', netDebtMusd: '1891.9' } },
      mcrDistance: { marginPoints: '55.63', priceDropToLiquidationPercent: '33.59', liquidationPriceUsd: '51135.33' },
      redemptionPosition: { musdAhead: '6310', trovesAhead: 3 },
    })
    expect(p.summary).toMatch(/debt 2101\.9 -> 2091\.9 MUSD \(net debt 1891\.9, minimum 1800\), ratio 164\.85% -> 165\.63%\. Interest is paid first \(0 MUSD of it\)/)
    expect(decodeFunctionData({ abi: borrowerOperationsAbi, data: p.data })).toEqual({ functionName: 'repayMUSD', args: [e18(10), p.hints.upper, p.hints.lower] })
  })

  it('refuses a wallet with no trove', async () => {
    expect(no(await chain().planner.repay({ address: ME, amountMusd: '10' })).reason).toMatch(/has no open trove to repay \(status: nonExistent\)/)
  })

  it('refuses more than the debt above the 200 MUSD gas reserve', async () => {
    const r = no(await chain(mine('0.045', '2101.9')).planner.repay({ address: ME, amountMusd: '1902' }))
    expect(r.reason).toMatch(/1902 MUSD is more than the trove can repay: its debt is 2101\.9 MUSD and the 200 MUSD gas reserve stays, so at most 1901\.9 MUSD/)
  })

  it('refuses a repayment that takes the net debt under the minimum and says how much it may repay; that amount passes', async () => {
    const { planner } = chain(all(mine('0.045', '2101.9'), (w) => (w.musd = e18(500))))
    const r = no(await planner.repay({ address: ME, amountMusd: '102' }))
    expect(r.reason).toMatch(/the net debt would fall to 1799\.9 MUSD, under the 1800 MUSD minimum; repay at most 101\.9 MUSD/)
    expect(ok(await planner.repay({ address: ME, amountMusd: '101.9' })).trove.after).toMatchObject({ debtMusd: '2000', netDebtMusd: '1800' })
  })

  it('a trove under 110% must repay enough to reach it; the suggested amount does', async () => {
    const { planner } = chain(all(mine('0.04', '3000'), (w) => (w.musd = e18(500))))
    const r = no(await planner.repay({ address: ME, amountMusd: '10' }))
    expect(r.reason).toMatch(/the trove would have a ratio of 103\.01%, under the 110% minimum; repaying at least 200 MUSD would reach 110%/)
    expect(ok(await planner.repay({ address: ME, amountMusd: '200' })).icrAfter).toBe('110')
  })

  it('in Recovery Mode a repayment is allowed as it is', async () => {
    const p = ok(await chain(all(mine('0.04', '3000'), recovery)).planner.repay({ address: ME, amountMusd: '10' }))
    expect(p).toMatchObject({ recoveryMode: true, icrBefore: '102.66', icrAfter: '103.01' })
  })

  it('refuses when the wallet holds less MUSD than it repays', async () => {
    const r = no(await chain(all(mine('0.045', '2101.9'), (w) => (w.musd = e18(5)))).planner.repay({ address: ME, amountMusd: '10' }))
    expect(r.reason).toMatch(/the wallet holds 5 MUSD, less than the 10 MUSD to repay/)
  })

  it('pays the interest first: a repayment of interest alone leaves the principal, and so the spot, as it is', async () => {
    const { planner } = chain(mine('0.045', '2101.9', '5'))
    const p = ok(await planner.repay({ address: ME, amountMusd: '3' }))
    expect(p.trove.after).toMatchObject({ principalMusd: '2101.9', interestMusd: '2', debtMusd: '2103.9' })
    expect(p.icrAfter).toBe('164.69')
    expect(p.redemptionPosition!.basis).toMatch(/current spot: the change does not move it/)
    const more = ok(await planner.repay({ address: ME, amountMusd: '10' }))
    expect(more.trove.after).toMatchObject({ principalMusd: '2096.9', interestMusd: '0' })
    expect(p.summary).toMatch(/Interest is paid first \(3 MUSD of it\)/)
  })
})

describe('hints and redemption position: the plan against a brute-force sort of the list', () => {
  const A = (coll: string, principal: string, interest = '0') => ({ coll: e18(coll), principal: e18(principal), interest: e18(interest) })
  const cases: [string, (w: World) => void, (p: Planner) => Promise<Plan>, ReturnType<typeof A>][] = [
    ['open in the middle of the list', noop, (p) => p.open(OPEN), A('0.045', '2101.9')],
    ['open above every trove: the new head', (w) => (w.btc = e18(2)), (p) => p.open({ ...OPEN, collateralBtc: '1' }), A('1', '2101.9')],
    // T5 (the trove under 110%) leaves, so the lowest ratio left is 115.5%, and 111% is below it
    ['open below every trove: the new tail', (w) => void w.troves.splice(4, 1), (p) => p.open({ ...OPEN, collateralBtc: '0.0303' }), A('0.0303', '2101.9')],
    ['open into an empty list', (w) => (w.troves = []), (p) => p.open(OPEN), A('0.045', '2101.9')],
    ['top-up that keeps the spot (the old node is the lower neighbour)', mine('0.045', '2101.9'), (p) => p.topUp({ address: ME, amountBtc: '0.0003' }), A('0.0453', '2101.9')],
    ['top-up that climbs past a trove', mine('0.045', '2101.9'), (p) => p.topUp({ address: ME, amountBtc: '0.03' }), A('0.075', '2101.9')],
    ['top-up of the head', mine('1', '2101.9'), (p) => p.topUp({ address: ME, amountBtc: '0.001' }), A('1.001', '2101.9')],
    ['top-up of the tail', all((w) => void w.troves.splice(4, 1), mine('0.0298', '2000')), (p) => p.topUp({ address: ME, amountBtc: '0.0001' }), A('0.0299', '2000')],
    ['top-up of a trove under 110% (Recovery Mode): its old node counted for nothing', all(mine('0.04', '3000'), recovery), (p) => p.topUp({ address: ME, amountBtc: '0.0001' }), A('0.0401', '3000')],
    ['repay that keeps the spot', mine('0.045', '2101.9'), (p) => p.repay({ address: ME, amountMusd: '10' }), A('0.045', '2091.9')],
    ['repay that climbs past a trove', all(mine('0.1', '3300'), (w) => (w.musd = e18(5000))), (p) => p.repay({ address: ME, amountMusd: '400' }), A('0.1', '2900')],
    ['repay of interest only: the ratio does not move', mine('0.045', '2101.9', '5'), (p) => p.repay({ address: ME, amountMusd: '3' }), A('0.045', '2101.9', '2')],
    ['repay of interest and some principal', mine('0.045', '2101.9', '5'), (p) => p.repay({ address: ME, amountMusd: '10' }), A('0.045', '2096.9')],
  ]
  for (const [name, tweak, run, after] of cases) {
    it(name, async () => {
      const c = chain(tweak)
      spot(ok(await run(c.planner)), oracle(c.world, after))
    })
  }

  it('the head has nothing ahead when it is the only trove; the tail has nothing ahead and the plan says it is first in line', async () => {
    const tail = chain(all((w) => void w.troves.splice(4, 1), mine('0.0298', '2000')))
    const p = ok(await tail.planner.topUp({ address: ME, amountBtc: '0.0001' }))
    expect(p.redemptionPosition).toMatchObject({ musdAhead: '0', trovesAhead: 0, skippedBelowMcr: 0 })
    expect(p.warnings).toEqual([expect.stringMatching(/the ratio after this is 115\.11%, under 150%/), 'no redeemable trove is ahead of this one: it is first in line for a redemption'])
    const alone = ok(await chain((w) => (w.troves = [])).planner.open(OPEN))
    expect(alone.hints).toMatchObject({ approxHint: '0x0000000000000000000000000000000000000000' })
    expect(alone.redemptionPosition).toMatchObject({ musdAhead: '0', trovesAhead: 0, walkComplete: true })
    expect(alone.redemptionPosition!.basis).toMatch(/The list is empty, so nothing is ahead/)
  })
})

describe('trove_status', () => {
  it('shows the trove, its distance from liquidation, its cap and its place in the redemption queue', async () => {
    const { planner } = chain(mine('0.045', '2101.9'))
    const s = await planner.status({ address: ME })
    expect(s).toMatchObject({
      borrower: ME, status: 'active', active: true, icr: '164.85', liquidatable: false, btcPriceUsd: '77000', tcr: '232.83', recoveryMode: false, maxBorrowingCapacity: '3150', warnings: [],
      trove: { collateralBtc: '0.045', principalMusd: '2101.9', interestMusd: '0', debtMusd: '2101.9', netDebtMusd: '1901.9' },
      mcrDistance: { marginPoints: '54.85', priceDropToLiquidationPercent: '33.27', liquidationPriceUsd: '51379.77' },
      redemptionPosition: { musdAhead: '6310', trovesAhead: 3, skippedBelowMcr: 1, walkComplete: true },
    })
    expect(s.summary).toMatch(/0\.045 BTC against 2101\.9 MUSD of debt, ratio 164\.85%.*6310 MUSD of redeemable debt is ahead of it/)
  })

  it('equals the TroveManager\'s own answers (Troves, getCurrentICR) at the same block', async () => {
    const { planner, rpc, w } = chain(mine('0.045', '2101.9', '5'))
    const s = await planner.status({ address: ME }, { blockNumber: w.block })
    const read = (address: `0x${string}`, abi: never, functionName: string, args: unknown[] = []) => rpc.client.readContract({ address, abi, functionName, args, blockNumber: w.block } as never) as Promise<Json>
    const price = await read(ADDRESSES.priceFeed, priceFeedAbi as never, 'fetchPrice')
    const t = await read(ADDRESSES.troveManager, troveManagerAbi as never, 'Troves', [ME])
    const icr = await read(ADDRESSES.troveManager, troveManagerAbi as never, 'getCurrentICR', [ME, price])
    expect(s.raw).toMatchObject({ collateral: String(t[0]), principal: String(t[1]), interest: String(t[2]), maxBorrowingCapacity: String(t[7]), icr: String(icr), price: String(price) })
  })

  it('says what a wallet without an open trove is', async () => {
    expect(await chain().planner.status({ address: ME })).toMatchObject({ status: 'nonExistent', active: false, trove: null, icr: null, mcrDistance: null, liquidatable: null, maxBorrowingCapacity: null, redemptionPosition: null })
    expect(await chain((w) => w.closed.set(ME.toLowerCase(), 4)).planner.status({ address: ME })).toMatchObject({ status: 'closedByRedemption', active: false })
  })

  it('flags a trove under 110% as liquidatable', async () => {
    const s = await chain(mine('0.04', '3000')).planner.status({ address: ME })
    expect(s).toMatchObject({ icr: '102.66', liquidatable: true })
    expect(s.warnings).toEqual([expect.stringMatching(/under the 110% minimum ratio and can be liquidated/)])
  })

  it('a position that cannot be read, or that the walk cut short, is a warning; the rest is still shown', async () => {
    const down = await chain(all(mine('0.045', '2101.9'), (w) => (w.lensFails = true))).planner.status({ address: ME })
    expect(down).toMatchObject({ active: true, icr: '164.85', redemptionPosition: null })
    expect(down.warnings).toEqual([expect.stringMatching(/the redemption position could not be read \(the fake lens is down\)/)])
    const cut = await chain(all(mine('0.045', '2101.9'), (w) => (w.walkComplete = false))).planner.status({ address: ME })
    expect(cut.warnings).toEqual(['the redemption walk hit its step cap, so the position is a lower bound'])
  })

  it('a bad address is an input error and costs no chain read', async () => {
    const { planner, rpc } = chain()
    await expect(planner.status({ address: 'nobody' })).rejects.toThrow(InputError)
    expect(rpc.calls).toEqual([])
  })
})

// ---- the writers -----------------------------------------------------------------------------------------------------------------------------

/** Caps just above the real run: 1,900 MUSD and 0.045 BTC, then 0.0003 BTC and 10 MUSD. */
const CAPS = { MEZO_WRITE_MAX_MUSD_PER_CALL: '2000', MEZO_WRITE_MAX_MUSD_PER_DAY: '4000', MEZO_WRITE_MAX_BTC_PER_CALL: '0.05', MEZO_WRITE_MAX_BTC_PER_DAY: '0.1', MEZO_WRITE_RISKY: '1' }

/** A fake chain, a writer on the SHIPPED allow-list (a fresh receipts ledger and kill file per case) and the tools on top. */
function setup(env: Record<string, string | undefined> = {}, tweak: (w: World) => void = noop, patience: VeOptions = { patienceMs: 0 }) {
  const world = troveWorld(ME)
  tweak(world.w)
  const rpc = world.rpc()
  const dir = mkdtempSync(join(root, 'case-'))
  const receipts = join(dir, 'receipts.jsonl')
  const writer = createWriter({ env: { MEZO_WRITE_ENABLE: 'testnet', MEZO_KEY_FILE: keyFile, MEZO_WRITE_RECEIPTS_FILE: receipts, ...CAPS, ...env }, client: rpc.client, now: () => NOW, receiptTimeoutMs: 200 })
  const trove = createTrove(rpc.client, world.lens, writer, patience)
  const lines = (): Json[] => (existsSync(receipts) ? readFileSync(receipts, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  return { w: world.w, rpc, dir, trove, write: trove.write!, lines }
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
/** The trove the way the TroveManager itself reports it at the receipt block. */
async function direct(c: Case) {
  const at = c.w.block
  const read = (address: `0x${string}`, abi: unknown, functionName: string, args: unknown[] = []) => c.rpc.client.readContract({ address, abi, functionName, args, blockNumber: at } as never) as Promise<Json>
  const price = await read(ADDRESSES.priceFeed, priceFeedAbi, 'fetchPrice')
  const t = await read(ADDRESSES.troveManager, troveManagerAbi, 'Troves', [ME])
  return { coll: String(t[0]), principal: String(t[1]), interest: String(t[2]), capacity: String(t[7]), icr: String(await read(ADDRESSES.troveManager, troveManagerAbi, 'getCurrentICR', [ME, price])) }
}
const fromRaw = (r: Json) => ({ coll: r.collateral, principal: r.principal, interest: r.interest, capacity: r.maxBorrowingCapacity, icr: r.icr })

describe('without a writer, or with writes off', () => {
  it('no writer: the planner alone, with no write part', () => {
    const { rpc, lens } = chain()
    const t = createTrove(rpc.client, lens)
    expect(t.write).toBeUndefined()
    expect(Object.keys(t).sort()).toEqual(['open', 'repay', 'status', 'topUp'])
  })

  it('writes off: every writer refuses with the writer\'s reason and reads nothing', async () => {
    const off = setup({ MEZO_WRITE_ENABLE: 'mainnet' })
    for (const r of [off.write.open({ collateralBtc: '0.045', debtMusd: '1900' }), off.write.addColl({ amountBtc: '0.0003' }), off.write.repay({ amountMusd: '10' })])
      expect(await reason(r)).toMatch(/writes are off \(the operator sets MEZO_WRITE_ENABLE=testnet/)
    expect(off.rpc.calls).toEqual([])
    const bad = setup({ MEZO_WRITE_RECEIPTS_FILE: undefined })
    const why = await reason(bad.write.repay({ amountMusd: '10' }))
    expect(why).toMatch(/no receipts file is configured/)
    expect(why).not.toContain(root)
    expect(bad.rpc.calls).toEqual([])
  })
})

describe('trove_open', () => {
  it('opens the trove from the plan: exact calldata and hints, the BTC as value, a ledger line, and the new trove read back at the receipt block', async () => {
    const c = setup()
    const r: Json = await c.write.open({ collateralBtc: ' 0.045 ', debtMusd: '1900' })
    expect(r).toMatchObject({ sent: true, status: 'success', blockNumber: '16500000', gasUsed: '250000' })
    expect(r.explorer).toMatch(/^https:\/\/explorer\.test\.mezo\.org\/tx\/0x[0-9a-f]{64}$/)
    expect(c.w.sent).toHaveLength(1)
    const tx = c.w.sent[0]!
    expect(tx).toMatchObject({ to: ADDRESSES.borrowerOperations, value: e18('0.045') })
    expect(decodeFunctionData({ abi: borrowerOperationsAbi, data: tx.data })).toEqual({ functionName: 'openTrove', args: [e18(1900), r.planned.hints.upper, r.planned.hints.lower] })
    expect(r.planned).toMatchObject({ action: 'open', planBlock: 16_500_000, icrBefore: null, icrAfter: '164.85', redemptionPosition: { musdAhead: '6310', trovesAhead: 3 } })
    expect(r.troveAfter).toMatchObject({
      blockNumber: 16_500_000, status: 'active', active: true, icr: '164.85', maxBorrowingCapacity: '3150', trove: { collateralBtc: '0.045', principalMusd: '2101.9', debtMusd: '2101.9', netDebtMusd: '1901.9' },
      redemptionPosition: { musdAhead: '6310', trovesAhead: 3 },
    })
    // the hints were the true neighbours of the new node, and what was read back is what the TroveManager reports
    const st = (functionName: string) => c.rpc.client.readContract({ address: ADDRESSES.sortedTroves, abi: sortedTrovesAbi, functionName, args: [ME] } as never)
    expect([await st('getPrev'), await st('getNext')]).toEqual([r.planned.hints.upper, r.planned.hints.lower])
    expect(fromRaw(r.troveAfter.raw)).toEqual(await direct(c))
    expect(c.lines()).toMatchObject([{ name: 'trove_open', from: ME, to: ADDRESSES.borrowerOperations, selector: '0x2f3a6d98', nonce: 7, status: 'success', musd: e18(1900).toString() }])
    expect(BigInt(c.lines()[0].btc)).toBeGreaterThan(e18('0.045')) // the collateral counts as BTC, plus the worst-case fee
    expect(BigInt(c.lines()[0].btc)).toBeLessThan(e18('0.0451'))
  })

  it('refuses on the plan\'s own reasons before the write core is reached', async () => {
    const cases: [Case, RegExp][] = [
      [setup(), /the net debt would be 1501\.5 MUSD/],
      [setup({}, mine('0.045', '2101.9')), /already has an open trove/],
      [setup({}, (w) => (w.btc = e18('0.01'))), /the wallet holds 0\.01 BTC, less than the 0\.045 BTC collateral/],
      [setup({}, recovery), /the system is in Recovery Mode/],
    ]
    expect(await reason(cases[0]![0].write.open({ collateralBtc: '0.045', debtMusd: '1500' }))).toMatch(cases[0]![1])
    for (const [c, why] of cases.slice(1)) expect(await reason(c.write.open({ collateralBtc: '0.045', debtMusd: '1900' }))).toMatch(why)
    for (const [c] of cases) beforeCore(c)
  })

  it('bad amounts are input errors and cost no chain read; a chain read that fails before the send is a refusal', async () => {
    const a = setup()
    for (const bad of ['0', '-1', '1e18', 'abc', '']) {
      await expect(a.write.open({ collateralBtc: bad, debtMusd: '1900' }), bad).rejects.toThrow(InputError)
      await expect(a.write.open({ collateralBtc: '0.045', debtMusd: bad }), bad).rejects.toThrow(InputError)
    }
    expect(a.rpc.calls).toEqual([])
    const b = setup({}, (w) => w.failReads.add('getEntireSystemDebt'))
    expect(await reason(b.write.open({ collateralBtc: '0.045', debtMusd: '1900' }))).toMatch(/a chain read failed before anything was sent/)
    beforeCore(b)
  })

  it('the write core still guards what the plan allows: the risky flag, the caps, the kill file and a reverting simulation', async () => {
    const OPEN_ARGS = { collateralBtc: '0.045', debtMusd: '1900' }
    const risky = setup({ MEZO_WRITE_RISKY: undefined })
    expect(await reason(risky.write.open(OPEN_ARGS))).toMatch(/trove_open is a risky action, refused unless the operator sets MEZO_WRITE_RISKY=1/)
    const musd = setup({ MEZO_WRITE_MAX_MUSD_PER_CALL: '1899' })
    expect(await reason(musd.write.open(OPEN_ARGS))).toMatch(/1900 MUSD is over the per-call cap of 1899 MUSD/)
    const btc = setup({ MEZO_WRITE_MAX_BTC_PER_CALL: '0.0449' })
    expect(await reason(btc.write.open(OPEN_ARGS))).toMatch(/BTC \(gas fee included\) is over the per-call cap of 0\.0449 BTC/)
    const killed = setup()
    writeFileSync(join(killed.dir, 'STOP'), '')
    expect(await reason(killed.write.open(OPEN_ARGS))).toMatch(/the kill file exists/)
    const sim = setup({}, (w) => (w.simRevert = 'ICR below MCR'))
    expect(await reason(sim.write.open(OPEN_ARGS))).toMatch(/the simulation reverted, so nothing was sent/)
    for (const c of [risky, musd, btc, killed]) unsent(c)
    // the simulation ran (that is how the revert was found), and nothing was sent or recorded after it
    expect(sim.rpc.calls.filter((x) => x.method === 'eth_call' && x.params[0]?.from)).toHaveLength(1)
    expect(sim.rpc.methods()).not.toContain('eth_sendRawTransaction')
    expect(sim.lines()).toEqual([])
  })
})

describe('trove_add_coll', () => {
  const ADD = { amountBtc: '0.0003' }
  it('adds the collateral from the plan and reads the trove back: more collateral, same debt, same cap', async () => {
    const c = setup({}, mine('0.045', '2101.9'))
    const r: Json = await c.write.addColl(ADD)
    expect(r).toMatchObject({ sent: true, status: 'success', blockNumber: '16500000', planned: { action: 'top_up', icrBefore: '164.85', icrAfter: '165.94' } })
    expect(c.w.sent[0]).toMatchObject({ to: ADDRESSES.borrowerOperations, value: e18('0.0003') })
    expect(decodeFunctionData({ abi: borrowerOperationsAbi, data: c.w.sent[0]!.data })).toEqual({ functionName: 'addColl', args: [r.planned.hints.upper, r.planned.hints.lower] })
    expect(r.troveAfter).toMatchObject({ icr: '165.94', maxBorrowingCapacity: '3150', trove: { collateralBtc: '0.0453', principalMusd: '2101.9', debtMusd: '2101.9' } })
    expect(fromRaw(r.troveAfter.raw)).toEqual(await direct(c))
    expect(c.lines()).toMatchObject([{ name: 'trove_add_coll', selector: '0x4a393149'.length ? expect.stringMatching(/^0x[0-9a-f]{8}$/) : '', status: 'success', musd: '0' }])
    expect(BigInt(c.lines()[0].btc)).toBeGreaterThan(e18('0.0003'))
  })

  it('refuses without a trove, below 110%, or with too little BTC; and the core\'s BTC cap still applies', async () => {
    const none = setup()
    expect(await reason(none.write.addColl(ADD))).toMatch(/has no open trove to add collateral to/)
    const thin = setup({}, mine('0.04', '3000'))
    expect(await reason(thin.write.addColl({ amountBtc: '0.0001' }))).toMatch(/under the 110% minimum.*adding at least 0\.00285715 BTC would/)
    const poor = setup({}, all(mine('0.045', '2101.9'), (w) => (w.btc = e18('0.0001'))))
    expect(await reason(poor.write.addColl(ADD))).toMatch(/the wallet holds 0\.0001 BTC/)
    for (const c of [none, thin, poor]) beforeCore(c)
    const big = setup({ MEZO_WRITE_MAX_BTC_PER_CALL: '0.0002' }, mine('0.045', '2101.9'))
    expect(await reason(big.write.addColl(ADD))).toMatch(/over the per-call cap of 0\.0002 BTC/)
    unsent(big)
    await expect(none.write.addColl({ amountBtc: '0' })).rejects.toThrow(InputError)
  })
})

describe('trove_repay', () => {
  const REPAY = { amountMusd: '10' }
  it('repays from the plan (no approval is needed: repayMUSD burns) and reads the lower debt back', async () => {
    const c = setup({}, mine('0.045', '2101.9'))
    const r: Json = await c.write.repay(REPAY)
    expect(r).toMatchObject({ sent: true, status: 'success', planned: { action: 'repay', icrBefore: '164.85', icrAfter: '165.63' } })
    expect(c.w.sent).toHaveLength(1)
    expect(c.w.sent[0]).toMatchObject({ to: ADDRESSES.borrowerOperations, value: 0n })
    expect(decodeFunctionData({ abi: borrowerOperationsAbi, data: c.w.sent[0]!.data })).toEqual({ functionName: 'repayMUSD', args: [e18(10), r.planned.hints.upper, r.planned.hints.lower] })
    expect(r.troveAfter).toMatchObject({ icr: '165.63', trove: { principalMusd: '2091.9', debtMusd: '2091.9', netDebtMusd: '1891.9' } })
    expect(fromRaw(r.troveAfter.raw)).toEqual(await direct(c))
    expect(c.lines()).toMatchObject([{ name: 'trove_repay', status: 'success', musd: e18(10).toString() }])
    expect(c.w.musd).toBe(e18('5.7'))
  })

  it('refuses without a trove, under the minimum net debt, under 110% or with too little MUSD; and the core\'s MUSD cap still applies', async () => {
    const none = setup()
    expect(await reason(none.write.repay(REPAY))).toMatch(/has no open trove to repay/)
    const low = setup({}, all(mine('0.045', '2101.9'), (w) => (w.musd = e18(500))))
    expect(await reason(low.write.repay({ amountMusd: '102' }))).toMatch(/the net debt would fall to 1799\.9 MUSD, under the 1800 MUSD minimum; repay at most 101\.9 MUSD/)
    const thin = setup({}, mine('0.04', '3000'))
    expect(await reason(thin.write.repay(REPAY))).toMatch(/under the 110% minimum; repaying at least 200 MUSD/)
    const poor = setup({}, all(mine('0.045', '2101.9'), (w) => (w.musd = e18(5))))
    expect(await reason(poor.write.repay(REPAY))).toMatch(/the wallet holds 5 MUSD, less than the 10 MUSD to repay/)
    for (const c of [none, low, thin, poor]) beforeCore(c)
    const capped = setup({ MEZO_WRITE_MAX_MUSD_PER_CALL: '9' }, mine('0.045', '2101.9'))
    expect(await reason(capped.write.repay(REPAY))).toMatch(/10 MUSD is over the per-call cap of 9 MUSD/)
    unsent(capped)
    await expect(none.write.repay({ amountMusd: '-1' })).rejects.toThrow(InputError)
  })
})

describe('what a mined transaction reports, and a node that is behind', () => {
  const OPEN_ARGS = { collateralBtc: '0.045', debtMusd: '1900' }

  it('a read-back that fails after the send still reports the mined transaction', async () => {
    const c = setup({}, (w) => (w.onTx = () => w.failReads.add('getTroveStatus')))
    const r: Json = await c.write.open(OPEN_ARGS)
    expect(r).toMatchObject({ sent: true, status: 'success', readBack: expect.stringMatching(/mined, but reading the result back failed/) })
    expect(r.troveAfter).toBeUndefined()
    expect(c.w.sent).toHaveLength(1)
    expect(c.lines()).toHaveLength(1)
  })

  it('asks again for the receipt and the block, then reads the trove back at that block', async () => {
    const c = setup({}, (w) => (w.onTx = () => void Object.assign(w.lag, { receipts: 2, blocks: 2, calls: 2 })), { patienceMs: 5_000, retryMs: 1 })
    const r: Json = await c.write.open(OPEN_ARGS)
    expect(r).toMatchObject({ sent: true, status: 'success', blockNumber: '16500000', troveAfter: { active: true, icr: '164.85' } })
    expect(c.w.lag).toEqual({ receipts: 0, blocks: 0, calls: 0 }) // every answer from the lagging node was met with another ask
  })

  it('a receipt that does not arrive in time is said so; the state from before the send is not shown as the result', async () => {
    const c = setup({}, (w) => (w.onTx = () => void Object.assign(w.lag, { receipts: 1_000 })), { patienceMs: 20, retryMs: 5 })
    const r: Json = await c.write.open(OPEN_ARGS)
    expect(r).toMatchObject({ sent: true, status: 'success', blockNumber: null, gasUsed: null, readBack: expect.stringMatching(/did not return its receipt in time.*trove_status/) })
    expect(r).not.toHaveProperty('troveAfter')
    expect(c.w.sent).toHaveLength(1)
  })

  it('a reverted receipt is status reverted, with no read-back and the spend still recorded', async () => {
    const c = setup({}, (w) => (w.txStatus = '0x0'))
    const r: Json = await c.write.open(OPEN_ARGS)
    expect(r).toMatchObject({ sent: true, status: 'reverted' })
    expect(r.troveAfter).toBeUndefined()
    expect(c.lines()).toMatchObject([{ name: 'trove_open', status: 'reverted' }])
  })

  it('a receipt that never arrives is status unknown with no block, and the hash to look up', async () => {
    const c = setup({}, (w) => (w.silent = true))
    const r = await c.write.open(OPEN_ARGS)
    expect(r).toMatchObject({ sent: true, status: 'unknown', blockNumber: null, gasUsed: null, hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) })
    expect(c.lines()).toMatchObject([{ name: 'trove_open', status: 'unknown' }])
  })
})

describe('the real run, rehearsed on the fake chain: open, add collateral, repay', () => {
  it('works under the caps of the real run, and the day cap leaves no room for a fourth action', async () => {
    const c = setup({ MEZO_WRITE_MAX_MUSD_PER_CALL: '1901', MEZO_WRITE_MAX_MUSD_PER_DAY: '1911', MEZO_WRITE_MAX_BTC_PER_CALL: '0.0451', MEZO_WRITE_MAX_BTC_PER_DAY: '0.0455' })
    const open: Json = await c.write.open({ collateralBtc: '0.045', debtMusd: '1900' })
    expect(open).toMatchObject({ sent: true, status: 'success', troveAfter: { icr: '164.85' } })
    const add: Json = await c.write.addColl({ amountBtc: '0.0003' })
    expect(add).toMatchObject({ sent: true, status: 'success', planned: { icrBefore: '164.85', icrAfter: '165.94' }, troveAfter: { icr: '165.94', trove: { collateralBtc: '0.0453' } } })
    const repay: Json = await c.write.repay({ amountMusd: '10' })
    expect(repay).toMatchObject({ sent: true, status: 'success', planned: { icrBefore: '165.94' }, troveAfter: { trove: { collateralBtc: '0.0453', debtMusd: '2091.9', netDebtMusd: '1891.9' } } })
    expect(c.w.sent.map((t) => t.to)).toEqual([ADDRESSES.borrowerOperations, ADDRESSES.borrowerOperations, ADDRESSES.borrowerOperations])
    expect(c.w.sent.map((t) => t.value)).toEqual([e18('0.045'), e18('0.0003'), 0n])
    const spent = c.lines().reduce((sum, l) => sum + BigInt(l.btc), 0n)
    expect(spent).toBeGreaterThan(e18('0.0453'))
    expect(spent).toBeLessThan(e18('0.0455'))
    // 0.0004 BTC is still in the wallet, but the day cap of 0.0455 BTC is not
    expect(await reason(c.write.addColl({ amountBtc: '0.0004' }))).toMatch(/would pass the per-day cap of 0\.0455 BTC/)
    expect(c.w.sent).toHaveLength(3)
  })
})
