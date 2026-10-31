// The write path against a mocked RPC: every refusal must stop before eth_sendRawTransaction (and those before the
// simulation before eth_call too); the happy path must sign exactly what it simulated. No network, no real transaction:
// the key is a throwaway generated here.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256, parseTransaction, recoverTransactionAddress, toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterAll, describe, expect, it } from 'vitest'
import { ADDRESSES } from '../src/config.ts'
import { DEFAULT_MAX_GAS } from '../src/policy.ts'
import { createWriter, type WriteResult } from '../src/write.ts'
import { addColl, allow, caps, mockRpc, pay, transfer, u } from './helpers/write.ts'

const root = mkdtempSync(join(tmpdir(), 'mezo-write-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const key = generatePrivateKey()
const keyFile = join(root, 'throwaway.key')
writeFileSync(keyFile, key, { mode: 0o600 })
const me = privateKeyToAccount(key).address
const NOW = new Date('2026-11-02T12:00:00.000Z')

/** A fresh folder per test, so each one has its own receipts ledger and kill file. */
function setup(extraEnv: Record<string, string | undefined> = {}, rpc = mockRpc()) {
  const dir = mkdtempSync(join(root, 'case-'))
  const receipts = join(dir, 'receipts.jsonl')
  const env = { MEZO_WRITE_ENABLE: 'testnet', MEZO_KEY_FILE: keyFile, MEZO_WRITE_RECEIPTS_FILE: receipts, ...caps, ...extraEnv }
  const w = createWriter({ env, client: rpc.client, allow, now: () => NOW, receiptTimeoutMs: 200 })
  const lines = () => (existsSync(receipts) ? readFileSync(receipts, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  return { w, rpc, dir, receipts, lines }
}
const refused = (r: WriteResult) => (r.sent ? 'sent' : r.reason)
const noSend = (rpc: ReturnType<typeof mockRpc>) => expect(rpc.methods()).not.toContain('eth_sendRawTransaction')
const noCall = (rpc: ReturnType<typeof mockRpc>) => expect(rpc.methods()).not.toContain('eth_call')

describe('writes stay off unless the operator turns them on', () => {
  it('without MEZO_WRITE_ENABLE=testnet nothing is read, simulated or sent', async () => {
    for (const v of [undefined, '', '1', 'true', 'mainnet', 'TESTNET']) {
      const { w, rpc, lines } = setup({ MEZO_WRITE_ENABLE: v })
      expect(w.offReason).toMatch(/writes are off/)
      expect(refused(await w.send(pay('0.1')))).toMatch(/writes are off \(the operator sets MEZO_WRITE_ENABLE=testnet/)
      expect(rpc.calls).toEqual([])
      expect(lines()).toEqual([])
    }
  })

  it('no key file, an unreadable key, no receipts file or an invalid policy also keep writes off', async () => {
    const cases: [Record<string, string | undefined>, RegExp][] = [
      [{ MEZO_KEY_FILE: undefined }, /no wallet is configured/],
      [{ MEZO_KEY_FILE: join(root, 'missing.key') }, /cannot read the key file/],
      [{ MEZO_WRITE_RECEIPTS_FILE: undefined }, /no receipts file is configured/],
      [{ MEZO_WRITE_MAX_MUSD_PER_CALL: '5' }, /write policy is not valid.*per-call cap cannot be larger/],
      [{ MEZO_POLICY_FILE: join(root, 'missing.json') }, /write policy is not valid.*cannot be read as JSON/],
    ]
    for (const [env, why] of cases) {
      const { w, rpc } = setup(env)
      expect(refused(await w.send(pay('0.1')))).toMatch(why)
      expect(rpc.calls).toEqual([])
    }
  })
})

describe('every refusal stops before the transaction is sent', () => {
  it('wrong chain: refused after eth_chainId, nothing simulated or sent', async () => {
    const { w, rpc } = setup({}, mockRpc({ eth_chainId: () => toHex(1) }))
    expect(refused(await w.send(pay('0.1')))).toMatch(/the RPC is on chain 1, not Mezo testnet \(31611\)/)
    expect(rpc.methods()).toEqual(['eth_chainId'])
  })

  it('a contract or a selector that is not on the allow-list: refused before the simulation', async () => {
    const { w, rpc } = setup()
    expect(refused(await w.send(pay('0.1', 'transfer', ADDRESSES.btc)))).toMatch(/no allow-list entry for selector 0xa9059cbb on 0x7b7C/)
    expect(refused(await w.send({ to: ADDRESSES.musd, data: '0x23b872dd' }))).toMatch(/no allow-list entry for selector 0x23b872dd/)
    noCall(rpc)
    noSend(rpc)
  })

  it('over the per-call MUSD or BTC cap: refused before the simulation', async () => {
    const { w, rpc } = setup()
    expect(refused(await w.send(pay('1.5')))).toMatch(/1.5 MUSD is over the per-call cap of 1 MUSD/)
    expect(refused(await w.send(addColl('0.02')))).toMatch(/0.02 BTC \(gas fee included\) is over the per-call cap of 0.01 BTC/)
    noCall(rpc)
    noSend(rpc)
  })

  it('over the per-day cap: counts today\'s receipts (any status), not yesterday\'s', async () => {
    const { w, rpc, receipts } = setup()
    const line = (at: string, musd: string, status: string) => JSON.stringify({ at, status, musd: u(musd).toString(), btc: '0' })
    writeFileSync(receipts, `${[line('2026-11-01T23:59:59.000Z', '2', 'success'), line('2026-11-02T00:10:00.000Z', '1', 'success'), line('2026-11-02T09:00:00.000Z', '0.8', 'unknown')].join('\n')}\n`)
    expect(refused(await w.send(pay('0.5')))).toMatch(/would pass the per-day cap of 2 MUSD \(0.2 MUSD left today\)/)
    noCall(rpc)
    expect((await w.send(pay('0.2'))).sent).toBe(true)
  })

  it('a risky action without MEZO_WRITE_RISKY=1: refused before the simulation; with it, sent', async () => {
    const off = setup()
    expect(refused(await off.w.send(pay('0.1', 'approve')))).toMatch(/musd.approve is a risky action, refused unless the operator sets MEZO_WRITE_RISKY=1/)
    noCall(off.rpc)
    noSend(off.rpc)
    const on = setup({ MEZO_WRITE_RISKY: '1' })
    expect((await on.w.send(pay('0.1', 'approve'))).sent).toBe(true)
  })

  it('kill file present (the env path, or the default STOP next to the receipts): nothing is read or sent', async () => {
    const named = setup({ MEZO_WRITE_KILL_FILE: join(root, 'kill-now') })
    writeFileSync(join(root, 'kill-now'), '')
    expect(refused(await named.w.send(pay('0.1')))).toMatch(/the kill file exists/)
    expect(named.rpc.calls).toEqual([])
    rmSync(join(root, 'kill-now'))
    const byDefault = setup()
    writeFileSync(join(byDefault.dir, 'STOP'), '')
    expect(refused(await byDefault.w.send(pay('0.1')))).toMatch(/the kill file exists/)
    expect(byDefault.rpc.calls).toEqual([])
  })

  it('kill file created while a write is being checked: refused before signing', async () => {
    let dir = ''
    const s = setup({}, mockRpc({ eth_estimateGas: () => (writeFileSync(join(dir, 'STOP'), ''), toHex(100_000)) }))
    dir = s.dir
    expect(refused(await s.w.send(pay('0.1')))).toMatch(/the kill file exists/)
    expect(s.rpc.methods()).toContain('eth_estimateGas')
    noSend(s.rpc)
  })

  it('a policy file cannot loosen the env caps or the risky flag', async () => {
    const dir = mkdtempSync(join(root, 'policy-'))
    writeFileSync(join(dir, 'policy.json'), JSON.stringify({ maxMusdPerCall: '100', maxMusdPerDay: '100', maxBtcPerCall: '1', maxBtcPerDay: '1', maxGas: 99_000_000, risky: true }))
    const { w, rpc } = setup({ MEZO_POLICY_FILE: join(dir, 'policy.json') })
    expect(refused(await w.send(pay('1.5')))).toMatch(/over the per-call cap of 1 MUSD/)
    expect(refused(await w.send(addColl('0.5')))).toMatch(/over the per-call cap of 0.01 BTC/)
    expect(refused(await w.send(pay('0.1', 'approve')))).toMatch(/risky action/)
    noSend(rpc)
  })

  it('caps or amounts passed along with a request are ignored', async () => {
    const { w, rpc } = setup()
    const sneaky = { ...pay('1.5'), musd: 0n, maxMusdPerCall: '1000', MEZO_WRITE_MAX_MUSD_PER_CALL: '1000', caps: { musdPerCall: 10n ** 30n }, risky: true }
    expect(refused(await w.send(sneaky as never))).toMatch(/1.5 MUSD is over the per-call cap of 1 MUSD/)
    expect(refused(await w.send({ ...pay('0.1', 'approve'), MEZO_WRITE_RISKY: '1' } as never))).toMatch(/risky action/)
    noSend(rpc)
  })

  it('an entry that declares no amount cannot hide the BTC sent as tx value', async () => {
    const { w, rpc } = setup()
    expect(refused(await w.send(addColl('0.011')))).toMatch(/0.011 BTC \(gas fee included\) is over the per-call cap of 0.01 BTC/)
    noSend(rpc)
  })

  it('simulation revert: refused, nothing sent, no receipt line', async () => {
    const revert = () => {
      throw Object.assign(new Error('execution reverted: BorrowerOps: An operation that would result in ICR < MCR is not permitted'), { code: 3, data: '0x' })
    }
    const { w, rpc, lines } = setup({}, mockRpc({ eth_call: revert }))
    expect(refused(await w.send(pay('0.1')))).toMatch(/the simulation reverted, so nothing was sent/)
    expect(rpc.methods()).toContain('eth_call')
    expect(rpc.methods()).not.toContain('eth_estimateGas')
    noSend(rpc)
    expect(lines()).toEqual([])
  })

  it('a gas estimate over the gas cap: refused, nothing sent', async () => {
    const { w, rpc } = setup({}, mockRpc({ eth_estimateGas: () => toHex(DEFAULT_MAX_GAS + 1n) }))
    expect(refused(await w.send(pay('0.1')))).toMatch(/needs 3000001 gas, over the gas cap of 3000000/)
    noSend(rpc)
  })

  it('the worst-case gas fee counts against the BTC cap (a lying fee quote cannot drain the wallet)', async () => {
    const pricey = { number: '0x64', hash: `0x${'11'.repeat(32)}`, timestamp: '0x6900', baseFeePerGas: toHex(10n ** 14n), transactions: [] }
    const { w, rpc } = setup({}, mockRpc({ eth_getBlockByNumber: () => pricey }))
    expect(refused(await w.send(pay('0.1')))).toMatch(/BTC \(gas fee included\) is over the per-call cap of 0.01 BTC/)
    expect(rpc.methods()).toContain('eth_estimateGas')
    noSend(rpc)
  })

  it('a receipts line it cannot read stops writes instead of being skipped', async () => {
    const { w, rpc, receipts } = setup()
    writeFileSync(receipts, '{"at":"2026-11-02T01:00:00.000Z","musd":"1"\n')
    expect(refused(await w.send(pay('0.1')))).toMatch(/line 1 of the receipts file is not a valid receipt/)
    noCall(rpc)
    noSend(rpc)
  })
})

describe('the happy path (mocked RPC, no real transaction)', () => {
  it('signs exactly what it simulated, for chain 31611, under the gas cap, and appends one receipt line', async () => {
    const { w, rpc, lines } = setup()
    const req = pay('0.5')
    const r = await w.send(req)
    expect(r).toMatchObject({ sent: true, status: 'success' })
    expect(w.address).toBe(me)
    const call = rpc.calls.find((c) => c.method === 'eth_call')!.params[0]
    const [raw] = rpc.raws()
    const tx = parseTransaction(raw)
    expect(tx).toMatchObject({ type: 'eip1559', chainId: 31611, data: req.data, nonce: 7, gas: 120_000n })
    expect(tx.value ?? 0n).toBe(0n)
    // The signed to/data/value are the simulated ones, from the signing address.
    expect([tx.to?.toLowerCase(), call.to.toLowerCase(), call.data, BigInt(call.value ?? 0), call.from.toLowerCase()]).toEqual([req.to.toLowerCase(), req.to.toLowerCase(), req.data, 0n, me.toLowerCase()])
    expect(tx.gas! <= DEFAULT_MAX_GAS).toBe(true)
    expect(tx.maxFeePerGas).toBe(13_000_000n) // base fee 0.01 gwei x 1.2 + tip 0.001 gwei
    expect(r.sent && r.hash).toBe(keccak256(raw))
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(me)
    expect(lines()).toEqual([
      { at: NOW.toISOString(), name: transfer.name, from: me, to: req.to, selector: transfer.selector, nonce: 7, hash: keccak256(raw), status: 'success', musd: u('0.5').toString(), btc: (120_000n * 13_000_000n).toString(), gas: '120000', maxFeePerGas: '13000000' },
    ])
  })

  it('sends value as BTC and counts it with the fee; a reverted tx is recorded as reverted', async () => {
    const reverted = mockRpc({ eth_getTransactionReceipt: ([hash]) => ({ transactionHash: hash, blockNumber: '0x65', blockHash: `0x${'33'.repeat(32)}`, transactionIndex: '0x0', gasUsed: '0x5208', cumulativeGasUsed: '0x5208', logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x0', type: '0x2' }) })
    const { w, rpc, lines } = setup({}, reverted)
    const r = await w.send(addColl('0.004'))
    expect(r).toMatchObject({ sent: true, status: 'reverted' })
    expect(parseTransaction(rpc.raws()[0]).value).toBe(u('0.004'))
    expect(lines()[0]).toMatchObject({ name: 'liar', status: 'reverted', btc: (u('0.004') + 120_000n * 13_000_000n).toString() })
  })

  it('a send error or a receipt timeout is recorded as unknown and still counts toward the day', async () => {
    const failing = mockRpc({
      eth_sendRawTransaction: () => {
        throw Object.assign(new Error('connection reset'), { code: -32000 })
      },
    })
    const a = setup({ MEZO_WRITE_MAX_MUSD_PER_DAY: '1' }, failing)
    expect(await a.w.send(pay('0.6'))).toMatchObject({ sent: true, status: 'unknown' })
    expect(a.lines()).toMatchObject([{ status: 'unknown', musd: u('0.6').toString() }])
    expect(refused(await a.w.send(pay('0.6')))).toMatch(/per-day cap of 1 MUSD \(0.4 MUSD left today\)/)

    const silent = mockRpc({ eth_getTransactionReceipt: () => null, eth_getTransactionByHash: () => null })
    const b = setup({}, silent)
    expect(await b.w.send(pay('0.1'))).toMatchObject({ sent: true, status: 'unknown' })
    expect(b.lines()).toMatchObject([{ status: 'unknown' }])
  })

  it('sends run one at a time: concurrent calls get their own nonces and cannot share the daily cap', async () => {
    const { w, rpc, lines } = setup()
    const results = await Promise.all([w.send(pay('0.9')), w.send(pay('0.9')), w.send(pay('0.9'))])
    expect(results.map((r) => r.sent)).toEqual([true, true, false])
    expect(refused(results[2])).toMatch(/per-day cap of 2 MUSD/)
    expect(rpc.raws().map((raw) => parseTransaction(raw).nonce)).toEqual([7, 8])
    expect(lines().map((l: { nonce: number }) => l.nonce)).toEqual([7, 8])
  })
})

// The core checks the key file once, at start-up, and never puts the key in a result or a receipt line.
describe('the key stays out of results and receipts', () => {
  it('no result or receipt line contains the key', async () => {
    const { w, receipts } = setup()
    const r = await w.send(pay('0.1'))
    const keyHex = (key as Hex).slice(2).toLowerCase()
    expect(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).toLowerCase()).not.toContain(keyHex)
    expect(readFileSync(receipts, 'utf8').toLowerCase()).not.toContain(keyHex)
  })
})

