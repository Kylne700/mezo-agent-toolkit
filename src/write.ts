// The one write path: every transaction the toolkit signs goes through send(). It stops at the first refusal, in this order:
//   writes on (MEZO_WRITE_ENABLE=testnet, a key file, a receipts file, a valid policy) -> no kill file -> the RPC is on chain 31611
//   -> policy (allow-list, risky flag, caps from the calldata and value) -> eth_call simulation -> gas estimate under the gas cap
//   -> caps again with the worst-case gas fee -> kill file again -> sign locally for chain 31611 -> eth_sendRawTransaction
//   -> receipt -> one JSON line in the receipts file, whatever the outcome after the send.
// Sends run one at a time, also across processes (a lock file next to the receipts file), so two calls cannot share a nonce or both fit under the same daily total.
// The read-only MCP server does not import this file; writes stay off unless the operator turns them on.
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isAddress, isHex, keccak256, type Address, type Hex, type PublicClient } from 'viem'
import { CHAIN_ID } from './config.ts'
import { ALLOW, checkWrite, policyFromEnv, type AllowEntry, type Amounts, type Check, type Env, type Policy } from './policy.ts'
import { appendReceipt, usedOn, type Receipt, type Status } from './receipts.ts'
import { signerFromEnv } from './signer-env.ts'

/** A write is only a call: no caps, amounts or limits ride along (they come from the operator, see policy.ts). */
export interface WriteRequest {
  to: Address
  data: Hex
  value?: bigint
}

export type WriteResult = { sent: false; reason: string } | { sent: true; hash: Hex; status: Status; note?: string }

export interface WriterOptions {
  env: Env
  client: PublicClient
  /** Code-level only (tests and the protocol tools); defaults to ALLOW. */
  allow?: readonly AllowEntry[]
  now?: () => Date
  receiptTimeoutMs?: number
}

const KILLED = 'the kill file exists, so writes are stopped (the operator deletes it to resume)'
const LOCKED =
  "another write is running, or one stopped before its receipt line was written (the write lock next to the receipts file exists): try again in a minute; if none is running, the operator compares the wallet's latest transaction with the receipts file, then deletes the lock"
const short = (e: unknown) => (e as { shortMessage?: string }).shortMessage ?? 'unknown error'

