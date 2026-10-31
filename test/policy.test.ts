import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionData, maxUint256, parseAbi, type Abi, type Address } from 'viem'
import { afterAll, describe, expect, it } from 'vitest'
import { borrowerOperationsAbi, erc20Abi, poolsVoterAbi, rewardsDistributorAbi, veBtcAbi } from '../src/abis.ts'
import { ADDRESSES, LEGACY_VE } from '../src/config.ts'
import { ALLOW, DEFAULT_MAX_GAS, MAX_LOCK_SECONDS, checkWrite, policyFromEnv } from '../src/policy.ts'
import { usedOn } from '../src/receipts.ts'
import { OTHER, addColl as liarTx, allow, caps as env, pay, u } from './helpers/write.ts'

const dir = mkdtempSync(join(tmpdir(), 'mezo-policy-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const file = (body: string) => {
  const f = join(dir, `f${n++}`)
  writeFileSync(f, body)
  return f
}

const none = { musd: 0n, btc: 0n }
const reason = (c: ReturnType<typeof checkWrite>) => (c.ok ? 'allowed' : c.reason)

describe('policy from the environment', () => {
  it('unset caps are 0, so a call that moves any MUSD or BTC is refused (fail closed)', () => {
    const p = policyFromEnv({}, allow)
    expect(p).toMatchObject({ musdPerCall: 0n, musdPerDay: 0n, btcPerCall: 0n, btcPerDay: 0n, risky: false, maxGas: DEFAULT_MAX_GAS })
    expect(reason(checkWrite(p, pay('0.000000000000000001'), none))).toMatch(/over the per-call cap of 0 MUSD/)
  })

  it('refuses a per-call cap above its per-day cap, and caps that are not plain decimals', () => {
    expect(() => policyFromEnv({ ...env, MEZO_WRITE_MAX_MUSD_PER_CALL: '3' }, allow)).toThrow(/per-call cap cannot be larger than its per-day cap/)
    expect(() => policyFromEnv({ ...env, MEZO_WRITE_MAX_BTC_PER_CALL: '0.03' }, allow)).toThrow(/per-call cap cannot be larger/)
    for (const bad of ['-1', '1e3', '0x10', '1,5', ' '])
      expect(() => policyFromEnv({ ...env, MEZO_WRITE_MAX_BTC_PER_DAY: bad }, allow)).toThrow(/MEZO_WRITE_MAX_BTC_PER_DAY must be a plain decimal/)
  })

  it('the risky flag is on only for MEZO_WRITE_RISKY=1', () => {
    expect(policyFromEnv({ ...env, MEZO_WRITE_RISKY: '1' }, allow).risky).toBe(true)
    for (const v of ['true', 'yes', '0', ''])
      expect(policyFromEnv({ ...env, MEZO_WRITE_RISKY: v }, allow).risky).toBe(false)
  })
})

describe('checkWrite', () => {
  const p = policyFromEnv(env, allow)

  it('refuses a contract or a selector that is not on the allow-list', () => {
    expect(reason(checkWrite(p, pay('0.1', 'transfer', ADDRESSES.btc), none))).toMatch(/no allow-list entry for selector 0xa9059cbb on 0x7b7C/)
    const transferFrom = encodeFunctionData({ abi: [{ type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [] }], functionName: 'transferFrom', args: [OTHER, OTHER, 1n] })
    expect(reason(checkWrite(p, { to: ADDRESSES.musd, data: transferFrom, value: 0n }, none))).toMatch(/no allow-list entry for selector 0x23b872dd/)
    expect(reason(checkWrite(policyFromEnv(env), pay('0.1'), none))).toMatch(/no allow-list entry/) // the shipped ALLOW holds only the ve and trove actions (below)
  })

  it('reads the MUSD amount from the calldata and enforces the per-call cap (the cap itself passes)', () => {
    expect(checkWrite(p, pay('1'), none)).toMatchObject({ ok: true, musd: u('1'), btc: 0n })
    expect(reason(checkWrite(p, pay('1.000000000000000001'), none))).toMatch(/1.000000000000000001 MUSD is over the per-call cap of 1 MUSD/)
  })

  it('counts the tx value as BTC even when the entry declares nothing', () => {
    expect(checkWrite(p, liarTx('0.01'), none)).toMatchObject({ ok: true, btc: u('0.01') })
    expect(reason(checkWrite(p, liarTx('0.010000000000000001'), none))).toMatch(/BTC \(gas fee included\) is over the per-call cap of 0.01 BTC/)
  })

  it('counts the worst-case gas fee as BTC', () => {
    expect(checkWrite(p, pay('0.5'), none, u('0.01'))).toMatchObject({ ok: true, btc: u('0.01') })
    expect(reason(checkWrite(p, liarTx('0.005'), none, u('0.0051')))).toMatch(/0.0101 BTC \(gas fee included\) is over the per-call cap/)
  })

  it('enforces the per-day caps against what was used today and says how much is left', () => {
    expect(reason(checkWrite(p, pay('0.6'), { musd: u('1.5'), btc: 0n }))).toMatch(/would pass the per-day cap of 2 MUSD \(0.5 MUSD left today\)/)
    expect(checkWrite(p, pay('0.5'), { musd: u('1.5'), btc: 0n }).ok).toBe(true)
    expect(reason(checkWrite(p, liarTx('0.01'), { musd: 0n, btc: u('0.015') }))).toMatch(/per-day cap of 0.02 BTC \(0.005 BTC left today\)/)
  })

  it('refuses a risky entry unless the operator set MEZO_WRITE_RISKY=1', () => {
    expect(reason(checkWrite(p, pay('0.1', 'approve'), none))).toMatch(/musd.approve is a risky action/)
    expect(checkWrite(policyFromEnv({ ...env, MEZO_WRITE_RISKY: '1' }, allow), pay('0.1', 'approve'), none).ok).toBe(true)
  })

  it('refuses calldata the entry cannot decode', () => {
    expect(reason(checkWrite(p, { to: ADDRESSES.musd, data: '0xa9059cbb1234', value: 0n }, none))).toMatch(/cannot read the amounts in the musd.transfer calldata/)
  })
})

describe('the shipped allow-list holds the LIVE ve and trove actions and nothing else', () => {
  const safe = policyFromEnv(env) // the shipped ALLOW, risky off
  const risky = policyFromEnv({ ...env, MEZO_WRITE_RISKY: '1' })
  const call = (to: Address, abi: Abi, functionName: string, args: unknown[], value = 0n) => ({ to, data: encodeFunctionData({ abi, functionName, args }), value })
  const approve = (spender: Address, amount: bigint) => call(ADDRESSES.btc, erc20Abi, 'approve', [spender, amount])
  const lock = (value: bigint, seconds: bigint) => call(ADDRESSES.veBTC, veBtcAbi, 'createLock', [value, seconds])
  const vote = (pools: Address[], weights: bigint[]) => call(ADDRESSES.poolsVoter, poolsVoterAbi, 'vote', [1900n, pools, weights])
  const claim = (rewards: Address[], tokens: Address[][]) => call(ADDRESSES.poolsVoter, poolsVoterAbi, 'claimFeesAndBribes', [rewards, tokens, 1900n])
  const poke = call(ADDRESSES.poolsVoter, poolsVoterAbi, 'poke', [1900n])
  const rebase = call(ADDRESSES.rewardsDistributor, rewardsDistributorAbi, 'claim', [1900n])
  const addrs = (n: number) => Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address)
  const ones = (n: number) => Array.from({ length: n }, () => 1n)
  const day = 86_400n

  it('has nine entries, all on the LIVE contracts and none on the stalled LEGACY ones, each contract and selector once', () => {
    expect(ALLOW.map((e) => e.name)).toEqual(['ve_approve_btc', 've_lock', 've_vote', 've_poke', 've_claim_rewards', 've_claim_rebase', 'trove_open', 'trove_add_coll', 'trove_repay'])
    const live = [ADDRESSES.btc, ADDRESSES.veBTC, ADDRESSES.poolsVoter, ADDRESSES.rewardsDistributor, ADDRESSES.borrowerOperations].map((a) => a.toLowerCase())
    const legacy = Object.values(LEGACY_VE).map((a) => a.toLowerCase())
    for (const e of ALLOW) {
      expect(live, e.name).toContain(e.contract.toLowerCase())
      expect(legacy, e.name).not.toContain(e.contract.toLowerCase())
    }
    expect(new Set(ALLOW.map((e) => `${e.contract}:${e.selector}`)).size).toBe(ALLOW.length)
    expect(ALLOW.filter((e) => e.risky).map((e) => e.name)).toEqual(['ve_lock', 'trove_open'])
  })

  it('approve: only for veBTC, only an exact non-zero amount, and the amount counts as BTC against the caps', () => {
    expect(checkWrite(safe, approve(ADDRESSES.veBTC, u('0.004')), none)).toMatchObject({ ok: true, musd: 0n, btc: u('0.004') })
    for (const bad of [approve(OTHER, u('0.004')), approve(ADDRESSES.poolsVoter, u('0.004')), approve(ADDRESSES.veBTC, 0n), approve(ADDRESSES.veBTC, maxUint256), approve(ADDRESSES.veBTC, 21_000_000n * 10n ** 18n + 1n)])
      expect(reason(checkWrite(safe, bad, none))).toMatch(/cannot read the amounts in the ve_approve_btc calldata/)
    expect(reason(checkWrite(safe, approve(ADDRESSES.veBTC, u('0.011')), none))).toMatch(/over the per-call cap of 0.01 BTC/)
    expect(reason(checkWrite(safe, approve(ADDRESSES.veBTC, 21_000_000n * 10n ** 18n), none))).toMatch(/over the per-call cap/)
  })

  it('does not list the other calls an agent could be talked into: a BTC transfer, an NFT approve or transfer, anything on the LEGACY contracts', () => {
    const transferFrom = encodeFunctionData({ abi: [{ type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [] }], functionName: 'transferFrom', args: [OTHER, OTHER, 1900n] })
    expect(reason(checkWrite(risky, call(ADDRESSES.btc, erc20Abi, 'transfer', [OTHER, 1n]), none))).toMatch(/no allow-list entry for selector 0xa9059cbb/)
    // ERC-721 approve has the ERC-20 approve selector, but it is listed on the BTC contract only.
    expect(reason(checkWrite(risky, call(ADDRESSES.veBTC, erc20Abi, 'approve', [OTHER, 1900n]), none))).toMatch(/no allow-list entry for selector 0x095ea7b3 on 0x38E3/)
    expect(reason(checkWrite(risky, { to: ADDRESSES.veBTC, data: transferFrom, value: 0n }, none))).toMatch(/no allow-list entry for selector 0x23b872dd/)
    expect(reason(checkWrite(risky, { ...lock(u('0.004'), 28n * day), to: LEGACY_VE.veBTC }, none))).toMatch(/no allow-list entry/)
    expect(reason(checkWrite(risky, { ...vote(addrs(1), [100n]), to: LEGACY_VE.voter }, none))).toMatch(/no allow-list entry/)
    expect(reason(checkWrite(risky, { ...rebase, to: LEGACY_VE.rewardsDistributor }, none))).toMatch(/no allow-list entry/)
  })

  it('lock: a risky action, a non-zero amount, one second to 28 days', () => {
    const good = lock(u('0.004'), 28n * day)
    expect(MAX_LOCK_SECONDS).toBe(28n * day)
    expect(reason(checkWrite(safe, good, none))).toMatch(/ve_lock is a risky action, refused unless the operator sets MEZO_WRITE_RISKY=1/)
    expect(checkWrite(risky, good, none)).toMatchObject({ ok: true, musd: 0n, btc: u('0.004') })
    expect(checkWrite(risky, lock(u('0.004'), 1n), none).ok).toBe(true)
    for (const bad of [lock(0n, 28n * day), lock(u('0.004'), 0n), lock(u('0.004'), 28n * day + 1n), lock(u('0.004'), maxUint256)])
      expect(reason(checkWrite(risky, bad, none))).toMatch(/cannot read the amounts in the ve_lock calldata/)
    expect(reason(checkWrite(risky, lock(u('0.011'), 28n * day), none))).toMatch(/over the per-call cap of 0.01 BTC/)
  })

  it('vote: one to thirty pools, a non-zero weight each, equal lists; it moves no funds', () => {
    expect(checkWrite(safe, vote(addrs(1), [100n]), none)).toMatchObject({ ok: true, musd: 0n, btc: 0n })
    expect(checkWrite(safe, vote(addrs(30), ones(30)), none).ok).toBe(true)
    for (const bad of [vote([], []), vote(addrs(31), ones(31)), vote(addrs(1), [0n]), vote(addrs(2), [1n]), vote(addrs(1), [1n, 1n])])
      expect(reason(checkWrite(safe, bad, none))).toMatch(/cannot read the amounts in the ve_vote calldata/)
  })

  it('poke and the rebase claim move no funds; the fee and bribe claim needs matching, bounded lists', () => {
    expect(checkWrite(safe, poke, none)).toMatchObject({ ok: true, musd: 0n, btc: 0n })
    expect(checkWrite(safe, rebase, none)).toMatchObject({ ok: true, musd: 0n, btc: 0n })
    const tokens = (n: number) => addrs(n).map(() => [ADDRESSES.musd])
    expect(checkWrite(safe, claim(addrs(2), tokens(2)), none)).toMatchObject({ ok: true, musd: 0n, btc: 0n })
    expect(checkWrite(safe, claim(addrs(60), tokens(60)), none).ok).toBe(true)
    for (const bad of [claim([], []), claim(addrs(61), tokens(61)), claim(addrs(2), tokens(1))])
      expect(reason(checkWrite(safe, bad, none))).toMatch(/cannot read the amounts in the ve_claim_rewards calldata/)
  })

  it('trove: openTrove is risky and counts its debt as MUSD and its value as BTC once; addColl counts its value; repayMUSD counts the repayment as MUSD', () => {
    const open = (debt: bigint, value: bigint) => call(ADDRESSES.borrowerOperations, borrowerOperationsAbi, 'openTrove', [debt, OTHER, OTHER], value)
    const addColl = (value: bigint) => call(ADDRESSES.borrowerOperations, borrowerOperationsAbi, 'addColl', [OTHER, OTHER], value)
    const repay = (amount: bigint) => call(ADDRESSES.borrowerOperations, borrowerOperationsAbi, 'repayMUSD', [amount, OTHER, OTHER])
    expect(reason(checkWrite(safe, open(u('0.5'), u('0.005')), none))).toMatch(/trove_open is a risky action, refused unless the operator sets MEZO_WRITE_RISKY=1/)
    expect(checkWrite(risky, open(u('0.5'), u('0.005')), none)).toMatchObject({ ok: true, musd: u('0.5'), btc: u('0.005') })
    expect(reason(checkWrite(risky, open(u('1.5'), u('0.005')), none))).toMatch(/1.5 MUSD is over the per-call cap of 1 MUSD/)
    expect(reason(checkWrite(risky, open(u('0.5'), u('0.011')), none))).toMatch(/over the per-call cap of 0.01 BTC/)
    expect(reason(checkWrite(risky, open(0n, u('0.005')), none))).toMatch(/cannot read the amounts in the trove_open calldata/)
    expect(checkWrite(safe, addColl(u('0.005')), none)).toMatchObject({ ok: true, musd: 0n, btc: u('0.005') })
    expect(reason(checkWrite(safe, addColl(u('0.011')), none))).toMatch(/over the per-call cap of 0.01 BTC/)
    expect(checkWrite(safe, repay(u('0.5')), none)).toMatchObject({ ok: true, musd: u('0.5'), btc: 0n })
    expect(reason(checkWrite(safe, repay(u('1.5')), none))).toMatch(/1.5 MUSD is over the per-call cap of 1 MUSD/)
    expect(reason(checkWrite(safe, repay(0n), none))).toMatch(/cannot read the amounts in the trove_repay calldata/)
    expect(checkWrite(safe, { ...repay(u('0.5')), value: u('0.005') }, none)).toMatchObject({ ok: true, btc: u('0.005') }) // a stray value on a repayment still counts as BTC
  })

  it('does not list the other BorrowerOperations calls: taking collateral or debt out, closing or refinancing the trove, claiming collateral', () => {
    const bo = parseAbi([
      'function withdrawColl(uint256, address, address)',
      'function withdrawMUSD(uint256, address, address)',
      'function closeTrove()',
      'function refinance(address, address)',
      'function adjustTrove(uint256, uint256, bool, address, address) payable',
      'function claimCollateral()',
    ])
    const args: Record<string, unknown[]> = { withdrawColl: [1n, OTHER, OTHER], withdrawMUSD: [1n, OTHER, OTHER], closeTrove: [], refinance: [OTHER, OTHER], adjustTrove: [1n, 1n, true, OTHER, OTHER], claimCollateral: [] }
    for (const [name, a] of Object.entries(args)) expect(reason(checkWrite(risky, call(ADDRESSES.borrowerOperations, bo, name, a), none)), name).toMatch(/no allow-list entry for selector 0x[0-9a-f]{8} on 0xCdF7/)
  })

  it('a ve call that carries value is still a BTC transfer for the caps, and the gas fee counts', () => {
    expect(reason(checkWrite(safe, { ...poke, value: u('0.011') }, none))).toMatch(/over the per-call cap of 0.01 BTC/)
    expect(reason(checkWrite(safe, poke, none, u('0.011')))).toMatch(/over the per-call cap of 0.01 BTC/)
    expect(checkWrite(safe, { ...rebase, value: u('0.01') }, none)).toMatchObject({ ok: true, btc: u('0.01') })
  })
})

