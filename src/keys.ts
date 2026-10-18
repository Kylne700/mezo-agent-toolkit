// Loads a throwaway testnet key from a file path, inside code only. The key is never printed or logged,
// and every error message here is generic on purpose (a parser error could echo the input).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

// Relative to the repo: the funded ops key sits next to the repo folder, outside it, and is never committed.
const OPS_DEFAULT = fileURLToPath(new URL('../../keys/mezo-testnet-ops.key', import.meta.url))
const PAYEE_DEFAULT = fileURLToPath(new URL('../.secrets/payee.key', import.meta.url))

export function readKeyFile(path: string): Hex {
  let raw: string
  try { raw = readFileSync(path, 'utf8').trim() } catch { throw new Error('cannot read the key file (set MEZO_KEY_FILE to a file that holds a 0x private key)') }
  const hex = (raw.startsWith('0x') ? raw : `0x${raw}`)
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('the key file does not hold a 32-byte hex private key')
  return hex as Hex
}

/** The funded throwaway key: deployer and x402 buyer. Path from MEZO_KEY_FILE, else the ops key next to the repo. */
export const opsAccount = () => privateKeyToAccount(readKeyFile(process.env.MEZO_KEY_FILE ?? OPS_DEFAULT))
/** The payee key (kept only so test MUSD can be moved later; the server needs just its address). */
export const payeeAccount = () => privateKeyToAccount(readKeyFile(process.env.MEZO_PAYEE_KEY_FILE ?? PAYEE_DEFAULT))
export const keyPaths = () => ({ ops: process.env.MEZO_KEY_FILE ?? OPS_DEFAULT, payee: process.env.MEZO_PAYEE_KEY_FILE ?? PAYEE_DEFAULT })
