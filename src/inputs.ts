// Input checks shared by the HTTP routes and the MCP tools, so both reject the same bad input in the same words.
import { getAddress, isAddress, type Address } from 'viem'
import { z } from 'zod'
import { TOKENS } from './config.ts'

/** Bad caller input (as opposed to a chain or network failure). HTTP maps it to 400 and MCP to a tool error. */
export class InputError extends Error {
  override name = 'InputError'
}

export function parseAddress(v: unknown, name = 'address'): Address {
  // isAddress is strict by default: an all-lowercase address passes, a mixed-case one must carry a valid checksum.
  if (typeof v !== 'string' || !isAddress(v)) throw new InputError(`${name} must be a 0x address with 40 hex characters (a mixed-case address needs a valid checksum)`)
  return getAddress(v)
}

const SYMBOLS = Object.keys(TOKENS)
/** A known symbol (BTC, MUSD, MEZO; any case) comes back upper-case, an address comes back checksummed. */
export function parseToken(v: unknown, name = 'token'): string {
  if (typeof v === 'string') {
    const up = v.trim().toUpperCase()
    if (SYMBOLS.includes(up)) return up
    if (isAddress(v.trim())) return getAddress(v.trim())
  }
  throw new InputError(`${name} must be one of ${SYMBOLS.join(', ')} or a 0x token address`)
}

/** A plain positive decimal such as "1000" or "0.5", checked for shape only (the token's decimals are checked in parseTokenAmount). */
export function parseAmountText(v: unknown, name = 'amountIn'): string {
  if (typeof v !== 'string' || !/^\d{1,30}(\.\d{1,36})?$/.test(v.trim()) || /^0+(\.0+)?$/.test(v.trim())) {
    throw new InputError(`${name} must be a plain positive decimal number such as 1000 or 0.5`)
  }
  return v.trim()
}

/** Parse a plain decimal amount into base units. Rejects signs, exponents, separators, zero and too many decimals. */
export function parseTokenAmount(text: string, decimals: number): bigint {
  const t = parseAmountText(text)
  const [whole, frac = ''] = t.split('.')
  if (frac.length > decimals) throw new InputError(`amountIn has more than ${decimals} decimal places`)
  return BigInt(whole! + frac.padEnd(decimals, '0'))
}

/** "true", "false", "1", "0" (as in a query string) or a real boolean. Anything else is an error. */
export function parseBool(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (v === true || v === 'true' || v === '1') return true
  if (v === false || v === 'false' || v === '0') return false
  throw new InputError(`${name} must be true or false`)
}

// Shapes for the MCP tools. Plain strings, so the generated JSON schema stays simple; the parse functions above do the real checking.
export const addressShape = (what: string) => ({ address: z.string().describe(`${what} (0x address)`) })
export const poolShape = {
  tokenIn: z.string().describe('Token to sell: BTC, MUSD, MEZO or a 0x token address'),
  tokenOut: z.string().describe('Token to buy: BTC, MUSD, MEZO or a 0x token address'),
  amountIn: z.string().describe('Amount of tokenIn as a plain decimal in token units, for example "1000" or "0.5"'),
  stable: z.boolean().optional().describe('Use the stable-curve pool instead of the volatile one (default false)'),
}
