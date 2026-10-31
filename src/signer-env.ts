// Turns the operator's environment into the signing account of the write path, or into a plain reason why writes stay off.
// Off by default: writes need MEZO_WRITE_ENABLE=testnet and a key FILE path (MEZO_KEY_FILE, the same wallet pay_and_fetch uses).
// There is no default key path here, so nothing signs unless the operator names the file.
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { readKeyFile } from './keys.ts'
import type { Env } from './policy.ts'

export function signerFromEnv(env: Env): { account?: PrivateKeyAccount; offReason?: string } {
  if (env.MEZO_WRITE_ENABLE !== 'testnet') return { offReason: 'writes are off (the operator sets MEZO_WRITE_ENABLE=testnet to allow Mezo testnet writes)' }
  if (!env.MEZO_KEY_FILE) return { offReason: 'no wallet is configured (the operator sets MEZO_KEY_FILE to a file that holds a Mezo testnet key)' }
  try {
    return { account: privateKeyToAccount(readKeyFile(env.MEZO_KEY_FILE)) }
  } catch (e) {
    return { offReason: (e as Error).message } // readKeyFile's messages never echo the path or the key
  }
}