describe('policy file (MEZO_POLICY_FILE) can only tighten', () => {
  const withFile = (body: unknown) => policyFromEnv({ ...env, MEZO_POLICY_FILE: file(JSON.stringify(body)) }, allow)

  it('lowers caps and the gas cap, shrinks the allow-list and turns risky off', () => {
    const p = policyFromEnv({ ...env, MEZO_WRITE_RISKY: '1', MEZO_POLICY_FILE: file(JSON.stringify({ maxMusdPerCall: '0.5', maxBtcPerDay: '0.015', maxGas: 200000, allow: ['musd.transfer', 'musd.approve'], risky: false })) }, allow)
    expect(p).toMatchObject({ musdPerCall: u('0.5'), musdPerDay: u('2'), btcPerCall: u('0.01'), btcPerDay: u('0.015'), maxGas: 200000n, risky: false })
    expect(p.allow.map((e) => e.name)).toEqual(['musd.transfer', 'musd.approve'])
    expect(reason(checkWrite(p, pay('0.6'), none))).toMatch(/over the per-call cap of 0.5 MUSD/)
  })

  it('ignores every attempt to loosen: higher caps, a higher gas cap, risky on, unknown entry names', () => {
    const p = withFile({ maxMusdPerCall: '100', maxMusdPerDay: '100', maxBtcPerCall: '5', maxBtcPerDay: '5', maxGas: 30000000, risky: true, allow: ['musd.transfer', 'drain.everything'] })
    expect(p).toMatchObject({ musdPerCall: u('1'), musdPerDay: u('2'), btcPerCall: u('0.01'), btcPerDay: u('0.02'), maxGas: DEFAULT_MAX_GAS, risky: false })
    expect(p.allow.map((e) => e.name)).toEqual(['musd.transfer'])
    expect(reason(checkWrite(p, pay('1.5'), none))).toMatch(/over the per-call cap of 1 MUSD/)
  })

  it('a set but missing, unreadable or malformed file turns writes off instead of being skipped', () => {
    expect(() => policyFromEnv({ ...env, MEZO_POLICY_FILE: join(dir, 'missing.json') }, allow)).toThrow(/cannot be read as JSON/)
    expect(() => policyFromEnv({ ...env, MEZO_POLICY_FILE: file('{ not json') }, allow)).toThrow(/cannot be read as JSON/)
    expect(() => withFile([1])).toThrow(/one JSON object/)
    expect(() => withFile({ maxMusdPerCall: '0.5', killFile: '/dev/null' })).toThrow(/unknown keys: killFile/)
    expect(() => withFile({ maxMusdPerCall: 0.5 })).toThrow(/maxMusdPerCall must be a plain decimal/)
    expect(() => withFile({ maxGas: '100' })).toThrow(/maxGas must be a positive whole number/)
    expect(() => withFile({ allow: 'musd.transfer' })).toThrow(/allow must be a list/)
    expect(() => withFile({ risky: 'false' })).toThrow(/risky must be true or false/)
  })
})

describe('receipts ledger', () => {
  it('sums one UTC day, treats a missing file as empty, and refuses a line it cannot read', () => {
    expect(usedOn(join(dir, 'none.jsonl'), '2026-11-02')).toEqual(none)
    const line = (at: string, musd: string, btc: string) => JSON.stringify({ at, musd, btc })
    const f = file([line('2026-11-02T23:59:59.000Z', '5', '7'), line('2026-11-03T00:00:00.000Z', '100', '200'), line('2026-11-02T01:00:00.000Z', '1', '1'), ''].join('\n'))
    expect(usedOn(f, '2026-11-02')).toEqual({ musd: 6n, btc: 8n })
    expect(() => usedOn(file(`${line('2026-11-02T01:00:00.000Z', '1', '1')}\n{"at":"2026-11-02T0`), '2026-11-02')).toThrow(/line 2 of the receipts file is not a valid receipt/)
    expect(() => usedOn(file(line('2026-11-02T01:00:00.000Z', '-5', '1')), '2026-11-02')).toThrow(/not a valid receipt/)
  })
})