export function createWriter(o: WriterOptions) {
  const env = { ...o.env } // a snapshot: changing process.env later cannot loosen anything
  const now = o.now ?? (() => new Date())
  const client = o.client
  const { account, offReason } = signerFromEnv(env)
  let off = offReason
  let policy: Policy | undefined
  const receipts = env.MEZO_WRITE_RECEIPTS_FILE ?? ''
  if (!off && !receipts) off = 'no receipts file is configured (the operator sets MEZO_WRITE_RECEIPTS_FILE)'
  if (!off) {
    try {
      policy = policyFromEnv(env, o.allow ?? ALLOW)
    } catch (e) {
      off = `the write policy is not valid, so writes stay off: ${(e as Error).message}`
    }
  }
  // The kill path comes from the environment only (never the policy file); by default a STOP file next to the receipts.
  const killFile = env.MEZO_WRITE_KILL_FILE || join(dirname(receipts), 'STOP')
  const unrecorded = new Map<string, Amounts>() // per UTC day: sends whose receipt line could not be written still count
  // Two MCP sessions are two processes on one receipts file. A lock that outlives its send (a killed process, or a line that could not be written)
  // keeps every writer off until the operator checks the chain against the ledger, so that send cannot go uncounted.
  const lockFile = `${receipts}.lock`

  async function sendLocked(req: WriteRequest, lock: { keep: boolean }): Promise<WriteResult> {
    const refuse = (reason: string): WriteResult => ({ sent: false, reason })
    if (off || !account || !policy) return refuse(off ?? 'writes are off')
    const p = policy
    if (existsSync(killFile)) return refuse(KILLED)
    const tx = { to: req.to, data: req.data, value: req.value ?? 0n }
    if (!isAddress(tx.to) || !isHex(tx.data) || tx.data.length < 10 || tx.data.length % 2 !== 0 || typeof tx.value !== 'bigint') {
      return refuse('a write needs a contract address, calldata that starts with a function selector, and a bigint value')
    }
    let chainId: number
    try {
      chainId = await client.getChainId()
    } catch (e) {
      return refuse(`cannot read the chain id: ${short(e)}`)
    }
    if (chainId !== CHAIN_ID) return refuse(`the RPC is on chain ${chainId}, not Mezo testnet (${CHAIN_ID})`)

    const at = now()
    const day = at.toISOString().slice(0, 10)
    const check = (fee?: bigint): Check => {
      try {
        const u = usedOn(receipts, day)
        const x = unrecorded.get(day) ?? { musd: 0n, btc: 0n }
        return checkWrite(p, tx, { musd: u.musd + x.musd, btc: u.btc + x.btc }, fee)
      } catch (e) {
        return { ok: false, reason: (e as Error).message }
      }
    }
    const first = check()
    if (!first.ok) return refuse(first.reason)

    const from = account.address
    try {
      await client.call({ account: from, ...tx })
    } catch (e) {
      return refuse(`the simulation reverted, so nothing was sent: ${short(e)}`)
    }
    let estimate: bigint
    try {
      estimate = await client.estimateGas({ account: from, ...tx })
    } catch (e) {
      return refuse(`gas estimation failed, so nothing was sent: ${short(e)}`)
    }
    if (estimate > p.maxGas) return refuse(`the call needs ${estimate} gas, over the gas cap of ${p.maxGas}`)
    const gas = (estimate * 6n) / 5n < p.maxGas ? (estimate * 6n) / 5n : p.maxGas
    let nonce: number
    let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
    try {
      ;[nonce, fees] = await Promise.all([client.getTransactionCount({ address: from, blockTag: 'pending' }), client.estimateFeesPerGas()])
    } catch (e) {
      return refuse(`cannot read the nonce or the gas price, so nothing was sent: ${short(e)}`)
    }
    const final = check(gas * fees.maxFeePerGas)
    if (!final.ok) return refuse(final.reason)
    if (existsSync(killFile)) return refuse(KILLED)

    // Signed here with the chain id from config (EIP-155), never the RPC's answer, and sent as raw bytes.
    const raw = await account.signTransaction({
      chainId: CHAIN_ID,
      type: 'eip1559',
      ...tx,
      gas,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    })
    const hash = keccak256(raw)
    let status: Status = 'unknown'
    let note: string | undefined
    try {
      await client.sendRawTransaction({ serializedTransaction: raw })
      status = (await client.waitForTransactionReceipt({ hash, timeout: o.receiptTimeoutMs ?? 120_000 })).status
    } catch (e) {
      note = short(e) // the tx may or may not be on chain: it is recorded as unknown and counts against the caps
    }
    const line: Receipt = {
      at: at.toISOString(),
      name: final.entry.name,
      from,
      to: tx.to,
      selector: tx.data.slice(0, 10) as Hex,
      nonce,
      hash,
      status,
      musd: final.musd.toString(),
      btc: final.btc.toString(),
      gas: gas.toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(),
      ...(note ? { note } : {}),
    }
    try {
      appendReceipt(receipts, line)
    } catch {
      const x = unrecorded.get(day) ?? { musd: 0n, btc: 0n }
      unrecorded.set(day, { musd: x.musd + final.musd, btc: x.btc + final.btc })
      lock.keep = true
      note = `${note ? `${note}; ` : ''}the receipt line could not be written (this process still counts it, and the write lock stays until the operator records it)`
    }
    return { sent: true, hash, status, ...(note ? { note } : {}) }
  }

  async function sendOne(req: WriteRequest): Promise<WriteResult> {
    if (off || !account || !policy) return { sent: false, reason: off ?? 'writes are off' }
    let fd: number
    try {
      mkdirSync(dirname(receipts), { recursive: true })
      fd = openSync(lockFile, 'wx', 0o600)
    } catch (e) {
      return { sent: false, reason: (e as { code?: string }).code === 'EEXIST' ? LOCKED : 'cannot create the write lock next to the receipts file, so nothing was sent' }
    }
    const lock = { keep: false }
    try {
      return await sendLocked(req, lock)
    } finally {
      try {
        closeSync(fd)
        if (!lock.keep) unlinkSync(lockFile)
      } catch {
        // A lock that cannot be removed only keeps writes off; the result of this send must still come back.
      }
    }
  }

  let queue: Promise<unknown> = Promise.resolve()
  return {
    address: account?.address as Address | undefined,
    offReason: off,
    send(req: WriteRequest): Promise<WriteResult> {
      const run = queue.then(() => sendOne(req))
      queue = run.catch(() => undefined)
      return run
    },
  }
}
