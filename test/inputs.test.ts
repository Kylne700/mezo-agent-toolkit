import { describe, expect, it } from 'vitest'
import { InputError, parseAddress, parseAmountText, parseBool, parseToken, parseTokenAmount } from '../src/inputs.ts'

const GOOD = '0xDA04759E54728B6636Fe48F7c9795c7B609bAaAa'

describe('parseAddress', () => {
  it('accepts a checksummed address and an all-lowercase one, and returns the checksummed form', () => {
    expect(parseAddress(GOOD)).toBe(GOOD)
    expect(parseAddress(GOOD.toLowerCase())).toBe(GOOD)
  })

  it('rejects a mixed-case address with a wrong checksum, and anything that is not an address', () => {
    for (const bad of ['0xDA04759E54728B6636Fe48F7c9795c7B609bAaAA', '0x123', 'DA04759E54728B6636Fe48F7c9795c7B609bAaAa', '', undefined, 5, null]) {
      expect(() => parseAddress(bad), String(bad)).toThrow(InputError)
    }
  })

  it('names the field in the message', () => {
    expect(() => parseAddress('x', 'borrower')).toThrow(/borrower must be a 0x address/)
  })
})

describe('parseToken', () => {
  it('turns known symbols of any case into upper case and checksums addresses', () => {
    expect(parseToken('btc')).toBe('BTC')
    expect(parseToken(' Musd ')).toBe('MUSD')
    expect(parseToken(GOOD.toLowerCase())).toBe(GOOD)
  })

  it('rejects unknown symbols', () => {
    expect(() => parseToken('DOGE')).toThrow(InputError)
    expect(() => parseToken(undefined)).toThrow(InputError)
  })
})

describe('amounts', () => {
  it('accept plain positive decimals', () => {
    expect(parseAmountText('1000')).toBe('1000')
    expect(parseAmountText(' 0.5 ')).toBe('0.5')
    expect(parseTokenAmount('0.001', 18)).toBe(10n ** 15n)
    expect(parseTokenAmount('12', 8)).toBe(1_200_000_000n)
  })

  it('reject zero, signs, exponents, separators, hex and non-strings', () => {
    for (const bad of ['0', '0.0', '-1', '+1', '1e3', '1,5', '0x10', '', ' ', '.5', '5.', 'NaN', '1'.repeat(31), undefined, 7]) {
      expect(() => parseAmountText(bad), String(bad)).toThrow(InputError)
    }
  })

  it('reject more decimal places than the token has', () => {
    expect(() => parseTokenAmount('0.123456789', 8)).toThrow(/more than 8 decimal places/)
  })
})

describe('parseBool', () => {
  it('reads true/false/1/0, leaves missing values undefined and rejects the rest', () => {
    expect([parseBool('true', 'x'), parseBool('1', 'x'), parseBool('false', 'x'), parseBool('0', 'x'), parseBool(true, 'x'), parseBool(false, 'x')]).toEqual([true, true, false, false, true, false])
    expect([parseBool(undefined, 'x'), parseBool('', 'x'), parseBool(null, 'x')]).toEqual([undefined, undefined, undefined])
    expect(() => parseBool('maybe', 'stable')).toThrow(/stable must be true or false/)
  })
})
