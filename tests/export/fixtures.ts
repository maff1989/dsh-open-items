/**
 * Fixed fixtures for the export golden files.
 *
 * Everything here is frozen: ids, timestamps, options and the hostile strings
 * that prove escaping. A golden file is only useful if the fixture never drifts,
 * so any intentional change to a fixture must be paired with regenerating the
 * golden (`node tests/export/regenerate-golden.mjs` is not used; run the
 * generator spec described in `tests/export/README.md`).
 *
 * Times are fixed UTC instants; no test reads the clock.
 */
import type { OpenItemRecord } from '../../src/shared/schema'
import { STORE_SCHEMA_VERSION } from '../../src/shared/schema'
import type { ExportOptions } from '../../src/shared/export'

/** The frozen export time every fixture uses: 2026-11-13 23:45:00.000 UTC. */
export const FIXED_GENERATED_AT = Date.UTC(2026, 10, 13, 23, 45, 0)

/** Plugin version stamped into every fixture export. */
export const FIXED_PLUGIN_VERSION = '0.1.0'

/** The filter label the dialog would show for "last 30 days, all sources". */
export const FIXED_FILTER_LABEL = '30 days · all sources'

/** A neutral, fully-specified reply descriptor. */
const REPLY: OpenItemRecord['reply'] = {
  controls: ['text'],
  freeText: true,
  requiresConfirm: true,
  note: 'answering resumes dsh-highlights plugin code review',
}

/** A resolved item with every optional field present. */
function baseRecord(overrides: Partial<OpenItemRecord> & Pick<OpenItemRecord, 'id' | 'resolvedAt'>): OpenItemRecord {
  const record: OpenItemRecord = {
    schemaVersion: STORE_SCHEMA_VERSION,
    id: overrides.id,
    origin: 'install-fixture',
    kind: 'decision',
    state: 'resolved',
    tier: 'structural',
    severity: 2,
    title: 'Fixture decision',
    body: 'Why this item exists, in two sentences: the agent needed a choice and the user made one.',
    quote: 'Choose between the two registry options.',
    options: ['corporate registry', 'public registry'],
    source: {
      sessionId: 'session-fixture-1',
      sessionTitle: 'dsh-highlights plugin code review',
      workspace: { workspaceId: 'ws-fixture-1', title: 'dsh-highlights', path: '/home/fixture/highlights' },
      seq: 412,
      turn: 4,
      callId: 'call_01_5ID',
      approvalId: 'approval-fixture-1',
    },
    blocking: true,
    reply: REPLY,
    deliveries: [],
    occurrences: [{ sessionId: 'session-fixture-1', seq: 412, seenAt: Date.UTC(2026, 10, 13, 20, 0, 0) }],
    dedupeKey: 'decision:corporate-registry',
    detectedBy: ['log-fold'],
    firstSeenAt: Date.UTC(2026, 10, 13, 20, 0, 0),
    lastSeenAt: Date.UTC(2026, 10, 13, 22, 41, 0),
    updatedAt: Date.UTC(2026, 10, 13, 22, 41, 0),
    version: 3,
    resolution: {
      kind: 'answered',
      at: Date.UTC(2026, 10, 13, 22, 41, 0),
      actor: 'user',
      payload: { type: 'option', option: 'corporate registry' },
    },
    acknowledgement: {
      state: 'observed',
      at: Date.UTC(2026, 10, 13, 22, 41, 19),
      evidence: { seq: 412, kind: 'call-retried' },
    },
    resolvedAt: overrides.resolvedAt,
    reopenCount: 0,
    retention: { class: 'active' },
    history: [
      { at: Date.UTC(2026, 10, 13, 20, 0, 0), action: 'raised', detail: 'log-fold detected an approval ask' },
      { at: Date.UTC(2026, 10, 13, 22, 41, 0), action: 'resolved', detail: 'answered by the user' },
    ],
  }
  return { ...record, ...overrides, resolvedAt: overrides.resolvedAt }
}

