// Copied from the author's own MIT-licensed Sealdrop video chain (github.com/Kylne700/sealdrop).
// Small helpers shared by the video scripts: process runner, WAV reader, privacy counter.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DENYLIST } from './config.mjs'

/** Runs a command; resolves {code, stdout, stderr}. Rejects on a non-zero exit unless `ok` lists the allowed codes. */
export function run(cmd, args = [], { input, cwd, env, ok = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const out = [], err = []
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', (d) => err.push(d))
    p.on('error', reject)
    p.on('close', (code) => {
      const r = { code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }
      if (!ok.includes(code)) reject(new Error(`${cmd} ${args.slice(0, 6).join(' ')} exit ${code}: ${r.stderr.slice(-600)}`))
      else resolve(r)
    })
    p.stdin.on('error', () => {})
    p.stdin.end(input ?? '')
  })
}

export const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16)

/** Sample count of a 48 kHz mono PCM WAV (walks the chunks; ffmpeg may add a LIST chunk before `data`). */
export function wavSamples(path) {
  const b = readFileSync(path)
  for (let i = 12; i + 8 <= b.length;) {
    const id = b.toString('ascii', i, i + 4), size = b.readUInt32LE(i + 4)
    if (id === 'data') return Math.min(size, b.length - i - 8) / 2
    i += 8 + size + (size & 1)
  }
  throw new Error(`no data chunk in ${path}`)
}

/** Number of lines of `text` that match the privacy denylist (counts only; the list itself is never printed). */
export async function denyCount(text) {
  const r = await run('grep', ['-c', '-i', '-F', '-f', DENYLIST], { input: text, ok: [0, 1] })
  return Number(r.stdout.trim())
}
export async function denyCountFile(path) {
  const r = await run('grep', ['-c', '-i', '-F', '-f', DENYLIST, path], { ok: [0, 1] })
  return Number(r.stdout.trim())
}
export const round3 = (x) => Math.round(x * 1000) / 1000
