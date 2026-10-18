// Turns the operator's environment into a buyer for pay_and_fetch, or into a plain reason why payments stay off.
// Payments are opt-in and fail closed: no key file, a key that cannot be read, or limits that do not parse all switch pay_and_fetch off. The read tools never need any of this.
import { privateKeyToAccount } from 'viem/accounts'
import { readKeyFile } from './keys.ts'
import { createBuyer, type Buyer } from './pay.ts'
import { SpendGuard } from './spend.ts'

export type Env = Record<string, string | undefined>

/** The hosts pay_and_fetch may call when MEZO_PAY_ALLOWED_HOSTS is unset or blank: our own endpoint as `npm run serve` starts it, nothing else. */
export const DEFAULT_PAY_HOSTS = ['127.0.0.1:8402', 'localhost:8402']

export function buyerFromEnv(env: Env, chainReader: unknown): { buyer?: Buyer; offReason?: string } {
  if (!env.MEZO_KEY_FILE) return { offReason: 'no wallet is configured (the operator sets MEZO_KEY_FILE to a file that holds a funded Mezo testnet key)' }
  let guard: SpendGuard
  try {
    guard = SpendGuard.fromEnv(env)
  } catch (e) {
    return { offReason: `the spend limits are not valid, so payments stay off: ${(e as Error).message}` }
  }
  let account
  try {
    account = privateKeyToAccount(readKeyFile(env.MEZO_KEY_FILE))
  } catch (e) {
    return { offReason: (e as Error).message } // readKeyFile's messages never echo the path or the key
  }
  const listed = (env.MEZO_PAY_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean)
  // Never "any host": a prompt-injected agent could pay any seller up to the session limit and read any local service.
  const allowedHosts = listed.length > 0 ? listed : DEFAULT_PAY_HOSTS
  return { buyer: createBuyer({ account, chainReader, guard, allowedHosts }) }
}
