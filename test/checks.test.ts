// The repo checks (secret scan, licence check, privacy check) must really fail when they should. Each test builds a throwaway git repo in the
// temp folder, copies one script into it, plants a problem (a fake key, a fake denylist term, a bad licence) and runs the script there. The real
// key files and the real denylist are never used: the scripts get an explicit environment, and values are built at run time so that this file
// does not trip the checks it tests.
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const AT = '@'
const HOME = '/hom' + 'e/alice/project'
const TERM = 'zebracorn' // stands in for a denylist entry

function repo() {
  const base = mkdtempSync(join(tmpdir(), 'mezo-checks-'))
  dirs.push(base)
  const dir = join(base, 'repo') // the repo under test; fake key and denylist files live next to it, in side/
  const side = join(base, 'side')
  mkdirSync(dir)
  mkdirSync(side)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test Person', '-c', `user.email=test${AT}users.noreply.github.com`, '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q')
  mkdirSync(join(dir, 'scripts'))
  return {
    dir,
    side,
    git,
    write: (file: string, text: string) => {
      mkdirSync(join(dir, file, '..'), { recursive: true })
      writeFileSync(join(dir, file), text)
    },
    commit: (message = 'work') => {
      git('add', '-A')
      git('commit', '-q', '-m', message)
    },
    run(script: string, args: string[] = [], env: Record<string, string> = {}) {
      copyFileSync(fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), join(dir, 'scripts', script))
      const r = spawnSync(process.execPath, [join(dir, 'scripts', script), ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } })
      return { code: r.status, out: `${r.stdout}${r.stderr}` }
    },
  }
}

describe('secret scan', () => {
  const key = () => '0x' + randomBytes(32).toString('hex')
  const scan = (r: ReturnType<typeof repo>, secret: string | null, args: string[] = []) => {
    const env: Record<string, string> = { MEZO_PAYEE_KEY_FILE: join(r.side, 'no-such-payee.key') }
    if (secret) {
      env.MEZO_KEY_FILE = join(r.side, 'ops.key')
      writeFileSync(env.MEZO_KEY_FILE, secret + '\n')
    } else env.MEZO_KEY_FILE = join(r.side, 'no-such.key')
    return r.run('secret-scan.mjs', args, env)
  }

  it('passes a clean repo and says the exact-value check ran', () => {
    const r = repo()
    r.write('src/a.ts', 'export const a = 1\n')
    r.commit()
    const s = scan(r, key())
    expect(s.code).toBe(0)
    expect(s.out).toContain('1 key file(s) checked by exact value')
  })

  it('fails on the key value in a tracked file, with or without 0x, in any case, and never prints the value', () => {
    for (const edit of [(k: string) => k, (k: string) => k.slice(2), (k: string) => k.toUpperCase().replace('0X', '0x')]) {
      const r = repo()
      const k = key()
      r.write('src/leak.ts', `const x = "${edit(k)}"\n`)
      r.commit()
      const s = scan(r, k)
      expect(s.code).toBe(1)
      expect(s.out).toContain('LEAK key value in src/leak.ts')
      expect(s.out.toLowerCase()).not.toContain(k.slice(2))
    }
  })

  it('fails on the key in an untracked file that is not ignored, and on a key that only lives in history', () => {
    const r = repo()
    const k = key()
    r.write('a.txt', 'ok\n')
    r.commit()
    r.write('notes.txt', k)
    expect(scan(r, k).code).toBe(1)
    rmSync(join(r.dir, 'notes.txt'))
    expect(scan(r, k).code).toBe(0)
    r.write('old.txt', k)
    r.commit('add by mistake')
    rmSync(join(r.dir, 'old.txt'))
    r.commit('remove again')
    const s = scan(r, k)
    expect(s.code).toBe(1)
    expect(s.out).toContain('git object')
  })

  it('does not count a file that git ignores', () => {
    const r = repo()
    const k = key()
    r.write('.gitignore', '.secrets/\n')
    r.write('.secrets/payee.key', k)
    r.commit()
    expect(scan(r, k).code).toBe(0)
  })

  it('without key files it still finds private-key blocks and key assignments, and --strict refuses to skip the exact-value check', () => {
    const r = repo()
    r.write('a.txt', 'nothing here\n')
    r.commit()
    const quiet = scan(r, null)
    expect(quiet.code).toBe(0)
    expect(quiet.out).toContain('NOT RUN')
    expect(scan(r, null, ['--strict']).code).toBe(1)
    r.write('b.txt', `${'private'}_key = "${key()}"\n`)
    expect(scan(r, null).code).toBe(1)
    r.write('b.txt', `-----BEGIN ${'PRIVATE'} KEY-----\nabc\n`)
    expect(scan(r, null).code).toBe(1)
  })
})

