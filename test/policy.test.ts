import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionData } from 'viem'
import { afterAll, describe, expect, it } from 'vitest'
import { ADDRESSES } from '../src/config.ts'
import { DEFAULT_MAX_GAS, checkWrite, policyFromEnv } from '../src/policy.ts'
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
    expect(reason(checkWrite(policyFromEnv(env), pay('0.1'), none))).toMatch(/no allow-list entry/) // the shipped ALLOW is empty
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
