import { beforeAll, describe, expect, it } from 'vitest'
import { type Hex, getAddress, zeroAddress } from 'viem'
import { buildLensArtifact, buildMocks } from '../scripts/compile.mjs'
import { Chain, NOW, type Compiled } from './helpers/evm.ts'

const E18 = 10n ** 18n
const PRICE = 80_000n * E18
const BTC = '0x7b7C000000000000000000000000000000000000' as Hex
const MUSD = '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503' as Hex
const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`) // checksummed, like the addresses viem decodes
const T = { t0: addr(0xa0), t1: addr(0xa1), t2: addr(0xa2), t3: addr(0xa3), t4: addr(0xa4) } // t0 is the tail (lowest nominal ratio), t4 the head

let lensArtifact: ReturnType<typeof buildLensArtifact>
let mocks: Record<string, Compiled>

type Names = 'tm' | 'st' | 'pf' | 'router' | 'veBTC' | 'veMEZO' | 'lens'
const MOCK_OF = { tm: 'MockTroveManager', st: 'MockSortedTroves', pf: 'MockPriceFeed', router: 'MockRouter', veBTC: 'MockVeBTC', veMEZO: 'MockVeMEZO' } as const

/** A fresh chain with every mock and a lens pointing at them. Tests that change shared state build their own. */
class World {
  private constructor(readonly chain: Chain, readonly a: Record<Names, Hex>) {}
  static async create() {
    const chain = await Chain.create()
    const a = { lens: '0x' as Hex } as Record<Names, Hex>
    for (const [key, name] of Object.entries(MOCK_OF)) a[key as Names] = await chain.deploy(mocks[name])
    a.lens = await chain.deploy({ abi: lensArtifact.abi as never, bytecode: lensArtifact.bytecode as Hex }, [a.tm, a.st, a.pf, a.router, a.veBTC, a.veMEZO])
    const w = new World(chain, a)
    await w.mock('pf', 'set', PRICE)
    return w
  }
  lens = async <T = any>(fn: string, ...args: unknown[]) => (await this.chain.call<T>(this.a.lens, lensArtifact.abi as never, fn, args)).result
  mock = (key: keyof typeof MOCK_OF, fn: string, ...args: unknown[]) => this.chain.call(this.a[key], mocks[MOCK_OF[key]].abi, fn, args)
  setTrove = (b: Hex, coll: bigint, principal: bigint, interest = 0n, status = 1) => this.mock('tm', 'setTrove', b, coll, principal, interest, status)
  /** pushes to the tail of the sorted list */
  push = (b: Hex) => this.mock('st', 'push', b)
}

const cr = (coll: bigint, debt: bigint, price = PRICE) => (coll * price) / debt

let w: World
const lens = <T = any>(fn: string, ...args: unknown[]) => w.lens<T>(fn, ...args)
const mock = (key: keyof typeof MOCK_OF, fn: string, ...args: unknown[]) => w.mock(key, fn, ...args)
const setTrove = (...args: Parameters<World['setTrove']>) => w.setTrove(...args)

beforeAll(async () => {
  lensArtifact = buildLensArtifact()
  mocks = buildMocks() as Record<string, Compiled>
  w = await World.create()
  // List order: head (safest) ... tail (lowest nominal ratio). A redemption starts at the tail.
  await setTrove(T.t0, E18 / 20n, 4000n * E18) // ICR 100%: below MCR
  await setTrove(T.t1, E18 / 20n, 3700n * E18) // ICR 108%: below MCR
  await setTrove(T.t2, E18 / 20n, 3500n * E18) // ICR 114%: redeemable, 3300 MUSD after the 200 gas reserve
  await setTrove(T.t3, E18 / 10n, 6000n * E18, 100n * E18) // ICR 131%: redeemable, 5900 MUSD
  await setTrove(T.t4, E18, 20_000n * E18) // ICR 400%
  for (const t of [T.t4, T.t3, T.t2, T.t1, T.t0]) await w.push(t)
  await mock('tm', 'setSystem', 10n * E18, 400_000n * E18) // TCR 200%
}, 120_000)

describe('MezoLens contract (against mock Mezo contracts in an in-process EVM)', () => {
  it('the committed artifact is what a fresh compile produces', async () => {
    const { readFileSync } = await import('node:fs')
    const committed = JSON.parse(readFileSync(new URL('../artifacts/MezoLens.json', import.meta.url), 'utf8'))
    expect(committed).toEqual(JSON.parse(JSON.stringify(lensArtifact)))
  })

  it('rejects a zero address in the constructor', async () => {
    await expect(w.chain.deploy({ abi: lensArtifact.abi as never, bytecode: lensArtifact.bytecode as Hex }, [w.a.tm, w.a.st, w.a.pf, w.a.router, w.a.veBTC, zeroAddress])).rejects.toThrow('zero address')
  })

  describe('troveHealth', () => {
    it('computes debt, ratio, liquidation price and the drop to it', async () => {
      const h = await lens('troveHealth', T.t3)
      const debt = 6100n * E18
      expect(h.status).toBe(1)
      expect(h.coll).toBe(E18 / 10n)
      expect(h.principal).toBe(6000n * E18)
      expect(h.interest).toBe(100n * E18)
      expect(h.debt).toBe(debt)
      expect(h.price).toBe(PRICE)
      expect(h.icr).toBe(cr(E18 / 10n, debt))
      expect(h.mcr).toBe((11n * E18) / 10n)
      expect(h.liquidationPrice).toBe((h.mcr * debt) / (E18 / 10n)) // 67,100 USD
      expect(h.liquidationPrice).toBe(67_100n * E18)
      expect(h.priceDropToLiquidationBps).toBe(((PRICE - 67_100n * E18) * 10_000n) / PRICE) // 1612 bps, rounded down
    })

    it('reports zero distance for a trove already under MCR', async () => {
      const h = await lens('troveHealth', T.t1)
      expect(h.icr).toBeLessThan(h.mcr)
      expect(h.priceDropToLiquidationBps).toBe(0n)
      expect(h.liquidationPrice).toBeGreaterThan(h.price)
    })

    it('returns only the status (and the price) for a missing or closed trove', async () => {
      const missing = await lens('troveHealth', addr(0xdead))
      expect(missing.status).toBe(0)
      expect([missing.coll, missing.debt, missing.icr, missing.liquidationPrice]).toEqual([0n, 0n, 0n, 0n])
      expect(missing.price).toBe(PRICE)
      await setTrove(addr(0xc10), 0n, 0n, 0n, 3) // closed by liquidation
      expect((await lens('troveHealth', addr(0xc10))).status).toBe(3)
    })
  })

  describe('redemptionQueue', () => {
    const queue = (borrower: Hex, cursor: Hex = zeroAddress, max = 300n) => lens('redemptionQueue', borrower, cursor, max)

    it('counts the redeemable troves and MUSD in front of a borrower, skipping troves under MCR', async () => {
      const q = await queue(T.t4)
      expect(q).toMatchObject({ listed: true, found: true, truncated: false, next: zeroAddress, steps: 5n, ahead: 2n, belowMcr: 2n, listSize: 5n })
      expect(q.debtAhead).toBe((3500n - 200n + 6100n - 200n) * E18) // 9,200 MUSD
      expect(q.borrowerIcr).toBe(cr(E18, 20_000n * E18))
      expect(q.price).toBe(PRICE)
    })

    it('finds the first redeemable trove with nothing in front of it', async () => {
      const q = await queue(T.t2)
      expect(q).toMatchObject({ found: true, steps: 3n, ahead: 0n, debtAhead: 0n, belowMcr: 2n })
    })

    it('reports a borrower that is itself under MCR (a redemption skips them)', async () => {
      const q = await queue(T.t1)
      expect(q.found).toBe(true)
      expect(q.borrowerIcr).toBeLessThan(q.mcr)
      expect(q.belowMcr).toBe(1n) // t0 only: the borrower is not counted
    })

    it('pages with a cursor and the pages add up to the one-shot answer', async () => {
      const whole = await queue(T.t4)
      let cursor: Hex = zeroAddress
      const sum = { steps: 0n, ahead: 0n, debtAhead: 0n, belowMcr: 0n }
      let pages = 0
      for (;;) {
        const p = await queue(T.t4, cursor, 2n)
        pages++
        sum.steps += p.steps; sum.ahead += p.ahead; sum.debtAhead += p.debtAhead; sum.belowMcr += p.belowMcr
        if (!p.truncated) { expect(p.found).toBe(true); break }
        expect(p.found).toBe(false)
        cursor = p.next
      }
      expect(pages).toBe(3)
      expect(sum).toEqual({ steps: whole.steps, ahead: whole.ahead, debtAhead: whole.debtAhead, belowMcr: whole.belowMcr })
    })

    it('clamps maxSteps of zero to one step', async () => {
      const q = await queue(T.t4, zeroAddress, 0n)
      expect(q).toMatchObject({ steps: 1n, truncated: true, found: false, next: T.t1 })
    })

    it('says so when the borrower has no open trove, and rejects a cursor outside the list', async () => {
      expect(await queue(addr(0xdead))).toMatchObject({ listed: false, found: false, steps: 0n })
      await expect(queue(T.t4, addr(0xdead))).rejects.toThrow('cursor not in list')
    })

    it('adds nothing for a trove whose debt is at or under the gas reserve', async () => {
      const x = await World.create()
      const [head, tiny] = [addr(0xb0), addr(0xb1)]
      await x.setTrove(head, E18, 1000n * E18)
      await x.setTrove(tiny, E18, 150n * E18) // debt below the 200 MUSD reserve, ICR far above MCR
      await x.push(head)
      await x.push(tiny)
      const q = await x.lens('redemptionQueue', head, zeroAddress, 300n)
      expect(q).toMatchObject({ found: true, steps: 2n, ahead: 1n, debtAhead: 0n })
    })

    it('stops at the walk cap on a long list', async () => {
      const x = await World.create()
      const head = addr(0x9000)
      for (const t of [head, ...Array.from({ length: 310 }, (_, i) => addr(0x9001 + i))]) {
        await x.setTrove(t, E18, 1000n * E18)
        await x.push(t)
      }
      const q = await x.lens('redemptionQueue', head, zeroAddress, 100_000n)
      expect(q.steps).toBe(300n)
      expect(q.truncated).toBe(true)
      expect(q.found).toBe(false)
    }, 120_000)
  })

  describe('systemSnapshot', () => {
    it('reports the totals and the first trove a redemption would hit', async () => {
      const s = await lens('systemSnapshot', 50n)
      expect(s).toMatchObject({ price: PRICE, tcr: (10n * E18 * PRICE) / (400_000n * E18), mcr: (11n * E18) / 10n, ccr: (15n * E18) / 10n, recoveryMode: false, redemptionsOpen: true, totalColl: 10n * E18, totalDebt: 400_000n * E18 })
      expect(s.lowestNicr).toBe(T.t0)
      expect(s.firstRedeemable).toBe(T.t2)
      expect(s.firstRedeemableIcr).toBe(cr(E18 / 20n, 3500n * E18))
      expect(s.skippedBelowMcr).toBe(2n)
      expect(s.scanTruncated).toBe(false)
    })

    it('flags a scan cut short by the cap', async () => {
      const s = await lens('systemSnapshot', 1n)
      expect(s).toMatchObject({ firstRedeemable: zeroAddress, skippedBelowMcr: 1n, scanTruncated: true })
    })

    it('flags recovery mode and closed redemptions from the system ratio', async () => {
      await mock('tm', 'setSystem', 10n * E18, 800_000n * E18) // TCR 100%
      const s = await lens('systemSnapshot', 50n)
      expect(s.recoveryMode).toBe(true)
      expect(s.redemptionsOpen).toBe(false)
      await mock('tm', 'setSystem', 10n * E18, 400_000n * E18)
    })
  })

  describe('poolQuote', () => {
    const reserves = { btc: 1000n * E18, musd: 80_000_000n * E18 }
    const out = (amountIn: bigint) => (amountIn * 997n * reserves.musd) / (reserves.btc * 1000n + amountIn * 997n)

    beforeAll(async () => {
      await mock('router', 'addPool', BTC, MUSD, false, reserves.btc, reserves.musd)
    })

    it('quotes through the router and measures the curve slippage', async () => {
      const amountIn = 10n * E18
      const q = await lens('poolQuote', BTC, MUSD, amountIn, false)
      expect(q).toMatchObject({ poolExists: true, quoteOk: true, amountOut: out(amountIn), reserveIn: reserves.btc, reserveOut: reserves.musd })
      const ideal = out(amountIn / 100n) * 100n
      expect(q.impactBps).toBe(((ideal - out(amountIn)) * 10_000n) / ideal)
      expect(q.impactBps).toBeGreaterThan(0n)
    })

    it('works in the other direction', async () => {
      const q = await lens('poolQuote', MUSD, BTC, 8_000n * E18, false)
      expect(q.quoteOk).toBe(true)
      expect(q.reserveIn).toBe(reserves.musd)
    })

    it('does not revert when the pool is missing or the router refuses', async () => {
      const none = await lens('poolQuote', BTC, MUSD, E18, true) // no stable pool
      expect(none).toMatchObject({ poolExists: false, quoteOk: false, amountOut: 0n })
      expect(none.pool).not.toBe(zeroAddress)
      const zero = await lens('poolQuote', BTC, MUSD, 0n, false) // router rejects zero input
      expect(zero).toMatchObject({ poolExists: true, quoteOk: false, amountOut: 0n })
    })
  })

  describe('veLocks', () => {
    const owner = addr(0x0ab1)
    const other = addr(0x0ab2)
    const locks = (who: Hex, max: bigint) => lens<[any[], bigint, bigint]>('veLocks', who, max)

    beforeAll(async () => {
      await mock('veBTC', 'add', owner, 1n, 5n * E18, NOW + 1000n, false, 4n * E18, true)
      await mock('veBTC', 'add', owner, 2n, 7n * E18, NOW - 10n, false, 0n, false) // expired
      await mock('veBTC', 'add', owner, 3n, E18, 0n, true, E18, true) // permanent
      await mock('veMEZO', 'add', owner, 11n, 100n * E18, NOW + 5000n, false, 150n * E18, false)
      await mock('veBTC', 'add', other, 4n, -5n, NOW + 1n, false, 0n, false) // a negative amount must not wrap around
    })

    it('lists veBTC locks first, then veMEZO, with the time left', async () => {
      const [list, veBtcCount, veMezoCount] = await locks(owner, 10n)
      expect([veBtcCount, veMezoCount, list.length]).toEqual([3n, 1n, 4]);
      expect(list.map((l) => l.tokenId)).toEqual([1n, 2n, 3n, 11n])
      expect(list[0]).toMatchObject({ escrow: getAddress(w.a.veBTC), amount: 5n * E18, end: NOW + 1000n, isPermanent: false, votingPower: 4n * E18, voted: true, secondsLeft: 1000n, expired: false })
      expect(list[1]).toMatchObject({ secondsLeft: 0n, expired: true, votingPower: 0n })
      expect(list[2]).toMatchObject({ isPermanent: true, secondsLeft: 0n, expired: false })
      expect(list[3]).toMatchObject({ escrow: getAddress(w.a.veMEZO), amount: 100n * E18, votingPower: 150n * E18, secondsLeft: 5000n })
    })

    it('cuts the list at max but still reports the full counts', async () => {
      const [list, veBtcCount, veMezoCount] = await locks(owner, 2n)
      expect(list).toHaveLength(2)
      expect(veBtcCount + veMezoCount).toBe(4n)
      expect(await locks(owner, 0n).then(([l]) => l.length)).toBe(1) // zero is clamped to one
    })

    it('returns nothing for an owner without locks, and 0 for a negative amount', async () => {
      expect(await locks(addr(0x0ab3), 10n)).toEqual([[], 0n, 0n])
      const [list] = await locks(other, 10n)
      expect(list[0].amount).toBe(0n)
    })
  })
})
