// A small transcript helper for the live scripts: prints and keeps every line, counts failed checks, and writes the log file on request.
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

export function createReport() {
  const lines: string[] = []
  let failures = 0
  const log = (s = '') => {
    lines.push(s)
    console.log(s)
  }
  /** One PASS or FAIL line; when it fails, the first `problems` are listed under it. */
  const check = (ok: boolean, what: string, problems: string[] = []) => {
    log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
    if (!ok) {
      failures++
      for (const p of problems.slice(0, 12)) log(`        ${p}`)
    }
    return ok
  }
  return {
    log,
    check,
    /** Passes when there are no problems. */
    verdict: (what: string, problems: string[]) => check(problems.length === 0, what, problems),
    failures: () => failures,
    /** Refuses to write a log that contains the home directory, so a path can never end up in evidence. */
    save(file: string) {
      if (lines.some((l) => l.includes(homedir()))) throw new Error('the log contains the home directory; not written')
      writeFileSync(file, lines.join('\n') + '\n')
    },
  }
}