describe('privacy check', () => {
  const check = (r: ReturnType<typeof repo>, args: string[] = [], list: string | null = TERM) => {
    const env: Record<string, string> = { PRIVACY_DENYLIST: join(r.side, 'no-such-denylist.txt') }
    if (list) {
      env.PRIVACY_DENYLIST = join(r.side, 'denylist.txt')
      writeFileSync(env.PRIVACY_DENYLIST, list + '\n')
    }
    return r.run('privacy-check.mjs', args, env)
  }

  it('passes a clean repo', () => {
    const r = repo()
    r.write('a.md', 'hello\n')
    r.commit()
    const c = check(r)
    expect(c.code).toBe(0)
    expect(c.out).toContain('denylist checked')
  })

  it('fails on a denylist term in any case, without printing the term, and on one in the commit author', () => {
    const r = repo()
    r.write('a.md', `Written by ${TERM.toUpperCase()}\n`)
    r.commit()
    const c = check(r)
    expect(c.code).toBe(1)
    expect(c.out).toContain('DENYLIST 1 line(s) in a.md')
    expect(c.out.toLowerCase()).not.toContain(TERM)
    const q = repo()
    q.write('a.md', 'clean\n')
    q.git('add', '-A')
    q.git('-c', `user.name=${TERM} jones`, '-c', `user.email=x${AT}users.noreply.github.com`, 'commit', '-q', '-m', 'work')
    const m = check(q)
    expect(m.code).toBe(1)
    expect(m.out).toContain('commit metadata')
  })

  it('fails on a home path or a personal email, and accepts the noreply addresses', () => {
    const r = repo()
    r.write('a.md', `see ${HOME}/x\n`)
    r.commit()
    expect(check(r).out).toContain('HOME PATH in a.md')
    const q = repo()
    q.write('b.md', `mail me at someone${AT}example.com\n`)
    q.commit()
    expect(check(q).out).toContain('EMAIL (1) in b.md')
    const ok = repo()
    ok.write('c.md', `Co-Authored-By: Claude <noreply${AT}anthropic.com> and 1+x${AT}users.noreply.github.com\n`)
    ok.commit()
    expect(check(ok).code).toBe(0)
  })

  it('does not count ignored files, skips the denylist when it is missing, and --strict then fails', () => {
    const r = repo()
    r.write('.gitignore', 'private/\n')
    r.write('private/x.txt', TERM)
    r.write('a.md', 'fine\n')
    r.commit()
    expect(check(r).code).toBe(0)
    const none = check(r, [], null)
    expect(none.code).toBe(0)
    expect(none.out).toContain('NOT RUN')
    expect(check(r, ['--strict'], null).code).toBe(1)
  })
})

describe('licence check', () => {
  const lock = (packages: Record<string, object>) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } })
  const run = (packages: Record<string, object>) => {
    const r = repo()
    r.write('package-lock.json', lock(packages))
    return r.run('licence-check.mjs')
  }

  it('passes permissive licences, an "OR" with one allowed option, and weak copyleft in a dev-only package', () => {
    expect(run({ 'node_modules/a': { license: 'MIT' }, 'node_modules/b': { license: 'Apache-2.0' }, 'node_modules/c': { license: '(MIT OR GPL-3.0)' }, 'node_modules/d': { license: 'MPL-2.0', dev: true } }).code).toBe(0)
  })

  it('fails on GPL, LGPL and AGPL, on "AND" with a copyleft part, on MPL in production, on an unknown licence and on a missing one', () => {
    for (const bad of ['GPL-3.0', 'LGPL-2.1', 'AGPL-3.0-only', 'MIT AND GPL-2.0', 'MPL-2.0', 'Some-Custom-Licence']) {
      const r = run({ 'node_modules/bad': { license: bad } })
      expect(r.code, bad).toBe(1)
      expect(r.out).toContain('node_modules/bad')
    }
    expect(run({ 'node_modules/none': {} }).out).toContain('no licence found')
    expect(run({ 'node_modules/none': {} }).code).toBe(1)
  })
})