/** The frozen fixture set: seven exportable records plus hostile strings. */
export function fixtureRecords(): OpenItemRecord[] {
  return [
    // 1. A structured approval answered by the user; archived=false; newest record.
    baseRecord({
      id: 'item-0001-approval',
      resolvedAt: Date.UTC(2026, 10, 13, 22, 41, 0),
      kind: 'approval',
      severity: 1,
      title: 'Install the corporate registry',
      body: 'The agent asked for one sandbox escalation to install the registry.',
      quote: 'bash — "install the corporate registry"',
      options: undefined,
      reply: { controls: ['approve', 'deny'], freeText: false, requiresConfirm: true },
      deliveries: [
        {
          deliveryId: '0199a0c3-4b2e-7c11-8f01-2b3c4d5e6f70',
          at: Date.UTC(2026, 10, 13, 22, 41, 0),
          track: 'client-settle',
          payload: { type: 'approval', outcome: 'allow-once', note: 'corporate registry only' },
          state: 'settled',
          evidence: { seq: 412, callId: 'call_01_5ID' },
        },
      ],
      resolution: {
        kind: 'answered',
        at: Date.UTC(2026, 10, 13, 22, 41, 0),
        actor: 'user',
        payload: { type: 'approval', outcome: 'allow-once', note: 'corporate registry only' },
        deliveryId: '0199a0c3-4b2e-7c11-8f01-2b3c4d5e6f70',
        evidence: { seq: 412, callId: 'call_01_5ID' },
      },
    }),
    // 2. Hostile text: CSV formula injection, quotes, commas, newlines, HTML, unicode.
    baseRecord({
      id: 'item-0002-question',
      resolvedAt: Date.UTC(2026, 10, 13, 11, 20, 30),
      kind: 'question',
      severity: 2,
      title: 'Ship the migration before Friday? =HYPERLINK("http://evil.example","click")',
      body: 'Line one, with a comma and a "quoted" word.\nLine two starts with =cmd|\' /C calc\'!A0\nLine three has <script>alert("x")</script> and </style> and & ampersand.',
      quote: 'Answer "yes", then +1 and -2 and @SUM(A1) — 日本語 🦔 ✓',
      options: undefined,
      source: {
        sessionId: 'session-fixture-2',
        sessionTitle: 'Hookshot review — <b>release</b> gate',
        seq: 87,
        turn: 2,
        messageId: 'message-fixture-2',
      },
      deliveries: [
        {
          deliveryId: '0199a0c4-0000-7000-8000-000000000002',
          at: Date.UTC(2026, 10, 13, 11, 20, 30),
          track: 'session-message',
          payload: { type: 'text', text: 'Yes, before Friday.' },
          state: 'delivered',
          evidence: { seq: 87, messageId: 'message-fixture-2' },
        },
      ],
      resolution: {
        kind: 'answered',
        at: Date.UTC(2026, 10, 13, 11, 20, 30),
        actor: 'user',
        payload: { type: 'text', text: 'Yes, before Friday.\nThen verify with =HYPERLINK("http://evil.example","click").' },
        deliveryId: '0199a0c4-0000-7000-8000-000000000002',
        evidence: { seq: 87, messageId: 'message-fixture-2' },
      },
      acknowledgement: {
        state: 'observed',
        at: Date.UTC(2026, 10, 13, 11, 21, 2),
        evidence: { seq: 88, kind: 'turn-continued' },
      },
      history: [{ at: Date.UTC(2026, 10, 13, 10, 0, 0), action: 'raised' }],
    }),
    // 3. Dismissed candidate: source user, outcome dismissed, acknowledgement none.
    baseRecord({
      id: 'item-0003-candidate',
      resolvedAt: Date.UTC(2026, 10, 13, 9, 15, 0),
      kind: 'follow-up',
      tier: 'candidate',
      severity: 3,
      title: 'Want me to also update the docs?',
      body: '',
      quote: undefined,
      options: undefined,
      source: { sessionId: 'session-fixture-3', sessionTitle: 'Superset cleanup', seq: 33, turn: 1 },
      reply: { controls: ['text'], freeText: true, requiresConfirm: false },
      deliveries: [],
      occurrences: [],
      detectedBy: ['regex-gate', 'llm'],
      resolution: {
        kind: 'dismissed',
        at: Date.UTC(2026, 10, 13, 9, 15, 0),
        actor: 'user',
        payload: { type: 'dismiss', reason: 'not an item, docs follow-up' },
      },
      acknowledgement: { state: 'none' },
      history: [{ at: Date.UTC(2026, 10, 13, 8, 0, 0), action: 'resolved', detail: 'dismissed by the user' }],
    }),
    // 4. Detector-closed: source auto, outcome superseded, no acknowledgement evidence.
    baseRecord({
      id: 'item-0004-auto',
      resolvedAt: Date.UTC(2026, 10, 12, 18, 40, 0),
      kind: 'blocker',
      severity: 2,
      title: 'Ship 0.2.2-rc.2',
      body: '',
      quote: undefined,
      options: undefined,
      source: {
        sessionId: 'session-fixture-4',
        sessionTitle: 'Release 0.2.2',
        goalId: 'goal-fixture-1',
        goalRevision: 7,
        seq: 120,
      },
      reply: { controls: ['text'], freeText: true, requiresConfirm: true },
      deliveries: [],
      occurrences: [],
      resolution: {
        kind: 'detected-closed',
        at: Date.UTC(2026, 10, 12, 18, 40, 0),
        actor: 'detector',
        payload: { type: 'detector', code: 'goal/resume' },
      },
      resolutionLog: [
        {
          kind: 'answered',
          at: Date.UTC(2026, 10, 10, 8, 30, 0),
          actor: 'user',
          payload: { type: 'text', text: 'Not yet — wait for the release window.' },
        },
        {
          kind: 'detected-closed',
          at: Date.UTC(2026, 10, 12, 18, 40, 0),
          actor: 'detector',
          payload: { type: 'detector', code: 'goal/resume' },
        },
      ],
      reopenCount: 1,
      acknowledgement: { state: 'observed' },
      history: [
        { at: Date.UTC(2026, 10, 5, 9, 0, 0), action: 'raised' },
        { at: Date.UTC(2026, 10, 12, 18, 40, 0), action: 'resolved', detail: 'goal resumed' },
      ],
    }),
    // 5. Superseded by a later turn; same resolvedAt as record 6 to prove the id tie-break.
    baseRecord({
      id: 'item-0005-superseded',
      resolvedAt: Date.UTC(2026, 10, 12, 7, 5, 0),
      kind: 'decision',
      severity: 2,
      title: 'Keep the 5-colour palette',
      body: 'The session resumed before the user answered, so the decision lost its context.',
      quote: undefined,
      options: ['5 colours', '7 colours'],
      source: { sessionId: 'session-fixture-5', sessionTitle: 'dsh-highlights UI/UX', turn: 6, seq: 210 },
      reply: { controls: ['option'], options: ['5 colours', '7 colours'], freeText: false, requiresConfirm: true },
      deliveries: [],
      occurrences: [],
      detectedBy: ['log-fold', 'regex-gate'],
      resolution: {
        kind: 'superseded',
        at: Date.UTC(2026, 10, 12, 7, 5, 0),
        actor: 'detector',
        payload: { type: 'detector', code: 'session/new-turn' },
      },
      acknowledgement: { state: 'none' },
      history: [{ at: Date.UTC(2026, 10, 11, 20, 0, 0), action: 'raised' }],
    }),
    // 6. Same resolvedAt as record 5, lower id: must sort after record 5 by id ascending.
    baseRecord({
      id: 'item-0006-tie',
      resolvedAt: Date.UTC(2026, 10, 12, 7, 5, 0),
      kind: 'risk',
      severity: 3,
      title: 'Rendering risk flagged in review',
      body: '',
      quote: undefined,
      options: undefined,
      source: { sessionId: 'session-fixture-6', sessionTitle: 'dsh-highlights UI/UX', seq: 211, turn: 6 },
      reply: { controls: ['text'], freeText: true, requiresConfirm: false },
      deliveries: [],
      occurrences: [],
      detectedBy: ['tool'],
      resolution: {
        kind: 'answered',
        at: Date.UTC(2026, 10, 12, 7, 5, 0),
        actor: 'user',
        payload: { type: 'text', text: '=1+1 leave it scroll-only for now.' },
      },
      acknowledgement: { state: 'pending' },
      history: [{ at: Date.UTC(2026, 10, 12, 6, 0, 0), action: 'raised' }],
    }),
    // 7. Archived retention: transcript text already dropped; only included with includeArchive.
    baseRecord({
      id: 'item-0007-archived',
      resolvedAt: Date.UTC(2025, 0, 2, 10, 0, 0),
      kind: 'question',
      severity: 2,
      title: 'Old decision that survives in the archive',
      body: '',
      quote: undefined,
      options: undefined,
      source: { sessionId: 'session-fixture-7', sessionTitle: 'Old session', seq: 9, turn: 1 },
      reply: { controls: ['text'], freeText: true, requiresConfirm: false },
      deliveries: [],
      occurrences: [],
      resolution: {
        kind: 'answered',
        at: Date.UTC(2025, 0, 2, 10, 0, 0),
        actor: 'user',
        payload: { type: 'text', text: 'Yes — archive it.' },
      },
      acknowledgement: { state: 'none' },
      retention: { class: 'archived', archivedAt: Date.UTC(2026, 0, 2, 10, 0, 0) },
      history: [{ at: Date.UTC(2025, 0, 2, 9, 0, 0), action: 'resolved' }],
    }),
  ]
}

