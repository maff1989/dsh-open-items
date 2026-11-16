/**
 * Log-reader / invariant unit tests for the M1 acceptance harness.
 *
 * The `.jsonl.zstd` fixtures are generated at test time with the real `zstd`
 * binary, so the reader is exercised against the exact on-disk encoding the
 * Harness writes — not a JSON stand-in.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DerivedItemDraft } from '../../src/host/capture-contract'
import {
  ARTIFACT_FAMILIES,
  FAMILY_CLOSURES,
  LAST_RUN_PATH,
  M1_MAX_STRUCTURAL_ITEMS,
  computeInvariants,
  discoverSessionFiles,
  familyOfDraft,
  formatReport,
  loadCorpus,
  loadWorkspaceMembership,
  readSessionLog,
  writeLastRun,
  type ArtifactFamily,
  type CorpusSession,
  type LoadedCorpus,
  type DraftOrigin,
} from './corpus'

const execFileAsync = promisify(execFile)
const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '.tmp-acceptance-fixture')

let caseDirectory: string
let dshHome: string

beforeAll(async () => {
  await mkdir(TEST_ROOT, { recursive: true })
  caseDirectory = await mkdtemp(join(TEST_ROOT, 'acceptance-'))
  dshHome = join(caseDirectory, 'dsh-home')
  await buildFixtureCorpus(dshHome)
})

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true })
})

/**
 * Write one plain JSONL log and compress it with the real zstd binary.
 * @param plainPath - destination of the plain file.
 * @param zstdPath - destination of the compressed file.
 * @param lines - JSON values, one per line.
 */
