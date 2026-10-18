import { parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'
import { ADDRESSES, NETWORK } from '../src/config.ts'
import { SpendGuard, limitsFromEnv, parseMusd } from '../src/spend.ts'

const musd = (x: string) => parseUnits(x, 18)
const req = (over: Record<string, string> = {}) => ({ scheme: 'exact', network: NETWORK, asset: ADDRESSES.musd, amount: musd('0.001').toString(), ...over })
const guard = (perCall = '0.01', perSession = '0.03') => new SpendGuard({ perCall: musd(perCall), perSession: musd(perSession) })

describe('SpendGuard limits', () => {
  it('allows payments up to the per-call limit, including exactly the limit', () => {
    const g = guard()
    expect(g.authorize(req({ amount: musd('0.01').toString() })).ok).toBe(true)
  })

  it('refuses a payment over the per-call limit and reserves nothing for it', () => {
    const g = guard()
    const d = g.authorize(req({ amount: (musd('0.01') + 1n).toString() }))
    expect(d).toMatchObject({ ok: false })
    expect(d.ok === false && d.reason).toMatch(/over the per-call limit of 0\.01 MUSD/)
    expect(g.snapshot()).toMatchObject({ spentMusd: '0', payments: 0 })
  })

  it('stops when the session total would pass the session limit, and says how much is left', () => {
    const g = guard('0.01', '0.025')
    expect(g.authorize(req({ amount: musd('0.01').toString() })).ok).toBe(true)
    expect(g.authorize(req({ amount: musd('0.01').toString() })).ok).toBe(true)
    const d = g.authorize(req({ amount: musd('0.01').toString() }))
    expect(d.ok === false && d.reason).toMatch(/session limit of 0\.025 MUSD \(0\.005 MUSD left\)/)
    // A refused payment reserved nothing, so a smaller one that fits still goes through.
    expect(g.authorize(req({ amount: musd('0.005').toString() })).ok).toBe(true)
    expect(g.snapshot()).toEqual({ perCallMusd: '0.01', perSessionMusd: '0.025', spentMusd: '0.025', remainingMusd: '0', payments: 3 })
  })

  it('reserves in the same step it decides, so two payments in a row cannot both squeeze under the limit', () => {
    const g = guard('0.02', '0.03')
    const results = [g.authorize(req({ amount: musd('0.02').toString() })), g.authorize(req({ amount: musd('0.02').toString() }))]
    expect(results.map((r) => r.ok)).toEqual([true, false])
  })

  it('counts a reservation as spent for good (no refunds)', () => {
    const g = guard()
    g.authorize(req())
    expect(g.snapshot().spentMusd).toBe('0.001')
  })
})

describe('SpendGuard rules', () => {
  const refused = (over: Record<string, string>) => {
    const d = guard().authorize(req(over))
    return d.ok ? null : d.reason
  }

  it('pays only the exact scheme on Mezo testnet in MUSD', () => {
    expect(refused({ scheme: 'upto' })).toMatch(/scheme "upto" is not allowed/)
    expect(refused({ network: 'eip155:31612' })).toMatch(/network "eip155:31612" is not allowed/)
    expect(refused({ asset: '0x7b7C000000000000000000000000000000000000' })).toMatch(/asset .* is not allowed/)
  })

  it('compares the asset address without regard to letter case', () => {
    expect(guard().authorize(req({ asset: ADDRESSES.musd.toLowerCase() })).ok).toBe(true)
  })

  it('refuses amounts that are not a plain whole number of base units instead of guessing', () => {
    for (const amount of ['01', '1e3', '-5', '1.5', ' 7', '', '0x10', 'abc', '9'.repeat(79)]) {
      expect(refused({ amount }), JSON.stringify(amount)).toMatch(/is not a whole number of base units/)
    }
  })

  it('refuses a non-string amount', () => {
    expect(guard().authorize({ ...req(), amount: 5 as unknown as string }).ok).toBe(false)
  })
})

describe('SpendGuard set-up', () => {
  it('needs positive limits with the per-call limit not above the session limit', () => {
    expect(() => new SpendGuard({ perCall: 0n, perSession: 1n })).toThrow(/greater than zero/)
    expect(() => new SpendGuard({ perCall: 2n, perSession: 1n })).toThrow(/cannot be larger/)
  })

  it('reads its limits from the environment, with small defaults', () => {
    expect(limitsFromEnv({})).toEqual({ perCall: musd('0.01'), perSession: musd('0.1') })
    expect(limitsFromEnv({ MEZO_MAX_PER_CALL_MUSD: '0.5', MEZO_MAX_PER_SESSION_MUSD: '2' })).toEqual({ perCall: musd('0.5'), perSession: musd('2') })
  })

  it('rejects limits that are not plain decimals', () => {
    for (const bad of ['abc', '-1', '1e3', '', '0.0000000000000000001', '1,5']) {
      expect(() => parseMusd(bad, 'X'), bad).toThrow(/plain decimal MUSD amount/)
    }
  })
})
