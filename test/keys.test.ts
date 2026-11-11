// readKeyFile: a key file that other accounts on the machine can read gets one warning on stderr, never with the path or the key in it,
// and the key still loads (warn, do not refuse). The key is a throwaway generated here.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generatePrivateKey } from 'viem/accounts'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { readKeyFile } from '../src/keys.ts'

const dir = mkdtempSync(join(tmpdir(), 'mezo-keys-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('readKeyFile', () => {
  it.skipIf(process.platform === 'win32')('warns, without the path or the key, when other accounts can read the key file, and still loads it', () => {
    const key = generatePrivateKey()
    const file = join(dir, 'throwaway.key')
    writeFileSync(file, key)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      chmodSync(file, 0o644) // set after writing: the mode passed to writeFileSync is masked by the umask
      expect(readKeyFile(file)).toBe(key)
      expect(warn).toHaveBeenCalledTimes(1)
      const text = String(warn.mock.calls[0]![0])
      expect(text).toMatch(/chmod 600/)
      expect(text).not.toContain(dir)
      expect(text).not.toContain('throwaway.key')
      expect(text.toLowerCase()).not.toContain(key.slice(2).toLowerCase())

      warn.mockClear()
      chmodSync(file, 0o600)
      expect(readKeyFile(file)).toBe(key)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