async function writeCompressedLog(plainPath: string, zstdPath: string, lines: readonly unknown[]): Promise<void> {
  await mkdir(dirname(plainPath), { recursive: true })
  await mkdir(dirname(zstdPath), { recursive: true })
  await writeFile(plainPath, lines.map(line => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  await execFileAsync('zstd', ['-q', '-f', '-o', zstdPath, plainPath], { maxBuffer: 16 * 1024 * 1024 })
}

/**
 * Build a two-session fake DSH home: one seeded root session and one subagent.
 * @param home - DSH home directory.
 */
async function buildFixtureCorpus(home: string): Promise<void> {
  const workspaceDirectory = join(home, 'sessions', '--tmp-project--', 'session-root')
  await writeCompressedLog(
    join(caseDirectory, 'root.jsonl'),
    join(workspaceDirectory, 'session.v4.jsonl.zstd'),
    [
      {
        type: 'session',
        version: 4,
        id: 'session-root',
        createdAt: 1_000,
        cwd: '/tmp/project',
        isSeeded: true,
        delegationDepth: 0,
        agentPreset: 'standard',
      },
      { type: 'permission/preset', seq: 0, time: 1_001, data: { preset: 'workspace-write' } },
      { type: 'session/end-seed', seq: 1, time: 1_002, data: { inherited: true } },
      { type: 'approval/asked', seq: 2, time: 2_000, data: { id: 'approval-1', toolName: 'bash', callId: 'call-1' } },
      { type: 'approval/decided', seq: 3, time: 2_100, data: { id: 'approval-1', outcome: 'rejected' } },
      { type: 'tool/call', seq: 4, time: 2_200, data: { turn: 1, step: 1, callId: 'call-2', name: 'ask_user_question', arguments: '{"questions":[]}' } },
      { type: 'goal/change', seq: 5, time: 2_300, data: { kind: 'goal/change', version: 1, operation: 'block', goal: { id: 'goal-1', revision: 2, objective: 'ship', phase: 'blocked' }, roundsStarted: 1, createdAt: 1, updatedAt: 2_300 } },
      { type: 'todo/write', seq: 6, time: 2_400, data: { todos: [{ content: 'not an item', status: 'pending' }] } },
      { type: 'future/plugin-event', seq: 7, time: 2_500, data: { note: 'unknown types must be preserved, not interpreted' } },
      { type: 'session/title', seq: 8, time: 2_600, data: { title: 'Fixture session', messageSeqs: [0], source: 'fixture' } },
    ],
  )
  await writeCompressedLog(
    join(caseDirectory, 'subagent.jsonl'),
    join(home, 'sessions', '--tmp-project--', 'session-child', 'session.v4.jsonl.zstd'),
    [
      {
        type: 'session',
        version: 4,
        id: 'session-child',
        createdAt: 3_000,
        cwd: '/tmp/project',
        isSeeded: false,
        delegationDepth: 1,
        origin: 'subagent',
        agentPreset: 'standard',
      },
      { type: 'approval/asked', seq: 0, time: 3_100, data: { id: 'approval-2', toolName: 'bash', callId: 'call-9' } },
    ],
  )
  // A non-log file must be ignored by discovery.
  await writeFile(join(workspaceDirectory, 'notes.txt'), 'ignore me', 'utf8')
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'ws-1', workspaceIds: ['ws-1'], archivedSessionIds: ['session-archived'] },
    tables: {
      workspaces: {
        'ws-1': {
          path: '/tmp/project',
          title: 'project',
          sessionIds: ['session-root', 'session-child'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      },
    },
  }, null, 2)}\n`, 'utf8')
}

describe('log reader', () => {
  it('parses a format-v4 log, keeps unknown events, and derives the fork cut', async () => {
    const files = await discoverSessionFiles(dshHome)
    expect(files).toHaveLength(2)
    const root = await readSessionLog(files.find(path => path.includes('session-root'))!)
    expect(root.header).toMatchObject({ id: 'session-root', isSeeded: true, version: 4 })
    expect(root.events).toHaveLength(9)
    expect(root.inheritedEventCount).toBe(2)
    expect(root.info).toMatchObject({
      sessionId: 'session-root',
      title: 'Fixture session',
      delegationDepth: 0,
      cwd: '/tmp/project',
      inheritedEventCount: 2,
    })
    expect(root.updatedAt).toBe(2_600)
    expect(root.events.map(event => event.type)).toContain('future/plugin-event')
  })

  it('throws a line-addressed error for a malformed event line', async () => {
    const plainPath = join(caseDirectory, 'broken.jsonl')
    const zstdPath = join(caseDirectory, 'broken.jsonl.zstd')
    await writeFile(plainPath, `${JSON.stringify({ type: 'session', version: 4, id: 'x', createdAt: 1, isSeeded: false })}\n{not json}\n`)
    await execFileAsync('zstd', ['-q', '-f', '-o', zstdPath, plainPath])
    await expect(readSessionLog(zstdPath)).rejects.toThrow(/broken\.jsonl\.zstd:2/u)
  })
})

describe('corpus loading and workspace membership', () => {
  it('loads sessions from the fake home and resolves workspace membership from the durable file', async () => {
    const corpus = await loadCorpus({ dshHome })
    expect(corpus.files).toHaveLength(2)
    expect(corpus.sessions).toHaveLength(2)
    expect(corpus.issues).toEqual([])
    expect(corpus.membership.bySessionId.get('session-root')).toEqual({
      workspaceId: 'ws-1',
      title: 'project',
      path: '/tmp/project',
    })
    expect(corpus.membership.archivedSessionIds.has('session-archived')).toBe(true)
    expect(corpus.membership.workspaceCounts.get('ws-1')).toBe(2)
  })

  it('degrades to no membership when the workspace storage is absent', async () => {
    const membership = await loadWorkspaceMembership(join(caseDirectory, 'missing-home'))
    expect(membership.bySessionId.size).toBe(0)
    expect(membership.archivedSessionIds.size).toBe(0)
  })
})

/** One fabricated draft. */
function draft(overrides: Partial<DerivedItemDraft> = {}): DerivedItemDraft {
  return {
    artifactId: 'approval:call-1',
    kind: 'approval',
    tier: 'structural',
    severity: 1,
    title: 'Approve the migration?',
    body: 'Blocked on an approval.',
    sessionId: 'session-root',
    detectorCode: 'approval/decided:rejected',
    detectedBy: ['projection'],
    blocking: true,
    ...overrides,
  }
}

/** A minimal corpus for invariant tests. */
function corpusFor(sessions: readonly CorpusSession[]): LoadedCorpus {
  return {
    dshHome,
    sessionsRoot: join(dshHome, 'sessions'),
    files: sessions.map(session => session.filePath),
    sessions,
    issues: [],
    membership: { bySessionId: new Map(), archivedSessionIds: new Set(), workspaceCounts: new Map() },
  }
}

const captureMeta = {
  available: true,
  adapter: 'fixture',
  probes: ['fixture'],
  foldedSessions: 2,
  foldErrors: [],
} as const

describe('invariant computation', () => {
  it('counts kinds, dedupes artifacts, and flags root-only/todo violations', async () => {
    const corpus = await loadCorpus({ dshHome })
    const root = corpus.sessions.find(session => session.header.id === 'session-root')!
    const child = corpus.sessions.find(session => session.header.id === 'session-child')!
    const origins: DraftOrigin[] = [
      { sessionId: root.header.id, draft: draft() },
      // Same artifact re-raised: one item.
      { sessionId: root.header.id, draft: draft({ title: 'Approve the migration? (again)' }) },
      { sessionId: root.header.id, draft: draft({ artifactId: 'question:call-2', kind: 'question', severity: 1, detectorCode: 'tool/result:closes' }) },
      { sessionId: root.header.id, draft: draft({ artifactId: 'job:job-1', kind: 'follow-up', tier: 'candidate', severity: 3, detectorCode: 'job/settled:closes' }) },
      // A subagent draft must be flagged.
      { sessionId: child.header.id, draft: draft({ artifactId: 'approval:call-9', sessionId: child.header.id }) },
      // A todo-derived draft must be flagged.
      { sessionId: root.header.id, draft: draft({ artifactId: 'todo_write:snapshot', kind: 'task', detectorCode: 'todo/write' }) },
      // A closure for the approval artifact.
      { sessionId: root.header.id, draft: draft({ closes: { artifactId: 'approval:call-1', kind: 'detected-closed', code: 'approval/decided:allowed', at: 3_000 } }) },
    ]
    const report = computeInvariants(origins, corpus.sessions, corpusFor(corpus.sessions), captureMeta, 10_000)

    // Open-at-log-end accounting: the closure for approval:call-1 subtracts it.
    expect(report.counts.uniqueArtifacts).toBe(4)
    expect(report.counts.structural).toBe(3)
    expect(report.counts.candidate).toBe(1)
    expect(report.counts.raisedArtifacts).toBe(5)
    expect(report.counts.closedArtifacts).toBe(1)
    expect(report.counts.closures).toBe(1)
    expect(report.counts.perKind).toEqual({ approval: 1, question: 1, task: 1, 'follow-up': 1 })
    expect(report.invariants.rootOnlyViolations.map(entry => entry.artifactId)).toEqual(['approval:call-9'])
    expect(report.invariants.todoDerived.map(entry => entry.artifactId)).toEqual(['todo_write:snapshot'])
    expect(report.invariants.todoDerivedNeedsYou.map(entry => entry.artifactId)).toEqual(['todo_write:snapshot'])
    // Declared capability, not a detector-code regex: a blocked approval has no
    // unconditional log closer (the user resolves it), so it is reported with
    // its family. The question/job/todo families declare closers.
    expect(report.invariants.noClosureDetector.map(entry => entry.artifactId)).toEqual(['approval:call-9'])
    expect(report.invariants.noClosureDetector[0]).toMatchObject({ family: 'approval-blocked', policy: 'conditional' })
    expect(report.invariants.unclassifiedArtifacts).toEqual([])
    const approvalFamily = report.invariants.familyClosures.find(entry => entry.family === 'approval-blocked')!
    expect(approvalFamily).toMatchObject({ policy: 'conditional', raised: 2, open: 1, closures: 1 })
    expect(report.target).toMatchObject({ maxStructural: M1_MAX_STRUCTURAL_ITEMS, met: true })
    expect(report.corpus.todoWriteEvents).toBe(1)
    expect(report.corpus.seededSessions).toBe(1)
    expect(report.corpus.nonRootExcluded).toBe(1)
  })

  it('marks the structural target as missed above the PLAN budget', async () => {
    const corpus = await loadCorpus({ dshHome })
    const origins: DraftOrigin[] = Array.from({ length: 21 }, (_, index) => ({
      sessionId: corpus.sessions[0]!.header.id,
      draft: draft({ artifactId: `approval:call-${index}`, detectorCode: 'approval/decided:rejected' }),
    }))
    const report = computeInvariants(origins, corpus.sessions, corpusFor(corpus.sessions), captureMeta)
    expect(report.counts.structural).toBe(21)
    expect(report.target.met).toBe(false)
  })

  it('formats and persists a skipped run and a real run', async () => {
    const corpus = await loadCorpus({ dshHome })
    const skipped = computeInvariants([], corpus.sessions, corpusFor(corpus.sessions), {
      available: false,
      reason: 'capture modules absent',
      probes: ['absent: src/host/folds/index.ts'],
      foldedSessions: 0,
      foldErrors: [],
    })
    const skippedReport = { ...skipped, skipped: 'capture modules absent' }
    expect(formatReport(skippedReport)).toContain('SKIPPED')
    expect(formatReport(skippedReport)).toContain('absent: src/host/folds/index.ts')

    const real = computeInvariants([], corpus.sessions, corpusFor(corpus.sessions), captureMeta)
    expect(formatReport(real)).toContain('structural items: 0 open at log end')
    expect(formatReport(real)).toContain('target ≤20 — MET')
    expect(formatReport(real)).toContain('closure map')

    const tempLastRun = join(caseDirectory, 'last-run.json')
    await writeLastRun(real, tempLastRun)
    const written = JSON.parse(await readFile(tempLastRun, 'utf8')) as { generatedAt: string; counts: { structural: number } }
    expect(written.counts.structural).toBe(0)
    expect(typeof written.generatedAt).toBe('string')
    expect(LAST_RUN_PATH.endsWith('tests/acceptance/last-run.json')).toBe(true)
  })
})

describe('artifact-family closure map', () => {
  /** One draft classified by the map, with the family it must return. */
  const cases: readonly { readonly family: ArtifactFamily; readonly draft: DerivedItemDraft }[] = [
    {
      family: 'question',
      draft: draft({ artifactId: 'question:call-1', kind: 'question', detectorCode: 'tool/call:awaiting-answer' }),
    },
    {
      family: 'plan-review',
      draft: draft({ artifactId: 'question:call-2', kind: 'plan-review', detectorCode: 'tool/call:plan-review' }),
    },
    {
      family: 'interrupted',
      draft: draft({ artifactId: 'interrupted:call-3', kind: 'blocker', detectorCode: 'tool/result:TOOL_OUTCOME_UNKNOWN' }),
    },
    {
      family: 'approval-pending',
      draft: draft({ artifactId: 'approval:call-4', detectorCode: 'approval/asked:awaiting-decision' }),
    },
    {
      family: 'approval-blocked',
      draft: draft({ artifactId: 'approval:call-5', detectorCode: 'approval/decided:rejected' }),
    },
    {
      family: 'goal',
      draft: draft({ artifactId: 'goal:goal-1', kind: 'blocker', detectorCode: 'goal/change:blocked' }),
    },
    {
      family: 'job',
      draft: draft({ artifactId: 'job:job-1', kind: 'follow-up', detectorCode: 'job/registered:unsettled-after-turn' }),
    },
    {
      family: 'team-task-disabled',
      draft: draft({ artifactId: 'task:task-1', kind: 'task', detectorCode: 'team/task:in-progress-orphan' }),
    },
    {
      family: 'prose',
      draft: draft({ artifactId: 'prose:t2:0123456789ab', kind: 'decision', detectorCode: 'prose-gate:decision-request' }),
    },
    {
      family: 'todo',
      draft: draft({ artifactId: 'todo-open', kind: 'follow-up', detectorCode: 'todo/write:unfinished-plan' }),
    },
  ]

  it('classifies every shipped detector family into the declared map', () => {
    for (const { family, draft: sample } of cases) {
      expect(familyOfDraft(sample), `${sample.artifactId} (${sample.detectorCode})`).toBe(family)
      expect(FAMILY_CLOSURES[family], `${family} must be declared`).toBeDefined()
    }
    // The map is total: every declared family is declared with a policy.
    expect(ARTIFACT_FAMILIES).toHaveLength(cases.length)
    for (const family of ARTIFACT_FAMILIES) {
      expect(['detector', 'conditional', 'user-only', 'disabled']).toContain(FAMILY_CLOSURES[family].policy)
    }
  })

  it('classifies both the per-item and the legacy prose artifact ids as prose', () => {
    // Per-item ids are the current identity; legacy `prose:<16 hex>` rows still
    // exist in old checkpoints until the one-time migration retires them, so the
    // map must classify both from the same prefix.
    expect(familyOfDraft(draft({ artifactId: 'prose:t2:0123456789ab', kind: 'decision', detectorCode: 'prose-gate:decision-request' }))).toBe('prose')
    expect(familyOfDraft(draft({ artifactId: 'prose:0123456789abcdef', kind: 'question', detectorCode: 'prose-gate:decision-request' }))).toBe('prose')
  })

  it('declares the unconditional closers the folds actually emit', () => {
    expect(FAMILY_CLOSURES.question.closers).toContain('tool/result')
    expect(FAMILY_CLOSURES['plan-review'].closers).toContain('tool/result')
    expect(FAMILY_CLOSURES.interrupted.policy).toBe('detector')
    expect(FAMILY_CLOSURES['approval-pending'].closers).toContain('approval/decided')
    expect(FAMILY_CLOSURES['approval-blocked'].policy).toBe('conditional')
    expect(FAMILY_CLOSURES['approval-blocked'].closers).toContain('approval/decided:allowed-once')
    expect(FAMILY_CLOSURES.goal.closers).toContain('goal/change')
    expect(FAMILY_CLOSURES.job.closers).toContain('job/settled')
    expect(FAMILY_CLOSURES['team-task-disabled'].policy).toBe('disabled')
    expect(FAMILY_CLOSURES['team-task-disabled'].closers).toEqual([])
    expect(FAMILY_CLOSURES.prose.closers).toContain('user/message:superseded')
    expect(FAMILY_CLOSURES.todo.closers).toContain('todo/write:completed')
  })

  it('reports an undeclared family instead of silently passing it', async () => {
    const corpus = await loadCorpus({ dshHome })
    const origins: DraftOrigin[] = [{
      sessionId: corpus.sessions[0]!.header.id,
      draft: draft({ artifactId: 'custom:new-family', kind: 'risk', detectorCode: 'custom/event:raised' }),
    }]
    const report = computeInvariants(origins, corpus.sessions, corpusFor(corpus.sessions), captureMeta)
    expect(report.invariants.unclassifiedArtifacts.map(entry => entry.artifactId)).toEqual(['custom:new-family'])
    expect(report.invariants.noClosureDetector).toEqual([])
    expect(report.invariants.familyClosures.every(entry => entry.raised === 0)).toBe(true)
  })

  it('subtracts a closure from the raised count and re-opens on a later raise', async () => {
    const corpus = await loadCorpus({ dshHome })
    const sessionId = corpus.sessions[0]!.header.id
    const question = draft({ artifactId: 'question:call-1', kind: 'question', detectorCode: 'tool/call:awaiting-answer' })
    const closed = draft({
      artifactId: 'question:call-1',
      kind: 'question',
      closes: { artifactId: 'question:call-1', kind: 'detected-closed', code: 'tool/result', at: 4_000 },
    })
    const raise = (value: DerivedItemDraft, at: number): DraftOrigin => ({ sessionId, draft: { ...value, seq: at } })

    const openThenClosed = computeInvariants(
      [raise(question, 1), raise(closed, 2)],
      corpus.sessions,
      corpusFor(corpus.sessions),
      captureMeta,
    )
    expect(openThenClosed.counts.uniqueArtifacts).toBe(0)
    expect(openThenClosed.counts.raisedArtifacts).toBe(1)
    expect(openThenClosed.counts.closedArtifacts).toBe(1)
    expect(openThenClosed.invariants.familyClosures.find(entry => entry.family === 'question')).toMatchObject({
      raised: 1,
      open: 0,
      closures: 1,
    })

    // A re-raise after the closure re-opens the same artifact (last wins).
    const reopened = computeInvariants(
      [raise(question, 1), raise(closed, 2), raise(question, 3)],
      corpus.sessions,
      corpusFor(corpus.sessions),
      captureMeta,
    )
    expect(reopened.counts.uniqueArtifacts).toBe(1)
    expect(reopened.counts.structural).toBe(1)

    // A closure for an artifact that was never raised here (a historical
    // live-only row) counts as a closure but never as a raised item.
    const liveOnlyClosure = computeInvariants(
      [raise(closed, 2)],
      corpus.sessions,
      corpusFor(corpus.sessions),
      captureMeta,
    )
    expect(liveOnlyClosure.counts.raisedArtifacts).toBe(0)
    expect(liveOnlyClosure.counts.closures).toBe(1)
    expect(liveOnlyClosure.invariants.familyClosures.find(entry => entry.family === 'question')?.closures).toBe(1)
  })
})