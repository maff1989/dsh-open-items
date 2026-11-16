/**
 * Read projections: inbox snapshot, session/workspace rows, counts, cursor
 * paging and the resolution register (PLAN M1 item 5; DESIGN §5.10, §7.4.5).
 */
import { describe, expect, it } from 'vitest'

import { buildRegister, buildSnapshot, countSummary } from '../src/host/view'
import { defaultReply } from '../src/shared/records'
import type { InboxSnapshot, OpenItemRecord, OpenItemState } from '../src/shared/schema'
import { makeItem, T0 } from './fixtures'

/** View options a store would supply. */
const OPTIONS = { revision: 7, now: T0 + 1_000, earlierRecordsPruned: false, refreshing: false }

/** One resolved record. */
function resolved(id: string, sessionId: string, at: number, overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    id,
    state: 'resolved',
    source: { sessionId },
    resolvedAt: at,
    resolution: {
      kind: 'answered',
      at,
      actor: 'user',
      payload: { type: 'text', text: `answer for ${id}` },
    },
    acknowledgement: { state: 'observed', at, evidence: { kind: 'turn-continued' } },
    updatedAt: at,
    ...overrides,
  })
}

/** A mixed fixture set. */
function records(): OpenItemRecord[] {
  return [
    makeItem({
      id: 'open-1',
      state: 'open',
      source: { sessionId: 'session-a', sessionTitle: 'Deploy day', workspace: { workspaceId: 'w1', title: 'api', path: '/work/api' } },
      updatedAt: T0 + 30,
    }),
    makeItem({
      id: 'candidate-1',
      state: 'open',
      tier: 'candidate',
      kind: 'risk',
      source: { sessionId: 'session-b', sessionTitle: 'Nightly', workspace: { workspaceId: 'w1', title: 'api' } },
      updatedAt: T0 + 20,
    }),
    makeItem({
      id: 'awaiting-1',
      state: 'awaiting',
      source: { sessionId: 'session-a', sessionTitle: 'Deploy day', workspace: { workspaceId: 'w1', title: 'api' } },
      resolution: { kind: 'answered', at: T0 + 40, actor: 'user', payload: { type: 'text', text: 'ship it' } },
      acknowledgement: { state: 'pending' },
      updatedAt: T0 + 40,
    }),
    makeItem({
      id: 'unsorted-1',
      state: 'open',
      source: { sessionId: 'session-c', sessionTitle: 'Scratch' },
      updatedAt: T0 + 10,
    }),
    resolved('resolved-1', 'session-a', T0 + 60),
    resolved('resolved-2', 'session-b', T0 + 80, { kind: 'approval', reply: defaultReply('approval') }),
    makeItem({ id: 'archived-1', state: 'archived', source: { sessionId: 'session-c' }, updatedAt: T0 }),
    makeItem({ id: 'snoozed-1', state: 'snoozed', source: { sessionId: 'session-c' }, snoozedUntil: T0 + 90_000 }),
  ]
}

