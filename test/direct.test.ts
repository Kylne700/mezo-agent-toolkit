// The comparison helpers the live scripts rely on. If these were too forgiving, "the lens equals the direct reads" would pass for the wrong reasons.
import { describe, expect, it } from 'vitest'
import { checkShown, compare, type Shown } from '../scripts/lib/direct.ts'
import { fixed } from '../src/lens.ts'

describe('compare', () => {
  it('passes when every wanted value is in the answer, whatever the number or string type and address case', () => {
    expect(compare('x', { a: '5', b: 5, c: '0xAbC', d: true, e: null }, { a: 5, b: '5', c: '0xabc', d: true, e: null })).toEqual([])
  })

  it('reports each value that differs, by name', () => {
    const problems = compare('raw', { coll: '100', debt: '7' }, { coll: '101', debt: '7' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('raw.coll')
    expect(problems[0]).toContain('100')
    expect(problems[0]).toContain('101')
  })

  it('reports a wanted value that the answer does not have, and an answer that is missing', () => {
    expect(compare('raw', { a: '1' }, { a: '1', b: '2' })).toHaveLength(1)
    expect(compare('raw', {}, { flag: false })).toHaveLength(1)
    expect(compare('raw', undefined, { a: 1 })).toEqual(['raw: missing'])
  })

  it('does not accept null for a value, or a value for null', () => {
    expect(compare('x', { a: null }, { a: '0' })).toHaveLength(1)
    expect(compare('x', { a: '0' }, { a: null })).toHaveLength(1)
  })
})

describe('checkShown', () => {
  const cut = (value: bigint, decimals: number, places: number, shown: unknown) => checkShown('a', { v: shown }, [['v', value, decimals, places] as Shown])

  it('accepts the exact value cut off at the given places, with or without trailing zeros', () => {
    expect(cut(1_500_000_000_000_000_000n, 18, 6, '1.5')).toEqual([])
    expect(cut(1_500_000_000_000_000_000n, 18, 6, '1.500000')).toEqual([])
    expect(cut(1_999_999_999_999_999_999n, 18, 2, '1.99')).toEqual([])
    expect(cut(0n, 18, 2, '0')).toEqual([])
    expect(cut(5n * 10n ** 16n, 18, 2, '0.05')).toEqual([])
  })

  it('rejects a rounded-up value, a wrong value, extra digits and values that are not decimal text', () => {
    expect(cut(1_999_999_999_999_999_999n, 18, 2, '2')).toHaveLength(1)
    expect(cut(1_999_999_999_999_999_999n, 18, 2, '2.00')).toHaveLength(1)
    expect(cut(1_500_000_000_000_000_000n, 18, 2, '1.51')).toHaveLength(1)
    expect(cut(1_500_000_000_000_000_000n, 18, 2, '1.500')).toHaveLength(1)
    expect(cut(1_500_000_000_000_000_000n, 18, 2, 1.5)).toHaveLength(1)
    expect(cut(1_500_000_000_000_000_000n, 18, 2, undefined)).toHaveLength(1)
    expect(cut(1_500_000_000_000_000_000n, 18, 2, '1.5e0')).toHaveLength(1)
    expect(cut(1_500_000_000_000_000_000n, 18, 2, '-1.5')).toHaveLength(1)
  })

  it('reads a value whose own scale is not 18 (percent from basis points)', () => {
    expect(checkShown('a', { drop: '4.51' }, [['drop', 451n, 2, 2]])).toEqual([])
    expect(checkShown('a', { drop: '4.5' }, [['drop', 451n, 2, 2]])).toHaveLength(1)
  })

  it('agrees with the lens formatter on the same values', () => {
    for (const [value, decimals, places] of [[123_456_789_012_345_678n, 18, 8], [10n ** 18n, 18, 6], [1n, 18, 6], [99_999_999n, 8, 4]] as const) {
      expect(checkShown('a', { v: fixed(value, decimals, places) }, [['v', value, decimals, places]])).toEqual([])
    }
  })
})
