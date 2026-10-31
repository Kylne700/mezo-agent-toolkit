// The npm package as a user gets it: `npm pack` holds the bundle and nothing else, the bundle carries no local key path and no key,
// and its command line and stdio server start from a directory outside the repo (no tsx, no checkout). The doctor talks to a fake RPC, so the suite stays offline.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Hex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pkg from '../package.json' with { type: 'json' }

const pexec = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const bundle = join(root, 'dist', 'mcp.js')
let outside = '' // a directory outside the repository
const rpcs: Server[] = []

/** A JSON-RPC node that answers eth_chainId and eth_blockNumber, which is all the doctor asks. */
async function fakeRpc(chainId: string): Promise<string> {
  const reply = (r: { id: number; method: string }) => ({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_chainId' ? chainId : '0x10' })
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d: Buffer) => (body += d.toString()))
    req.on('end', () => {
      const j = JSON.parse(body)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(Array.isArray(j) ? j.map(reply) : reply(j)))
    })
  })
  rpcs.push(server)
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** Runs the bundle from `outside` with a clean environment, so no MEZO_KEY_FILE of the developer's shell reaches it. */
async function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  try {
    const r = await pexec(process.execPath, [bundle, ...args], { cwd: outside, env: { ...getDefaultEnvironment(), ...env } })
    return { code: 0, out: r.stdout + r.stderr }
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof x.code === 'number' ? x.code : -1, out: (x.stdout ?? '') + (x.stderr ?? '') }
  }
}

beforeAll(async () => {
  await pexec(process.execPath, [join(root, 'scripts', 'build-mcp.mjs')], { cwd: root }) // dist/ is not committed
  outside = mkdtempSync(join(tmpdir(), 'mezo-pkg-test-'))
}, 120_000)

afterAll(async () => {
  rmSync(outside, { recursive: true, force: true })
  await Promise.all(rpcs.map((s) => new Promise((ok) => { s.closeAllConnections(); s.close(ok) })))
})

describe('the npm package', () => {
  it('packs the bundle, README, LICENSE and server.json and nothing else', async () => {
    const { stdout } = await pexec('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, env: { ...process.env, npm_config_update_notifier: 'false' } })
    const files = (JSON.parse(stdout) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path).sort()
    expect(files).toEqual(['LICENSE', 'README.md', 'dist/mcp.js', 'package.json', 'server.json'])
    expect(pkg.bin['mezo-agent-toolkit']).toBe('dist/mcp.js')
    expect(readFileSync(bundle, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true)
  }, 60_000)

  it('server.json and package.json agree on name and version', () => {
    const s = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8')) as { name: string; version: string; packages: unknown[] }
    expect(s.name).toBe(pkg.mcpName)
    expect(s.version).toBe(pkg.version)
    expect(s.packages).toEqual([expect.objectContaining({ registryType: 'npm', identifier: pkg.name, version: pkg.version })])
  })

  // Failure messages are fixed text on purpose: a matcher would print the whole bundle, and a key with it.
  it('the bundle holds no local key path and no private key', () => {
    const text = readFileSync(bundle, 'utf8')
    for (const s of ['mezo-testnet-ops', 'payee.key', '.secrets', 'keys/']) expect(text.includes(s), `the bundle contains "${s}", a default key location of src/keys.ts`).toBe(false)
    expect(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), 'the bundle contains a PEM private key').toBe(false)
    expect(/(private[_ -]?key|secret[_ -]?key|mnemonic|seed[_ -]?phrase)["']?\s*[:=]\s*["']?(0x)?[0-9a-f]{64}\b/i.test(text), 'the bundle assigns a 64-hex value to a key-like name').toBe(false)
    // 64-hex values are everywhere (curve constants, a transaction hash), so ask what matters: is one of them the key of an address that the bundle names?
    const named = new Set((text.match(/0x[0-9a-fA-F]{40}\b/g) ?? []).map((a) => a.toLowerCase()))
    expect(named.size, 'the scan found no address in the bundle, so it checks nothing').toBeGreaterThan(0)
    for (const t of new Set(text.match(/\b(?:0x)?[0-9a-fA-F]{64}\b/g) ?? [])) {
      let address: string
      try { address = privateKeyToAddress((t.startsWith('0x') ? t : `0x${t}`) as Hex) } catch { continue } // not a valid key
      expect(named.has(address.toLowerCase()), 'a 64-hex value in the bundle is the private key of an address named in the bundle').toBe(false)
    }
  })
})

describe('the command line of the bundle, run from a directory outside the repo', () => {
  it('prints its version and its help', async () => {
    expect((await run(['--version'])).out.trim()).toBe(pkg.version)
    expect((await run(['--help'])).out).toMatch(/--doctor/)
  })

  it('--doctor exits 0 on chain 31611 and reports that payments are off without a key', async () => {
    const r = await run(['--doctor'], { MEZO_RPC_URL: await fakeRpc('0x7b7b') }) // 0x7b7b = 31611
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/ok\s+rpc/)
    expect(r.out).toMatch(/ok\s+chain id\s+31611/)
    expect(r.out).toMatch(/ok\s+tools\s+\d+: .*trove_health/)
    expect(r.out).toMatch(/writes\s+enabled: no/)
  })

  it('--doctor exits 1 and says why when the RPC is on another chain', async () => {
    const r = await run(['--doctor'], { MEZO_RPC_URL: await fakeRpc('0x1') })
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/FAIL\s+chain id\s+1, expected 31611/)
  })

  it('--doctor exits 1 on an unreachable RPC and does not print the path of its URL', async () => {
    const r = await run(['--doctor'], { MEZO_RPC_URL: 'http://127.0.0.1:1/v1/PATH-THAT-HOLDS-A-KEY' })
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/FAIL\s+rpc/)
    expect(r.out).not.toContain('PATH-THAT-HOLDS-A-KEY')
  })

  it('starts over stdio, lists the read tools and reports the package version', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [bundle], cwd: outside, env: getDefaultEnvironment(), stderr: 'pipe' })
    const client = new Client({ name: 'test', version: '0.0.0' })
    let stderr = ''
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    try {
      await client.connect(transport)
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['trove_health', 'redemption_risk', 'pool_quote', 've_locks', 'pay_and_fetch', 'plan_open', 'plan_top_up', 'plan_repay', 'trove_status']))
      expect(client.getServerVersion()?.version).toBe(pkg.version)
      expect(stderr).toMatch(/"event":"mcp-ready"/)
    } finally {
      await client.close()
    }
  }, 60_000)
})