/** Records that must never appear in any export (wrong state or deleted forever). */
export function nonExportableRecords(): OpenItemRecord[] {
  const [resolved] = fixtureRecords()
  /* c8 ignore next -- the fixture always has a first record */
  if (resolved === undefined) throw new Error('fixtureRecords() must not be empty')
  return [
    { ...resolved, id: 'item-9001-still-open', state: 'open' },
    { ...resolved, id: 'item-9002-deleted', deletedAt: Date.UTC(2026, 10, 13, 23, 0, 0) },
    { ...resolved, id: 'item-9003-no-resolution', resolution: undefined, resolvedAt: undefined },
    { ...resolved, id: 'item-9004-snoozed', state: 'snoozed' },
  ]
}

/**
 * Build one export request; every field is explicit so a golden file can never
 * drift because a default changed.
 * @param overrides - fields to change.
 * @returns the frozen options.
 */
export function fixedOptions(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return {
    format: 'csv',
    includeArchive: false,
    includeExcerpts: true,
    filterLabel: FIXED_FILTER_LABEL,
    generatedAt: FIXED_GENERATED_AT,
    pluginVersion: FIXED_PLUGIN_VERSION,
    schemaVersion: STORE_SCHEMA_VERSION,
    earlierRecordsPruned: false,
    ...overrides,
  }
}

/**
 * A fixed, seeded permutation so "input order does not matter" is testable
 * without `Math.random`.
 * @param records - records in fixture order.
 * @param seed - small integer seed.
 * @returns a permuted copy.
 */
export function shuffleWithSeed<T>(records: readonly T[], seed: number): T[] {
  const shuffled = [...records]
  let state = seed >>> 0
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    // xorshift32: deterministic, no library, no clock.
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    const swapIndex = (state >>> 0) % (index + 1)
    const current = shuffled[index]
    const other = shuffled[swapIndex]
    /* c8 ignore next -- both indexes are in range by construction */
    if (current === undefined || other === undefined) continue
    shuffled[index] = other
    shuffled[swapIndex] = current
  }
  return shuffled
}