describe('inbox snapshot', () => {
  it('defaults to what needs you and excludes snoozed/resolved/archived rows', () => {
    const snapshot = buildSnapshot(records(), {}, OPTIONS)
    // Triage order: severity asc → firstSeenAt asc → id. All three are severity
    // 2 and first seen at T0, so the id tie-break decides.
    expect(snapshot.items.map(item => item.id)).toEqual(['candidate-1', 'open-1', 'unsorted-1'])
    expect(snapshot.revision).toBe(7)
    expect(snapshot.generatedAt).toBe(OPTIONS.now)
    expect(snapshot.refreshing).toBe(false)
  })

  it('filters by status, kind, scope and search', () => {
    const all = buildSnapshot(records(), { status: 'all' }, OPTIONS)
    expect(all.items).toHaveLength(8)
    expect(buildSnapshot(records(), { status: 'awaiting' }, OPTIONS).items.map(item => item.id)).toEqual(['awaiting-1'])
    expect(buildSnapshot(records(), { status: 'resolved' }, OPTIONS).items.map(item => item.id)).toEqual(['resolved-1', 'resolved-2'])
    expect(buildSnapshot(records(), { status: 'archived' }, OPTIONS).items.map(item => item.id)).toEqual(['archived-1'])
    expect(buildSnapshot(records(), { kinds: ['risk'] }, OPTIONS).items.map(item => item.id)).toEqual(['candidate-1'])
    expect(buildSnapshot(records(), { status: 'all', scope: { sessionId: 'session-a' } }, OPTIONS).items.map(item => item.id))
      .toEqual(['awaiting-1', 'open-1', 'resolved-1'])
    expect(buildSnapshot(records(), { scope: { workspaceId: 'w1' } }, OPTIONS).items.map(item => item.id))
      .toEqual(['candidate-1', 'open-1'])
    expect(buildSnapshot(records(), { status: 'all', search: 'ship it' }, OPTIONS).items[0]?.id).toBe('awaiting-1')
  })

  it('keeps the new-item watermark out of inbox matching but keeps it for the register', () => {
    const old = makeItem({
      id: 'old-open',
      state: 'open',
      source: { sessionId: 'session-a' },
      firstSeenAt: T0,
      updatedAt: T0,
    })
    const fresh = makeItem({
      id: 'fresh-open',
      state: 'open',
      source: { sessionId: 'session-a' },
      firstSeenAt: T0 + 5_000,
      lastSeenAt: T0 + 5_000,
      updatedAt: T0 + 5_000,
    })
    // A visit marker of T0 + 1_000: the old open item is older than the marker,
    // so it must still be in the inbox page (the counts already covered it) ...
    const snapshot = buildSnapshot([...records(), old, fresh], { since: T0 + 1_000 }, OPTIONS)
    expect(snapshot.items.map(item => item.id)).toEqual(expect.arrayContaining(['old-open', 'fresh-open']))
    expect(snapshot.counts.needsYou).toBe(4)
    expect(snapshot.counts.newSinceLastVisit).toBe(1)
    // ... while the register keeps `since` as the period lower bound.
    const register = buildRegister(records(), { status: 'resolved', since: T0 + 70 }, OPTIONS)
    expect(register.items.map(record => record.id)).toEqual(['resolved-2'])
    expect(buildRegister(records(), { status: 'resolved', since: T0 + 60 }, OPTIONS).items.map(record => record.id))
      .toEqual(['resolved-2', 'resolved-1'])
  })

  it('filters by exact states so a section read can return snoozed rows', () => {
    const snapshot = buildSnapshot(records(), { status: 'all', states: ['snoozed'] }, OPTIONS)
    expect(snapshot.items.map(item => item.id)).toEqual(['snoozed-1'])
    // Counts stay global over every stored record.
    expect(snapshot.counts).toMatchObject({ needsYou: 2, snoozed: 1, resolved: 2 })
    // Candidates read their own tier without seeing structural rows.
    expect(buildSnapshot(records(), { status: 'all', states: ['open', 'stale'], tiers: ['candidate'] }, OPTIONS)
      .items.map(item => item.id)).toEqual(['candidate-1'])
  })

  it('pages with an opaque cursor', () => {
    const many = Array.from({ length: 60 }, (_, index) => makeItem({
      id: `item-${String(index).padStart(3, '0')}`,
      source: { sessionId: 'session-a' },
      updatedAt: T0 + index,
    }))
    const first = buildSnapshot(many, { limit: 50 }, OPTIONS)
    expect(first.items).toHaveLength(50)
    expect(first.nextCursor).toBeDefined()
    const second = buildSnapshot(many, { limit: 50, cursor: first.nextCursor }, OPTIONS)
    expect(second.items).toHaveLength(10)
    expect(second.nextCursor).toBeUndefined()
    // No duplicates across the two pages.
    const ids = new Set([...first.items, ...second.items].map(item => item.id))
    expect(ids.size).toBe(60)
  })

  it('computes counts over every record, not the page', () => {
    const counts = countSummary(records(), { since: T0 }, OPTIONS)
    // OI-05: needs you = structural, severity 1-2, open/stale. The candidate is
    // its own count; awaiting/snoozed are separate bands.
    expect(counts).toMatchObject({ needsYou: 2, candidates: 1, awaiting: 1, snoozed: 1, resolved: 2 })
    expect(counts.newSinceLastVisit).toBe(8)
    expect(counts.earlierRecordsPruned).toBe(false)
  })

  it('builds session rows with per-session counts', () => {
    const snapshot = buildSnapshot(records(), {}, OPTIONS)
    const sessionA = snapshot.sessions.find(row => row.sessionId === 'session-a')
    expect(sessionA).toMatchObject({
      title: 'Deploy day',
      workspaceId: 'w1',
      running: false,
      archived: false,
      counts: { needsYou: 1, awaiting: 1 },
    })
    expect(snapshot.sessions.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps the nav invariant: counts.needsYou = Σ workspace rows, Ungrouped included', () => {
    const snapshot: InboxSnapshot = buildSnapshot(records(), {}, OPTIONS)
    const sum = snapshot.workspaces.reduce((total, row) => total + row.itemCount, 0)
    expect(sum).toBe(snapshot.counts.needsYou)
    expect(snapshot.workspaces.some(row => row.workspaceId === undefined && row.title === 'Ungrouped')).toBe(true)
    // Only open-1 is a needs-you item under OI-05: the candidate in w1 and the
    // awaiting row in session-a do not count. Σ workspaces still equals the
    // nav count, and Ungrouped carries the one session-less item.
    expect(snapshot.workspaces.find(row => row.workspaceId === 'w1')).toMatchObject({
      title: 'api',
      itemCount: 1,
      sessionCount: 1,
      removed: false,
    })
    expect(snapshot.workspaces.find(row => row.workspaceId === undefined)).toMatchObject({
      title: 'Ungrouped',
      itemCount: 1,
    })
  })
})

describe('inbox triage order (D-17)', () => {
  /**
   * One inbox record with an explicit triage position. State is varied only to
   * prove it is *not* part of the order; severity, waiting time and id are.
   */
  function triage(
    id: string,
    severity: 1 | 2 | 3,
    firstSeenAt: number,
    state: OpenItemState = 'open',
  ): OpenItemRecord {
    return makeItem({
      id,
      state,
      severity,
      firstSeenAt,
      lastSeenAt: firstSeenAt,
      updatedAt: firstSeenAt + 100,
      source: { sessionId: 'session-triage' },
      ...(state === 'snoozed' ? { snoozedUntil: T0 + 90_000 } : {}),
      ...(state === 'awaiting'
        ? {
            resolution: { kind: 'answered', at: firstSeenAt, actor: 'user', payload: { type: 'text', text: 'ok' } },
            acknowledgement: { state: 'pending' },
          }
        : {}),
    })
  }

  it('orders by severity first, not by state', () => {
    const snapshot = buildSnapshot(
      [
        triage('open-sev3', 3, T0),
        triage('snoozed-sev2', 2, T0 + 10, 'snoozed'),
        triage('awaiting-sev1', 1, T0 + 20, 'awaiting'),
        triage('stale-sev1', 1, T0 + 5, 'stale'),
      ],
      { status: 'all' },
      OPTIONS,
    )
    // Severity first, then longest waiting. The old state rank (open → stale →
    // awaiting → snoozed) would have put open-sev3 at the top.
    expect(snapshot.items.map(item => item.id)).toEqual([
      'stale-sev1',
      'awaiting-sev1',
      'snoozed-sev2',
      'open-sev3',
    ])
  })

  it('orders equal severity by longest waiting, not by recency', () => {
    const items = [
      triage('newest', 2, T0 + 30),
      triage('oldest', 2, T0 + 10),
      triage('middle', 2, T0 + 20),
    ]
    expect(buildSnapshot(items, {}, OPTIONS).items.map(item => item.id)).toEqual(['oldest', 'middle', 'newest'])
  })

  it('breaks a severity + waiting-time tie by id', () => {
    const items = [
      triage('zulu', 2, T0),
      triage('alpha', 2, T0),
      triage('mike', 2, T0),
    ]
    expect(buildSnapshot(items, {}, OPTIONS).items.map(item => item.id)).toEqual(['alpha', 'mike', 'zulu'])
  })

  it('pages in one globally ordered sequence, so Load more cannot interleave rows', () => {
    // The input order deliberately interleaves severity bands and waiting times.
    const all = [
      triage('b-sev2-old', 2, T0 + 10),
      triage('a-sev1-new', 1, T0 + 50),
      triage('c-sev2-new', 2, T0 + 40),
      triage('d-sev1-old', 1, T0 + 20),
      triage('e-sev3-old', 3, T0 + 5),
      triage('f-sev2-older', 2, T0 + 5),
      triage('g-sev1-same', 1, T0 + 20),
      triage('h-sev3-new', 3, T0 + 60),
    ]
    const expected = [
      'd-sev1-old',
      'g-sev1-same',
      'a-sev1-new',
      'f-sev2-older',
      'b-sev2-old',
      'c-sev2-new',
      'e-sev3-old',
      'h-sev3-new',
    ]
    // One read of everything defines the contract the pages must follow.
    expect(buildSnapshot(all, { limit: 50 }, OPTIONS).items.map(item => item.id)).toEqual(expected)

    const first = buildSnapshot(all, { limit: 3 }, OPTIONS)
    expect(first.items.map(item => item.id)).toEqual(expected.slice(0, 3))
    const second = buildSnapshot(all, { limit: 3, cursor: first.nextCursor }, OPTIONS)
    expect(second.items.map(item => item.id)).toEqual(expected.slice(3, 6))
    const third = buildSnapshot(all, { limit: 3, cursor: second.nextCursor }, OPTIONS)
    expect(third.items.map(item => item.id)).toEqual(expected.slice(6))
    expect(third.nextCursor).toBeUndefined()
    // Page 2 appends strictly after page 1: nothing the reader already saw moves.
    expect([...first.items, ...second.items].map(item => item.id)).toEqual(expected.slice(0, 6))
  })
})

describe('register projection', () => {
  it('returns resolutions and in-flight answers newest first with a total', () => {
    const register = buildRegister(records(), {}, OPTIONS)
    expect(register.items.map(item => item.id)).toEqual(['resolved-2', 'resolved-1', 'awaiting-1'])
    expect(register.total).toBe(3)
    expect(register.earlierRecordsPruned).toBe(false)
  })

  it('pages and filters the register', () => {
    const first = buildRegister(records(), { limit: 2 }, OPTIONS)
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeDefined()
    const second = buildRegister(records(), { limit: 2, cursor: first.nextCursor }, OPTIONS)
    expect(second.items.map(item => item.id)).toEqual(['awaiting-1'])
    expect(buildRegister(records(), { kinds: ['approval'] }, OPTIONS).items.map(item => item.id)).toEqual(['resolved-2'])
    expect(buildRegister(records(), { sources: ['detector'] }, OPTIONS).items).toHaveLength(0)
  })

  it('honours the earlier-records-pruned flag from the store', () => {
    const register = buildRegister(records(), {}, { ...OPTIONS, earlierRecordsPruned: true })
    expect(register.earlierRecordsPruned).toBe(true)
  })
})

describe('OI-05 counts predicate and tombstone reads', () => {
  /** One record per count rule. */
  function predicateRecords(): OpenItemRecord[] {
    return [
      makeItem({ id: 'structural-sev1', state: 'open', tier: 'structural', severity: 1, source: { sessionId: 's1' } }),
      makeItem({ id: 'structural-sev3', state: 'open', tier: 'structural', severity: 3, source: { sessionId: 's1' } }),
      makeItem({ id: 'candidate-open', state: 'open', tier: 'candidate', severity: 2, source: { sessionId: 's2' } }),
      makeItem({ id: 'stale-sev2', state: 'stale', tier: 'structural', severity: 2, source: { sessionId: 's2' } }),
      makeItem({
        id: 'awaiting-sev1',
        state: 'awaiting',
        severity: 1,
        source: { sessionId: 's3' },
        resolution: { kind: 'answered', at: T0 + 1, actor: 'user', payload: { type: 'text', text: 'ship' } },
        acknowledgement: { state: 'pending' },
      }),
      makeItem({ id: 'snoozed-sev1', state: 'snoozed', severity: 1, source: { sessionId: 's3' }, snoozedUntil: T0 + 90_000 }),
      makeItem({ id: 'tombstone', state: 'open', deletedAt: T0, source: { sessionId: 's4' } }),
    ]
  }

  it('counts only structural severity-1-2 open/stale items as needs you', () => {
    const snapshot = buildSnapshot(predicateRecords(), {}, OPTIONS)
    expect(snapshot.counts).toMatchObject({ needsYou: 2, candidates: 1, awaiting: 1, snoozed: 1, resolved: 0 })
    // A severity-3 structural and a candidate are not "needs you".
    expect(snapshot.items.map(item => item.id)).toContain('structural-sev3')
    // Per-session counts use the same predicate.
    const byId = new Map(snapshot.sessions.map(row => [row.sessionId, row]))
    expect(byId.get('s1')?.counts).toEqual({ needsYou: 1, awaiting: 0 })
    expect(byId.get('s2')?.counts).toEqual({ needsYou: 1, awaiting: 0 })
    expect(byId.get('s3')?.counts).toEqual({ needsYou: 0, awaiting: 1 })
    // Tombstones own no session row and are absent from the lens.
    expect(byId.has('s4')).toBe(false)
    expect(snapshot.workspaces.reduce((total, row) => total + row.itemCount, 0)).toBe(snapshot.counts.needsYou)
  })

  it('keeps counts global so a session filter cannot change the nav badge', () => {
    const snapshot = buildSnapshot(records(), { status: 'all', scope: { sessionId: 'session-b' } }, OPTIONS)
    expect(snapshot.items.every(item => item.source.sessionId === 'session-b')).toBe(true)
    expect(snapshot.counts.needsYou).toBe(countSummary(records(), {}, OPTIONS).needsYou)
    expect(snapshot.workspaces.reduce((total, row) => total + row.itemCount, 0)).toBe(snapshot.counts.needsYou)
  })

  it('hides a tombstone from the inbox, the register and the counts', () => {
    const tombstone = makeItem({
      id: 'deleted-1',
      state: 'resolved',
      deletedAt: T0,
      resolvedAt: T0,
      source: { sessionId: 'session-a', sessionTitle: 'Deploy day' },
      resolution: { kind: 'dismissed', at: T0, actor: 'user', payload: { type: 'dismiss' } },
      acknowledgement: { state: 'none' },
    })
    const all = [...records(), tombstone]
    const inbox = buildSnapshot(all, { status: 'all' }, OPTIONS)
    expect(inbox.items.map(item => item.id)).not.toContain('deleted-1')
    expect(inbox.sessions.map(row => row.sessionId)).not.toContain('deleted-1')
    expect(inbox.counts.resolved).toBe(2)
    const register = buildRegister(all, { status: 'all' }, OPTIONS)
    expect(register.items.map(item => item.id)).not.toContain('deleted-1')
    expect(register.total).toBe(3)
    expect(countSummary(all, {}, OPTIONS).resolved).toBe(2)
  })
})

describe('session rows provenance', () => {
  it('does not label a root session subagent when a subagent raised a roll-up item', () => {
    const rollup = makeItem({
      id: 'roll-up',
      state: 'open',
      source: {
        sessionId: 'session-root',
        sessionTitle: 'Root session',
        raisedBy: { sessionId: 'session-child', title: 'Helper' },
      },
    })
    const plain = makeItem({ id: 'plain', state: 'open', source: { sessionId: 'session-root' } })
    const snapshot = buildSnapshot([rollup, plain], {}, OPTIONS)
    const root = snapshot.sessions.find(row => row.sessionId === 'session-root')!
    expect(root).not.toHaveProperty('origin')
    // The roll-up attribution stays on the item, where the UI renders it.
    expect(snapshot.items.find(item => item.id === 'roll-up')?.source.raisedBy).toEqual({
      sessionId: 'session-child',
      title: 'Helper',
    })
  })
})
