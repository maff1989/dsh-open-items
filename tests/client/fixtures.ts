/**
 * Test fixtures for the client half: one durable record factory and one
 * snapshot factory so each suite varies only the field under test.
 *
 * These are test-only helpers (not part of the build); the records match
 * `src/shared/schema.ts` v3 exactly.
 */
import type {
  InboxSnapshot,
  OpenItemRecord,
  SessionInboxRow,
  WorkspaceInboxRow,
} from '../../src/shared/schema'
import { en } from '../../src/client/locales'
import type { PageTranslate } from '../../src/client/format'

/** Fill one record with a realistic default; every field is overridable. */
export function makeItem(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return {
    schemaVersion: 3,
    id: 'item-1',
    origin: 'install-1',
    kind: 'decision',
    state: 'open',
    tier: 'structural',
    severity: 2,
    title: 'Keep 5 colours or 3?',
    body: 'The five colours are load-bearing for the legend.',
    source: { sessionId: 'session-1', sessionTitle: 'dsh-highlights review', turn: 4 },
    blocking: false,
    reply: {
      controls: ['text'],
      freeText: true,
      requiresConfirm: false,
    },
    deliveries: [],
    occurrences: [{ sessionId: 'session-1', seq: 12, seenAt: 1 }],
    dedupeKey: 'dedupe-1',
    detectedBy: ['projection'],
    firstSeenAt: 1_000,
    lastSeenAt: 2_000,
    updatedAt: 2_000,
    version: 1,
    reopenCount: 0,
    retention: { class: 'active' },
    history: [{ at: 1_000, action: 'raised' }],
    ...overrides,
  }
}

/** One session row of the snapshot. */
export function makeSessionRow(overrides: Partial<SessionInboxRow> = {}): SessionInboxRow {
  return {
    sessionId: 'session-1',
    title: 'dsh-highlights review',
    updatedAt: 2_000,
    running: false,
    archived: false,
    counts: { needsYou: 1, awaiting: 0 },
    ...overrides,
  }
}

/** One workspace row of the snapshot. */
export function makeWorkspaceRow(overrides: Partial<WorkspaceInboxRow> = {}): WorkspaceInboxRow {
  return {
    workspaceId: 'workspace-1',
    title: 'Hookshot',
    path: '/home/me/Hookshot',
    removed: false,
    itemCount: 1,
    sessionCount: 1,
    ...overrides,
  }
}

/** One snapshot with the counts matching the supplied items. */
export function makeSnapshot(
  items: readonly OpenItemRecord[],
  overrides: Partial<InboxSnapshot> = {},
): InboxSnapshot {
  const live = items.filter(item => item.deletedAt === undefined)
  const needsYou = live.filter(item => item.tier === 'structural'
    && (item.state === 'open' || item.state === 'stale' || item.state === 'awaiting')).length
  const candidates = live.filter(item => item.tier === 'candidate'
    && (item.state === 'open' || item.state === 'stale')).length
  return {
    revision: 1,
    generatedAt: 5_000,
    items,
    sessions: [],
    workspaces: [],
    counts: {
      needsYou,
      candidates,
      awaiting: live.filter(item => item.state === 'awaiting').length,
      snoozed: live.filter(item => item.state === 'snoozed').length,
      resolved: live.filter(item => item.state === 'resolved' || item.state === 'archived').length,
      newSinceLastVisit: 0,
      earlierRecordsPruned: false,
    },
    refreshing: false,
    ...overrides,
  }
}

/** Substitute `{name}` placeholders the way the locale runtime does. */
function fill(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/** English translator over the real dictionary, for rendering tests. */
export const t: PageTranslate = (key, params) => fill(en[key as keyof typeof en], params)
