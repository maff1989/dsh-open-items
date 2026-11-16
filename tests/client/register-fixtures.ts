/**
 * Fixtures for the register suites: one record factory per register state, with
 * times built from local calendar parts so day grouping and periods are stable
 * in any timezone the test runner happens to use.
 *
 * These are test-only helpers; the records match `src/shared/schema.ts` exactly
 * and reuse the foundation factory for everything the register does not vary.
 */
import type { OpenItemRecord } from '../../src/shared/schema'
import { makeItem } from './fixtures'

/** A fixed "now": 13 Nov 2026, 15:00 local. */
export const NOW = new Date(2026, 10, 13, 15, 0, 0).getTime()

/** Local timestamp helper: `at(day offset, hour, minute)` relative to `NOW`'s date. */
export function at(dayOffset: number, hour: number, minute = 0): number {
  const base = new Date(NOW)
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, minute, 0).getTime()
}

/** One resolved record answered by the user and acknowledged by the retried call. */
export function makeAnswered(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  const resolvedAt = at(0, 14, 2)
  return makeItem({
    id: 'reg-answered',
    state: 'resolved',
    kind: 'approval',
    severity: 1,
    title: 'Install the corporate registry',
    body: 'The agent asked for one sandbox escalation.',
    quote: 'bash — "install the corporate registry"',
    resolution: {
      kind: 'answered',
      at: resolvedAt,
      actor: 'user',
      payload: { type: 'approval', outcome: 'allow-once', note: 'corporate registry only' },
      deliveryId: 'delivery-1',
      evidence: { seq: 412, callId: 'call_01_5ID' },
    },
    deliveries: [
      {
        deliveryId: 'delivery-1',
        at: resolvedAt,
        track: 'client-settle',
        payload: { type: 'approval', outcome: 'allow-once' },
        state: 'settled',
        evidence: { seq: 412, callId: 'call_01_5ID' },
      },
    ],
    acknowledgement: { state: 'observed', at: resolvedAt + 8_000, evidence: { seq: 412, kind: 'call-retried' } },
    resolvedAt,
    retention: { class: 'active' },
    ...overrides,
  })
}

/** A dismissed candidate: closed by the user, not an answer. */
export function makeDismissed(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  const resolvedAt = at(0, 11, 20)
  return makeItem({
    id: 'reg-dismissed',
    state: 'resolved',
    tier: 'candidate',
    kind: 'follow-up',
    severity: 3,
    title: 'Want me to also update the docs?',
    resolution: {
      kind: 'dismissed',
      at: resolvedAt,
      actor: 'user',
      payload: { type: 'dismiss', reason: 'not an item, docs follow-up' },
    },
    deliveries: [],
    acknowledgement: { state: 'none' },
    resolvedAt,
    ...overrides,
  })
}

/** A superseded decision: the session moved on before the user answered. */
export function makeSuperseded(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  const resolvedAt = at(-1, 18, 40)
  return makeItem({
    id: 'reg-superseded',
    state: 'resolved',
    kind: 'decision',
    severity: 2,
    title: 'Keep the 5-colour palette',
    resolution: {
      kind: 'superseded',
      at: resolvedAt,
      actor: 'detector',
      payload: { type: 'detector', code: 'session/new-turn' },
    },
    deliveries: [],
    acknowledgement: { state: 'none' },
    resolvedAt,
    ...overrides,
  })
}

/** A detector-closed goal: auto-closed, with its detector code. */
export function makeDetected(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  const resolvedAt = at(-2, 9, 15)
  return makeItem({
    id: 'reg-detected',
    state: 'resolved',
    kind: 'blocker',
    severity: 2,
    title: 'Ship 0.2.2-rc.2',
    resolution: {
      kind: 'detected-closed',
      at: resolvedAt,
      actor: 'detector',
      payload: { type: 'detector', code: 'goal/change:resumed' },
    },
    deliveries: [],
    acknowledgement: { state: 'observed' },
    resolvedAt,
    ...overrides,
  })
}

/** An answer that the session has not acknowledged yet (the in-flight band). */
export function makeInFlight(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  const answeredAt = at(0, 14, 30)
  return makeItem({
    id: 'reg-inflight',
    state: 'awaiting',
    kind: 'question',
    severity: 2,
    title: 'Ship the migration before Friday?',
    resolution: {
      kind: 'answered',
      at: answeredAt,
      actor: 'user',
      payload: { type: 'text', text: 'Yes, before Friday.' },
      deliveryId: 'delivery-2',
      evidence: { seq: 87, messageId: 'message-2' },
    },
    deliveries: [
      {
        deliveryId: 'delivery-2',
        at: answeredAt,
        track: 'session-message',
        payload: { type: 'text', text: 'Yes, before Friday.' },
        state: 'delivered',
        evidence: { seq: 87, messageId: 'message-2' },
      },
    ],
    acknowledgement: { state: 'pending' },
    resolvedAt: undefined,
    updatedAt: answeredAt,
    retention: { class: 'active' },
    ...overrides,
  })
}

/** An old resolution whose transcript text compaction dropped (archive period). */
export function makeArchived(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  const resolvedAt = at(-400, 10, 0)
  return makeItem({
    id: 'reg-archived',
    state: 'resolved',
    kind: 'question',
    severity: 2,
    title: 'Old decision that survives in the archive',
    body: '',
    quote: undefined,
    resolution: {
      kind: 'answered',
      at: resolvedAt,
      actor: 'user',
      payload: { type: 'text', text: 'Yes — archive it.' },
    },
    deliveries: [],
    acknowledgement: { state: 'none' },
    resolvedAt,
    retention: { class: 'archived', archivedAt: at(-35, 10, 0) },
    ...overrides,
  })
}

/** A record outside one day but inside the 7-day window (for period tests). */
export function makeRecent(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  const resolvedAt = at(-3, 12, 0)
  return makeItem({
    id: 'reg-recent',
    state: 'resolved',
    kind: 'risk',
    severity: 2,
    title: 'Rendering risk flagged in review',
    resolution: {
      kind: 'answered',
      at: resolvedAt,
      actor: 'user',
      payload: { type: 'text', text: 'Leave it scroll-only for now.' },
    },
    deliveries: [],
    acknowledgement: { state: 'none' },
    resolvedAt,
    ...overrides,
  })
}

/** Every register fixture, in no particular order. */
export function registerFixtures(): OpenItemRecord[] {
  return [
    makeDismissed(),
    makeAnswered(),
    makeInFlight(),
    makeDetected(),
    makeSuperseded(),
    makeRecent(),
    makeArchived(),
  ]
}

/** Records that must never be rendered or exported. */
export function nonRegisterFixtures(): OpenItemRecord[] {
  const [answered] = registerFixtures()
  /* c8 ignore next -- the fixture always has a first record */
  if (answered === undefined) throw new Error('registerFixtures() must not be empty')
  return [
    makeItem({ id: 'reg-open', state: 'open', title: 'Still waiting' }),
    { ...answered, id: 'reg-deleted', deletedAt: NOW },
    makeItem({ id: 'reg-snoozed', state: 'snoozed', title: 'Deferred' }),
  ]
}
