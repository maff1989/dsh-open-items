#!/usr/bin/env node
/**
 * One-command M1 acceptance run.
 *
 *     node scripts/acceptance.mjs            # report; target is informational
 *     node scripts/acceptance.mjs --strict   # fail when the ≤20 target is missed
 *     node scripts/acceptance.mjs --max-sessions 50
 *     node scripts/acceptance.mjs --json     # machine-readable report
 *
 * Reads `$DSH_HOME` sessions read-only through `zstdcat`, runs the capture folds
 * (skipping with a clear message when the capture branch is not merged yet), and
 * prints the short report used by the M1 gate and the release checklist.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LAST_RUN_PATH = join(ROOT, 'tests', 'acceptance', 'last-run.json')
const VITEST = join(ROOT, 'node_modules', '.bin', 'vitest')

const argv = process.argv.slice(2)
const strict = argv.includes('--strict')
const jsonOnly = argv.includes('--json')
const maxIndex = argv.indexOf('--max-sessions')
const maxSessions = maxIndex >= 0 ? argv[maxIndex + 1] : undefined

const env = {
  ...process.env,
  OI_ACCEPTANCE: '1',
  ...(strict ? { OI_ACCEPTANCE_STRICT: '1' } : {}),
  ...(maxSessions === undefined ? {} : { OI_ACCEPTANCE_MAX_SESSIONS: maxSessions }),
}

let exitCode = 0
let stdoutTail = ''
try {
  const result = await execFileAsync(VITEST, ['run', 'tests/acceptance', '--reporter=dot'], {
    cwd: ROOT,
    env,
    maxBuffer: 32 * 1024 * 1024,
  })
  stdoutTail = result.stdout.trim().split('\n').slice(-8).join('\n')
} catch (error) {
  exitCode = typeof error.code === 'number' ? error.code : 1
  stdoutTail = String(error.stdout ?? '').trim().split('\n').slice(-12).join('\n')
  const stderr = String(error.stderr ?? '').trim()
  if (stderr !== '') console.error(stderr.split('\n').slice(-5).join('\n'))
}

let report
try {
  report = JSON.parse(await readFile(LAST_RUN_PATH, 'utf8'))
} catch {
  console.error('acceptance: no tests/acceptance/last-run.json was written; the suite itself failed:')
  if (stdoutTail !== '') console.error(stdoutTail)
  process.exit(exitCode === 0 ? 1 : exitCode)
}

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(exitCode)
}

if (report.skipped !== undefined) {
  console.log('Open Items M1 acceptance — SKIPPED')
  console.log(`  reason: ${report.skipped}`)
  console.log(`  probes: ${(report.capture?.probes ?? []).join('; ') || '(none)'}`)
  console.log(`  corpus: ${report.corpus?.filesFound ?? 0} session log(s) under ${report.corpus?.sessionsRoot ?? '?'}`)
  console.log('  This is expected until the capture branch is merged; the acceptance suite will fold it automatically then.')
  process.exit(strict ? 2 : 0)
}

const kinds = Object.entries(report.counts.perKind ?? {})
  .sort((left, right) => right[1] - left[1])
  .map(([kind, count]) => `${kind}=${count}`)
  .join(', ') || '(none)'
const met = report.target.met ? 'MET' : 'MISSED'
const familyClosures = report.invariants?.familyClosures ?? []
console.log('Open Items M1 acceptance — real corpus')
console.log(`  adapter: ${report.capture.adapter ?? '(none)'}`)
console.log(
  `  corpus: ${report.corpus.filesFound} file(s), ${report.corpus.sessionsRead} read`
  + ` (${report.corpus.nonRootExcluded} non-root excluded, ${report.corpus.seededSessions} seeded),`
  + ` ${report.corpus.eventsTotal} events (${report.corpus.inheritedEventsCut} inherited cut)`,
)
console.log(`  workspace membership: ${report.corpus.workspaceCount} workspace(s)`)
console.log(`  per-kind: ${kinds}`)
console.log(
  `  structural items: ${report.counts.structural} open at log end (target ≤${report.target.maxStructural} — ${met};`
  + ` candidate=${report.counts.candidate}, raised=${report.counts.raisedArtifacts ?? '?'},`
  + ` closed=${report.counts.closedArtifacts ?? '?'}, closures=${report.counts.closures})`,
)
console.log('  closure map (declared capability; observed in this fold):')
for (const family of familyClosures) {
  const closer = (family.closers ?? []).length === 0 ? '(none)' : family.closers.join(' | ')
  console.log(
    `    ${family.family}: ${family.policy} ${closer}`
    + ` — raised=${family.raised}, open=${family.open}, closures=${family.closures}`,
  )
}
console.log(
  `  invariants: root-only violations=${report.invariants.rootOnlyViolations.length},`
  + ` todo-derived=${report.invariants.todoDerived.length}`
  + ` (needs-you=${(report.invariants.todoDerivedNeedsYou ?? []).length}),`
  + ` no unconditional detector closer=${report.invariants.noClosureDetector.length},`
  + ` unclassified families=${(report.invariants.unclassifiedArtifacts ?? []).length}`,
)
const userClosable = report.invariants.noClosureDetector.slice(0, 5)
if (userClosable.length > 0) {
  console.log('  user-closable rows (no later log evidence):')
  for (const row of userClosable) console.log(`    ${row.family} (${row.policy}): ${row.artifactId}`)
}
console.log(`  fold errors: ${report.capture.foldErrors.length}`)
console.log(`  last run: ${LAST_RUN_PATH}`)
if (stdoutTail !== '') console.log(`\n${stdoutTail}`)
process.exit(strict && !report.target.met ? 2 : exitCode)
