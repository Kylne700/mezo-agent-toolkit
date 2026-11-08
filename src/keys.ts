// Loads a throwaway testnet key from a file path, inside code only. The key is never printed or logged,
// and every error message here is generic on purpose (a parser error could echo the input).
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

// Relative to the repo: the funded ops key sits next to the repo folder, outside it, and is never committed.
// Functions, not constants: the npm bundle (scripts/build-mcp.mjs) keeps only what the server calls, so these paths stay out of it (test/package.test.ts checks).
const opsDefault = () => fileURLToPath(new URL('../../keys/mezo-testnet-ops.key', import.meta.url))
const payeeDefault = () => fileURLToPath(new URL('../.secrets/payee.key', import.meta.url))

export function readKeyFile(path: string): Hex {
  let raw: string
  try { raw = readFileSync(path, 'utf8').trim() } catch { throw new Error('cannot read the key file (set MEZO_KEY_FILE to a file that holds a 0x private key)') }
  const hex = (raw.startsWith('0x') ? raw : `0x${raw}`)
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error('the key file does not hold a 32-byte hex private key')
  // Warn, do not refuse: the key still loads. stderr only (stdout carries the MCP messages), and never the path.
  try {
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) console.warn('warning: other accounts on this machine can read or change the key file; run chmod 600 on it')
  } catch {
    // The file was just read; a failed stat only skips the warning.
  }
  return hex as Hex
}

/** The funded throwaway key: deployer and x402 buyer. Path from MEZO_KEY_FILE, else the ops key next to the repo. */
export const opsAccount = () => privateKeyToAccount(readKeyFile(process.env.MEZO_KEY_FILE ?? opsDefault()))
/** The payee key (kept only so test MUSD can be moved later; the server needs just its address). */
export const payeeAccount = () => privateKeyToAccount(readKeyFile(process.env.MEZO_PAYEE_KEY_FILE ?? payeeDefault()))
export const keyPaths = () => ({ ops: process.env.MEZO_KEY_FILE ?? opsDefault(), payee: process.env.MEZO_PAYEE_KEY_FILE ?? payeeDefault() })
