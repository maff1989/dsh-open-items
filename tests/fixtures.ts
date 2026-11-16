/**
 * Shared fixtures: valid schema-v3 records and drafts.
 *
 * Tests build records through the same durable-boundary validator the store
 * uses (`parseItemRecord`), so a fixture can never be "valid enough for a test"
 * while being invalid for the domain.
 */
import { defaultReply, parseItemRecord } from '../src/shared/records'
import type { OpenItemRecord, SessionId } from '../src/shared/schema'

/** Default millisecond timestamp fixtures use. */
export const T0 = 1_000

/** Build one valid record, overriding any field. */
export function makeItem(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  const id = overrides.id ?? '018f0a3e-7b1c-7c2d-8a9b-0c1d2e3f4a5b'
  const sessionId = (overrides.source?.sessionId ?? 'session-1') as SessionId
  const candidate = {
    schemaVersion: 3,
    id,
    origin: 'install-1',
    kind: 'decision',
    state: 'open',
    tier: 'structural',
    severity: 2,
    title: 'Ship the migration before Friday?',
    body: 'The user has not picked a rollout window.',
    source: { sessionId },
    blocking: true,
    reply: defaultReply('decision'),
    deliveries: [],
    occurrences: [{ sessionId, seenAt: T0 }],
    dedupeKey: `fixture|${id}`,
    detectedBy: ['tool'],
    firstSeenAt: T0,
    lastSeenAt: T0,
    updatedAt: T0,
    version: 1,
    reopenCount: 0,
    retention: { class: 'active' },
    history: [{ at: T0, action: 'raised' }],
    ...overrides,
  }
  return parseItemRecord(candidate)
}
