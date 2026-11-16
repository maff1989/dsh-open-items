/**
 * Record helpers for schema v3: normalisation, identity keys, defaults and
 * durable-boundary validation.
 *
 * The contract types live in `./schema.ts` (frozen for every branch); this
 * module is the executable half of that contract. It is deliberately free of
 * harness imports so the migration, the store, the tests and a future client
 * helper can all share one definition of "a valid record".
 *
 * Validation exists because the storage domain's durable boundary validates
 * every loaded record; this package cannot add `zod` to its manifest (the
 * manifest is owned by another lane), so the domain's zod schemas are supplied
 * by {@link asDomainSchema} as the subset the domain runtime actually calls:
 * `parse(raw)`. The same validators are used by migration and tests.
 */
import type {
  Acknowledgement,
  AcknowledgementEvidence,
  DeliveryFailureCode,
  DeliveryRecord,
  DeliveryState,
  DeliveryTrack,
  DetectionSource,
  DetectionCursor,
  HistoryEntry,
  InstallRecord,
  ItemSourceRef,
  OpenItemId,
  OpenItemKind,
  OpenItemRecord,
  OpenItemState,
  OpenItemTier,
  ReplyDescriptor,
  ReplyPayload,
  Resolution,
  ResolutionKind,
  Retention,
  Severity,
  SuppressorRecord,
  WorkspaceRef,
} from './schema'
import type { BackfillReportRecord, SettingsRecord } from './protocol'
import { isAuthoredItem } from './item-origin'

/** Every kind the product defines. Adding one is a schema decision. */
export const ITEM_KINDS: readonly OpenItemKind[] = [
  'decision',
  'approval',
  'question',
  'plan-review',
  'blocker',
  'risk',
  'follow-up',
  'task',
]

/** Every lifecycle state. */
export const OPEN_ITEM_STATES: readonly OpenItemState[] = [
  'open',
  'snoozed',
  'awaiting',
  'stale',
  'archived',
  'resolved',
]

/** States that count against the live-item cap (DESIGN §7.3: "open/stale items"). */
export const LIVE_STATES: readonly OpenItemState[] = ['open', 'stale', 'snoozed']

/** States the inbox treats as "needs you". */
export const NEEDS_YOU_STATES: readonly OpenItemState[] = ['open', 'stale']

/** Severities that count as "needs you" (OI-05: severity 3 is FYI). */
export const NEEDS_YOU_SEVERITIES: readonly Severity[] = [1, 2]

/**
 * The locked OI-05 "needs you" predicate, shared by every count surface.
 *
 * One item counts when it is an open/stale **structural** item at severity 1–2
 * and is not a tombstone. Candidates (`tier: 'candidate'`), snoozed items and
 * answered-but-unacknowledged (`awaiting`) items are counted separately — they
 * are not "needs you" (OI-04, OI-05). The nav pill, the tab badges, the
 * per-session counts and the workspace lens all use this one function, so
 * `counts.needsYou === Σ workspaces.itemCount` holds by construction.
 * @param record - any stored record (or the fields a client page row carries).
 * @returns whether it counts as "needs you".
 */
export function isNeedsYouRecord(record: {
  readonly state: OpenItemState
  readonly tier: OpenItemTier
  readonly severity: Severity
  readonly deletedAt?: number
}): boolean {
  if (record.deletedAt !== undefined) return false
  if (record.tier !== 'structural') return false
  if (record.state !== 'open' && record.state !== 'stale') return false
  return record.severity === 1 || record.severity === 2
}

/**
 * Whether a record is a candidate-tier item that is still open (the Candidates
 * tab count; excluded from "needs you" by OI-05).
 * @param record - any stored record.
 * @returns whether it counts as a candidate.
 */
export function isCandidateRecord(record: {
  readonly state: OpenItemState
  readonly tier: OpenItemTier
  readonly deletedAt?: number
}): boolean {
  if (record.deletedAt !== undefined) return false
  return record.tier === 'candidate' && (record.state === 'open' || record.state === 'stale')
}

/** Resolution kinds. */
export const RESOLUTION_KINDS: readonly ResolutionKind[] = ['answered', 'dismissed', 'superseded', 'detected-closed']

/** Who produced a resolution: the human, the model the human answered, or a detector. */
export const RESOLUTION_ACTORS = ['user', 'model', 'detector'] as const

/** Detection sources. */
export const DETECTION_SOURCES: readonly DetectionSource[] = ['projection', 'log-fold', 'regex-gate', 'llm', 'tool', 'user']

/** Delivery tracks. */
export const DELIVERY_TRACKS: readonly DeliveryTrack[] = ['client-settle', 'host-settle', 'session-message']

/** Delivery states. */
export const DELIVERY_STATES: readonly DeliveryState[] = ['sending', 'settled', 'queued', 'delivered', 'acknowledged', 'failed']

/** Delivery failure codes. */
export const DELIVERY_FAILURE_CODES: readonly DeliveryFailureCode[] = [
  'was-not-applied',
  'cannot-apply',
  'session-archived',
  'agent-unavailable',
  'operator-cancelled',
  'unknown-outcome',
  'parked',
]

/** Acknowledgement evidence kinds. */
export const ACKNOWLEDGEMENT_EVIDENCE: readonly AcknowledgementEvidence[] = [
  'tool-result',
  'turn-continued',
  'call-retried',
  'goal-resumed',
  'task-completed',
  'next-turn',
]

/** Title cap from DESIGN §3.5 ("≤120 chars, one line"). */
export const MAX_TITLE_CHARS = 120
/** Body/quote cap from DESIGN §3.5. */
export const MAX_BODY_CHARS = 2000
/** Per-item audit history cap (bounded store document). */
export const MAX_HISTORY_ENTRIES = 50
/** Delivery attempts kept per item (append-only, newest last). */
export const MAX_DELIVERIES = 50
/** Occurrence records kept per item (newest last). */
export const MAX_OCCURRENCES = 50
/** Earlier resolutions kept per item (reopens / re-decisions). */
export const MAX_RESOLUTION_LOG = 50
/** Reply options cap (the card shows a short list). */
export const MAX_OPTIONS = 10
/** One-line dismissal/answer detail kept in history. */
export const MAX_HISTORY_DETAIL_CHARS = 500

/** A stored record (or document read from the medium) failed validation. */
export class InvalidRecordError extends Error {
  constructor(
    readonly path: string,
    readonly problem: string,
  ) {
    super(`invalid open-item record at ${path}: ${problem}`)
    this.name = 'InvalidRecordError'
  }
}

/**
 * Collapse whitespace, trim and cap a title.
 * @param value - candidate title.
 * @returns the normalised title (possibly empty).
 */
export function normalizeTitle(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, MAX_TITLE_CHARS)
}

/**
 * Collapse whitespace, trim and cap a body/quote.
 * @param value - candidate text.
 * @param maxChars - cap.
 * @returns the normalised text (possibly empty).
 */
export function normalizeBody(value: string, maxChars = MAX_BODY_CHARS): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, maxChars)
}

/**
 * Fold text for a dedupe key: case-insensitive, whitespace-collapsed.
 * @param value - raw text.
 * @returns the folded form.
 */
export function foldText(value: string): string {
  return normalizeTitle(value).toLowerCase()
}

/**
 * Collapse one prose title/quote to its *ask identity*.
 *
 * Reconciliation must tell a true duplicate of a promoted decision apart from
 * its unconfirmed siblings in the same multi-item turn (contract §2.2 as
 * narrowed by the Lead): the two sides were stored by different gate versions,
 * so identity cannot be a byte comparison. The normalisation strips the shape
 * the two representations differ in — markdown emphasis/code markers, leading
 * heading/bullet/blockquote marks, the answer label (`E — …`, `(E) …`, `E: …`,
 * `1) …`) and case/whitespace — and compares what is left.
 *
 * Keep it pure and table-testable; it is display-independent and never throws.
 * @param text - a stored title or quote.
 * @returns the comparable ask identity (empty for blank input).
 */
export function proseAskKey(text: string): string {
  // Inline markdown markers: `**A** — …`, `` `x` ``, `~~x~~`.
  let value = text.replace(/[*_`~]+/gu, '')
  // Leading heading/bullet/blockquote marks, possibly stacked (`- **E** …` is
  // already unwrapped above; `## Decisions` is not).
  value = value.replace(/^\s*(?:(?:#{1,6}|[-+>•])\s*)+/u, '')
  // A bracket-closed answer label: `(E) …`, `(E) — …`, `[E] …`, `E) …`.
  value = value.replace(/^\s*[([{]?[a-z0-9]{1,2}[)\]}][\s.:·—–-]*/iu, '')
  // A label with an explicit separator: `E — …`, `E: …`, `E. …`, `1) …`.
  value = value.replace(/^\s*[a-z0-9]{1,2}\s*[—–:.)·-]\s*/iu, '')
  return value.replace(/\s+/gu, ' ').trim().toLowerCase()
}

/**
 * Dedupe key of an authored item: same kind + title + session re-raises one item.
 * @param input - kind, session id and title.
 * @returns the stable key.
 */
export function authoredDedupeKey(input: {
  readonly kind: OpenItemKind
  readonly sessionId: string
  readonly title: string
}): string {
  return `authored|${input.kind}|${input.sessionId}|${foldText(input.title)}`
}

/**
 * Dedupe key of a derived item: one artifact per session is one item.
 * @param input - kind, session id and artifact id.
 * @returns the stable key.
 */
export function derivedDedupeKey(input: {
  readonly kind: OpenItemKind
  readonly sessionId: string
  readonly artifactId: string
}): string {
  return `derived|${input.kind}|${input.sessionId}|${input.artifactId}`
}

/**
 * Split one derived dedupe key back into the identity it was built from.
 *
 * The record does not store `artifactId` separately, so an in-place correction
 * that changes the kind (kind is part of the key) must parse the old key to
 * rebuild it. Kind is a closed enum, session ids contain no `|` and artifact ids
 * are `<family>:<id>`, so the first three separators are unambiguous and
 * everything after the third belongs to the artifact.
 * @param key - a stored `derived|<kind>|<sessionId>|<artifactId>` key.
 * @returns the parts, or undefined when the key is not a derived key.
 */
export function parseDerivedDedupeKey(key: string): {
  readonly kind: OpenItemKind
  readonly sessionId: string
  readonly artifactId: string
} | undefined {
  const parts = key.split('|')
  if (parts.length < 4 || parts[0] !== 'derived') return undefined
  const kind = parts[1]
  const sessionId = parts[2]
  if (kind === undefined || !(ITEM_KINDS as readonly string[]).includes(kind)) return undefined
  if (sessionId === undefined || sessionId === '') return undefined
  const artifactId = parts.slice(3).join('|')
  if (artifactId === '') return undefined
  return { kind: kind as OpenItemKind, sessionId, artifactId }
}

/**
 * Whether a record was raised by a human/tool rather than detected structurally.
 * @param record - stored record.
 * @returns true for authored records.
 */
export function isAuthored(record: OpenItemRecord): boolean {
  return isAuthoredItem(record)
}

/**
 * The default reply surface for one kind: which controls the inbox renders.
 * @param kind - item kind.
 * @param options - verbatim choices, when the artifact carried them.
 * @returns the reply descriptor.
 */
export function defaultReply(kind: OpenItemKind, options?: readonly string[]): ReplyDescriptor {
  const bounded = options === undefined ? undefined : options.slice(0, MAX_OPTIONS)
  switch (kind) {
    case 'approval':
      return {
        controls: ['approve', 'deny'],
        ...(bounded === undefined || bounded.length === 0 ? {} : { options: bounded }),
        freeText: true,
        requiresConfirm: false,
      }
    case 'question':
      return {
        controls: bounded === undefined || bounded.length === 0 ? ['text'] : ['option', 'text'],
        ...(bounded === undefined ? {} : { options: bounded }),
        freeText: true,
        requiresConfirm: false,
      }
    case 'task':
      return { controls: ['task-action', 'text'], freeText: true, requiresConfirm: false }
    case 'plan-review':
      return { controls: ['text'], freeText: true, requiresConfirm: false }
    default:
      return {
        controls: bounded === undefined || bounded.length === 0 ? ['text'] : ['option', 'text'],
        ...(bounded === undefined ? {} : { options: bounded }),
        freeText: true,
        requiresConfirm: false,
      }
  }
}

/** One audit entry, capped and detail-truncated. */
function historyEntry(at: number, action: string, detail?: string): HistoryEntry {
  const bounded = detail === undefined ? undefined : detail.slice(0, MAX_HISTORY_DETAIL_CHARS)
  return { at, action, ...(bounded === undefined || bounded === '' ? {} : { detail: bounded }) }
}

/**
 * Append one audit entry, enforcing the cap (oldest first drop).
 * @param history - current entries.
 * @param at - timestamp.
 * @param action - action name.
 * @param detail - optional short detail.
 * @returns the new history array.
 */
export function appendHistory(
  history: readonly HistoryEntry[],
  at: number,
  action: string,
  detail?: string,
): readonly HistoryEntry[] {
  return [...history, historyEntry(at, action, detail)].slice(-MAX_HISTORY_ENTRIES)
}

/* ------------------------------------------------------------------ *
 * Durable-boundary validation
 * ------------------------------------------------------------------ */

/** Read one required plain object. */
function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRecordError(path, 'expected an object')
  }
  return value as Record<string, unknown>
}

/** Read one required string. */
function expectString(value: unknown, path: string, maxChars: number): string {
  if (typeof value !== 'string') throw new InvalidRecordError(path, 'expected a string')
  if (value.length > maxChars) throw new InvalidRecordError(path, `longer than ${maxChars} characters`)
  return value
}

/** Read one required non-empty string. */
function expectNonEmptyString(value: unknown, path: string, maxChars: number): string {
  if (typeof value === 'string' && value.trim() === '') throw new InvalidRecordError(path, 'expected a non-empty string')
  return expectString(value, path, maxChars)
}

/** Read one optional string. */
function optionalString(value: unknown, path: string, maxChars: number): string | undefined {
  if (value === undefined) return undefined
  return expectString(value, path, maxChars)
}

/** Read one required enum member. */
function expectEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new InvalidRecordError(path, `expected one of ${allowed.join(', ')}`)
  }
  return value as T
}

/** Read one optional enum member. */
function optionalEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined
  return expectEnum(value, path, allowed)
}

/** Read one required non-negative safe integer. */
function expectInteger(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new InvalidRecordError(path, `expected a safe integer >= ${minimum}`)
  }
  return value
}

/** Read one optional non-negative safe integer. */
function optionalInteger(value: unknown, path: string, minimum = 0): number | undefined {
  if (value === undefined) return undefined
  return expectInteger(value, path, minimum)
}

/** Read one required boolean. */
function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new InvalidRecordError(path, 'expected a boolean')
  return value
}

/** Read one optional boolean. */
function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined
  return expectBoolean(value, path)
}

/** Read a required array. */
function expectArray(value: unknown, path: string, maxItems?: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new InvalidRecordError(path, 'expected an array')
  if (maxItems !== undefined && value.length > maxItems) {
    throw new InvalidRecordError(path, `longer than the ${maxItems}-item cap`)
  }
  return value
}

/** Parse one workspace snapshot. */
function parseWorkspace(value: unknown, path: string): WorkspaceRef | undefined {
  if (value === undefined) return undefined
  const record = expectObject(value, path)
  const workspaceId = optionalString(record['workspaceId'], `${path}.workspaceId`, 128)
  const title = optionalString(record['title'], `${path}.title`, MAX_TITLE_CHARS)
  const pathValue = optionalString(record['path'], `${path}.path`, 4096)
  return {
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(title === undefined ? {} : { title }),
    ...(pathValue === undefined ? {} : { path: pathValue }),
  }
}

/** Parse one source ref. */
function parseSource(value: unknown, path: string): ItemSourceRef {
  const record = expectObject(value, path)
  const sessionId = expectNonEmptyString(record['sessionId'], `${path}.sessionId`, 256)
  const sessionTitle = optionalString(record['sessionTitle'], `${path}.sessionTitle`, MAX_TITLE_CHARS)
  const workspace = parseWorkspace(record['workspace'], `${path}.workspace`)
  const cwd = optionalString(record['cwd'], `${path}.cwd`, 4096)
  const seq = optionalInteger(record['seq'], `${path}.seq`)
  const turn = optionalInteger(record['turn'], `${path}.turn`)
  const callId = optionalString(record['callId'], `${path}.callId`, 256)
  const messageId = optionalString(record['messageId'], `${path}.messageId`, 256)
  const approvalId = optionalString(record['approvalId'], `${path}.approvalId`, 256)
  const goalId = optionalString(record['goalId'], `${path}.goalId`, 256)
  const goalRevision = optionalInteger(record['goalRevision'], `${path}.goalRevision`)
  const taskId = optionalString(record['taskId'], `${path}.taskId`, 256)
  const jobId = optionalString(record['jobId'], `${path}.jobId`, 256)
  let raisedBy: { sessionId: string; title?: string } | undefined
  if (record['raisedBy'] !== undefined) {
    const raised = expectObject(record['raisedBy'], `${path}.raisedBy`)
    const raisedSessionId = expectNonEmptyString(raised['sessionId'], `${path}.raisedBy.sessionId`, 256)
    const raisedTitle = optionalString(raised['title'], `${path}.raisedBy.title`, MAX_TITLE_CHARS)
    raisedBy = { sessionId: raisedSessionId, ...(raisedTitle === undefined ? {} : { title: raisedTitle }) }
  }
  return {
    sessionId,
    ...(sessionTitle === undefined ? {} : { sessionTitle }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(seq === undefined ? {} : { seq }),
    ...(turn === undefined ? {} : { turn }),
    ...(callId === undefined ? {} : { callId }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(goalId === undefined ? {} : { goalId }),
    ...(goalRevision === undefined ? {} : { goalRevision }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(jobId === undefined ? {} : { jobId }),
    ...(raisedBy === undefined ? {} : { raisedBy }),
  }
}

/** Parse one reply payload. */
function parseReplyPayload(value: unknown, path: string): ReplyPayload {
  const record = expectObject(value, path)
  const type = expectEnum(record['type'], `${path}.type`, ['option', 'text', 'approval', 'task-action', 'dismiss'] as const)
  switch (type) {
    case 'option':
      return { type, option: expectString(record['option'], `${path}.option`, MAX_BODY_CHARS) }
    case 'text':
      return { type, text: expectString(record['text'], `${path}.text`, MAX_BODY_CHARS) }
    case 'approval': {
      const outcome = expectEnum(record['outcome'], `${path}.outcome`, ['allow-once', 'deny'] as const)
      const note = optionalString(record['note'], `${path}.note`, MAX_HISTORY_DETAIL_CHARS)
      return { type, outcome, ...(note === undefined ? {} : { note }) }
    }
    case 'task-action': {
      const action = expectString(record['action'], `${path}.action`, 256)
      const note = optionalString(record['note'], `${path}.note`, MAX_HISTORY_DETAIL_CHARS)
      return { type, action, ...(note === undefined ? {} : { note }) }
    }
    case 'dismiss': {
      const reason = optionalString(record['reason'], `${path}.reason`, MAX_HISTORY_DETAIL_CHARS)
      return { type, ...(reason === undefined ? {} : { reason }) }
    }
  }
}

/** Parse one evidence ref. */
function parseEvidence(value: unknown, path: string): { seq?: number; messageId?: string; callId?: string; inboxId?: string } | undefined {
  if (value === undefined) return undefined
  const record = expectObject(value, path)
  const seq = optionalInteger(record['seq'], `${path}.seq`)
  const messageId = optionalString(record['messageId'], `${path}.messageId`, 256)
  const callId = optionalString(record['callId'], `${path}.callId`, 256)
  const inboxId = optionalString(record['inboxId'], `${path}.inboxId`, 256)
  return {
    ...(seq === undefined ? {} : { seq }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(callId === undefined ? {} : { callId }),
    ...(inboxId === undefined ? {} : { inboxId }),
  }
}

/** Parse one delivery record. */
export function parseDeliveryRecord(value: unknown, path: string): DeliveryRecord {
  const record = expectObject(value, path)
  const deliveryId = expectNonEmptyString(record['deliveryId'], `${path}.deliveryId`, 128)
  const at = expectInteger(record['at'], `${path}.at`)
  const track = expectEnum(record['track'], `${path}.track`, DELIVERY_TRACKS)
  const payload = parseReplyPayload(record['payload'], `${path}.payload`)
  const state = expectEnum(record['state'], `${path}.state`, DELIVERY_STATES)
  const evidence = parseEvidence(record['evidence'], `${path}.evidence`)
  let failure: { code: DeliveryFailureCode; message: string } | undefined
  if (record['failure'] !== undefined) {
    const failureRecord = expectObject(record['failure'], `${path}.failure`)
    failure = {
      code: expectEnum(failureRecord['code'], `${path}.failure.code`, DELIVERY_FAILURE_CODES),
      message: expectString(failureRecord['message'], `${path}.failure.message`, MAX_BODY_CHARS),
    }
  }
  return {
    deliveryId,
    at,
    track,
    payload,
    state,
    ...(evidence === undefined ? {} : { evidence }),
    ...(failure === undefined ? {} : { failure }),
  }
}

/** Parse one resolution. */
export function parseResolution(value: unknown, path: string): Resolution {
  const record = expectObject(value, path)
  const kind = expectEnum(record['kind'], `${path}.kind`, RESOLUTION_KINDS)
  const at = expectInteger(record['at'], `${path}.at`)
  const actor = expectEnum(record['actor'], `${path}.actor`, RESOLUTION_ACTORS)
  let payload: Resolution['payload']
  if (typeof record['payload'] === 'object' && record['payload'] !== null
    && (record['payload'] as Record<string, unknown>)['type'] === 'detector') {
    const detector = expectObject(record['payload'], `${path}.payload`)
    payload = { type: 'detector', code: expectString(detector['code'], `${path}.payload.code`, 256) }
  } else {
    payload = parseReplyPayload(record['payload'], `${path}.payload`)
  }
  const deliveryId = optionalString(record['deliveryId'], `${path}.deliveryId`, 128)
  const evidence = parseEvidence(record['evidence'], `${path}.evidence`)
  return {
    kind,
    at,
    actor,
    payload,
    ...(deliveryId === undefined ? {} : { deliveryId }),
    ...(evidence === undefined ? {} : { evidence }),
  }
}

/** Parse one acknowledgement. */
function parseAcknowledgement(value: unknown, path: string): Acknowledgement | undefined {
  if (value === undefined) return undefined
  const record = expectObject(value, path)
  const state = expectEnum(record['state'], `${path}.state`, ['pending', 'observed', 'none'] as const)
  const at = optionalInteger(record['at'], `${path}.at`)
  let evidence: Acknowledgement['evidence']
  if (record['evidence'] !== undefined) {
    const evidenceRecord = expectObject(record['evidence'], `${path}.evidence`)
    evidence = {
      ...(evidenceRecord['seq'] === undefined ? {} : { seq: expectInteger(evidenceRecord['seq'], `${path}.evidence.seq`) }),
      kind: expectEnum(evidenceRecord['kind'], `${path}.evidence.kind`, ACKNOWLEDGEMENT_EVIDENCE),
    }
  }
  return { state, ...(at === undefined ? {} : { at }), ...(evidence === undefined ? {} : { evidence }) }
}

/** Parse the retention class. */
function parseRetention(value: unknown, path: string): Retention {
  const record = expectObject(value, path)
  const retentionClass = expectEnum(record['class'], `${path}.class`, ['active', 'archived'] as const)
  const archivedAt = optionalInteger(record['archivedAt'], `${path}.archivedAt`)
  return { class: retentionClass, ...(archivedAt === undefined ? {} : { archivedAt }) }
}

/** Parse the reply descriptor. */
function parseReplyDescriptor(value: unknown, path: string): ReplyDescriptor {
  const record = expectObject(value, path)
  const controls = expectArray(record['controls'], `${path}.controls`).map((entry, index) =>
    expectEnum(entry, `${path}.controls[${index}]`, ['option', 'text', 'approve', 'deny', 'task-action'] as const))
  const options = record['options'] === undefined
    ? undefined
    : expectArray(record['options'], `${path}.options`, MAX_OPTIONS)
      .map((entry, index) => expectString(entry, `${path}.options[${index}]`, MAX_BODY_CHARS))
  const note = optionalString(record['note'], `${path}.note`, MAX_HISTORY_DETAIL_CHARS)
  return {
    controls,
    ...(options === undefined ? {} : { options }),
    freeText: expectBoolean(record['freeText'], `${path}.freeText`),
    requiresConfirm: expectBoolean(record['requiresConfirm'], `${path}.requiresConfirm`),
    ...(note === undefined ? {} : { note }),
  }
}

/** Parse one occurrence. */
function parseOccurrence(value: unknown, path: string): { sessionId: string; seq?: number; seenAt: number } {
  const record = expectObject(value, path)
  const seq = optionalInteger(record['seq'], `${path}.seq`)
  return {
    sessionId: expectNonEmptyString(record['sessionId'], `${path}.sessionId`, 256),
    ...(seq === undefined ? {} : { seq }),
    seenAt: expectInteger(record['seenAt'], `${path}.seenAt`),
  }
}

/** Parse one history entry. */
function parseHistoryEntry(value: unknown, path: string): HistoryEntry {
  const record = expectObject(value, path)
  const detail = optionalString(record['detail'], `${path}.detail`, MAX_HISTORY_DETAIL_CHARS)
  return {
    at: expectInteger(record['at'], `${path}.at`),
    action: expectNonEmptyString(record['action'], `${path}.action`, 64),
    ...(detail === undefined ? {} : { detail }),
  }
}

/**
 * Validate and normalise one stored item record.
 * @param value - untrusted JSON value from the medium.
 * @param path - diagnostic path.
 * @returns the validated record.
 * @throws {InvalidRecordError} when a required field or invariant is broken.
 */
export function parseItemRecord(value: unknown, path = 'item'): OpenItemRecord {
  const record = expectObject(value, path)
  const schemaVersion = expectInteger(record['schemaVersion'], `${path}.schemaVersion`, 1)
  if (schemaVersion !== 3) throw new InvalidRecordError(`${path}.schemaVersion`, 'only schema version 3 is supported')
  const id = expectNonEmptyString(record['id'], `${path}.id`, 128)
  const origin = expectNonEmptyString(record['origin'], `${path}.origin`, 128)
  const kind = expectEnum(record['kind'], `${path}.kind`, ITEM_KINDS)
  const state = expectEnum(record['state'], `${path}.state`, OPEN_ITEM_STATES)
  const tier = expectEnum(record['tier'], `${path}.tier`, ['structural', 'candidate'] as const)
  const severity = expectInteger(record['severity'], `${path}.severity`, 1)
  if (severity > 3) throw new InvalidRecordError(`${path}.severity`, 'expected 1, 2 or 3')
  const title = expectNonEmptyString(record['title'], `${path}.title`, MAX_TITLE_CHARS)
  const body = expectString(record['body'], `${path}.body`, MAX_BODY_CHARS)
  const quote = optionalString(record['quote'], `${path}.quote`, MAX_BODY_CHARS)
  const options = record['options'] === undefined
    ? undefined
    : expectArray(record['options'], `${path}.options`, MAX_OPTIONS)
      .map((entry, index) => expectString(entry, `${path}.options[${index}]`, MAX_BODY_CHARS))
  const source = parseSource(record['source'], `${path}.source`)
  const blocking = expectBoolean(record['blocking'], `${path}.blocking`)
  const reply = parseReplyDescriptor(record['reply'], `${path}.reply`)
  const deliveries = expectArray(record['deliveries'], `${path}.deliveries`, MAX_DELIVERIES)
    .map((entry, index) => parseDeliveryRecord(entry, `${path}.deliveries[${index}]`))
  const occurrences = expectArray(record['occurrences'], `${path}.occurrences`, MAX_OCCURRENCES)
    .map((entry, index) => parseOccurrence(entry, `${path}.occurrences[${index}]`))
  const dedupeKey = expectNonEmptyString(record['dedupeKey'], `${path}.dedupeKey`, 1024)
  const detectedBy = expectArray(record['detectedBy'], `${path}.detectedBy`)
    .map((entry, index) => expectEnum(entry, `${path}.detectedBy[${index}]`, DETECTION_SOURCES))
  const firstSeenAt = expectInteger(record['firstSeenAt'], `${path}.firstSeenAt`)
  const lastSeenAt = expectInteger(record['lastSeenAt'], `${path}.lastSeenAt`)
  const updatedAt = expectInteger(record['updatedAt'], `${path}.updatedAt`)
  const version = expectInteger(record['version'], `${path}.version`, 1)
  const snoozedUntil = optionalInteger(record['snoozedUntil'], `${path}.snoozedUntil`)
  const resolution = record['resolution'] === undefined ? undefined : parseResolution(record['resolution'], `${path}.resolution`)
  const resolutionLog = record['resolutionLog'] === undefined
    ? undefined
    : expectArray(record['resolutionLog'], `${path}.resolutionLog`, MAX_RESOLUTION_LOG)
      .map((entry, index) => parseResolution(entry, `${path}.resolutionLog[${index}]`))
  const acknowledgement = parseAcknowledgement(record['acknowledgement'], `${path}.acknowledgement`)
  const resolvedAt = optionalInteger(record['resolvedAt'], `${path}.resolvedAt`)
  const reopenCount = expectInteger(record['reopenCount'], `${path}.reopenCount`)
  const retention = parseRetention(record['retention'], `${path}.retention`)
  const history = expectArray(record['history'], `${path}.history`, MAX_HISTORY_ENTRIES)
    .map((entry, index) => parseHistoryEntry(entry, `${path}.history[${index}]`))
  const deletedAt = optionalInteger(record['deletedAt'], `${path}.deletedAt`)

  if (lastSeenAt < firstSeenAt) throw new InvalidRecordError(`${path}.lastSeenAt`, 'earlier than firstSeenAt')
  if (updatedAt < firstSeenAt) throw new InvalidRecordError(`${path}.updatedAt`, 'earlier than firstSeenAt')
  if (state === 'resolved' && resolution === undefined) {
    throw new InvalidRecordError(`${path}.resolution`, 'required while state is resolved')
  }
  if (state === 'resolved' && resolvedAt === undefined) {
    throw new InvalidRecordError(`${path}.resolvedAt`, 'required while state is resolved')
  }
  if (state === 'awaiting' && acknowledgement === undefined) {
    throw new InvalidRecordError(`${path}.acknowledgement`, 'required while state is awaiting')
  }

  return {
    schemaVersion: 3,
    id,
    origin,
    kind,
    state,
    tier,
    severity: severity as Severity,
    title,
    body,
    ...(quote === undefined ? {} : { quote }),
    ...(options === undefined ? {} : { options }),
    source,
    blocking,
    reply,
    deliveries,
    occurrences,
    dedupeKey,
    detectedBy,
    firstSeenAt,
    lastSeenAt,
    updatedAt,
    version,
    ...(snoozedUntil === undefined ? {} : { snoozedUntil }),
    ...(resolution === undefined ? {} : { resolution }),
    ...(resolutionLog === undefined ? {} : { resolutionLog }),
    ...(acknowledgement === undefined ? {} : { acknowledgement }),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    reopenCount,
    retention,
    history,
    ...(deletedAt === undefined ? {} : { deletedAt }),
  }
}

/** Validate one detection cursor. */
export function parseDetectionCursor(value: unknown, path = 'cursor'): DetectionCursor {
  const record = expectObject(value, path)
  const cacheWatermark = optionalInteger(record['cacheWatermark'], `${path}.cacheWatermark`)
  return {
    sessionId: expectNonEmptyString(record['sessionId'], `${path}.sessionId`, 256),
    lastScannedSeq: expectInteger(record['lastScannedSeq'], `${path}.lastScannedSeq`),
    lastEventTime: expectInteger(record['lastEventTime'], `${path}.lastEventTime`),
    lastScanAt: expectInteger(record['lastScanAt'], `${path}.lastScanAt`),
    ...(cacheWatermark === undefined ? {} : { cacheWatermark }),
    foldVersion: expectInteger(record['foldVersion'], `${path}.foldVersion`),
  }
}

/** Validate one suppressor. */
export function parseSuppressorRecord(value: unknown, path = 'suppressor'): SuppressorRecord {
  const record = expectObject(value, path)
  const expiresAt = optionalInteger(record['expiresAt'], `${path}.expiresAt`)
  return {
    dedupePrefix: expectNonEmptyString(record['dedupePrefix'], `${path}.dedupePrefix`, 1024),
    kindFamily: expectEnum(record['kindFamily'], `${path}.kindFamily`, ITEM_KINDS),
    createdAt: expectInteger(record['createdAt'], `${path}.createdAt`),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/** Validate the install record. */
export function parseInstallRecord(value: unknown, path = 'install'): InstallRecord {
  const record = expectObject(value, path)
  return {
    installId: expectNonEmptyString(record['installId'], `${path}.installId`, 128),
    createdAt: expectInteger(record['createdAt'], `${path}.createdAt`),
  }
}

/**
 * Validate one settings record (the `meta` table's `settings` key).
 *
 * `version: 0` is the unstored default record: it is never materialised on
 * read, only produced by {@link import('./protocol').DEFAULT_SETTINGS} and by
 * this validator's callers.
 *
 * A row written before `llmExtraction` existed is still valid: the absent field
 * means `false` (the opt-in default), so an upgrade never invalidates the
 * user's settings row.
 * @param value - untrusted JSON value from the medium.
 * @param path - diagnostic path.
 * @returns the validated settings record.
 * @throws {InvalidRecordError} when a field or invariant is broken.
 */
export function parseSettingsRecord(value: unknown, path = 'settings'): SettingsRecord {
  const record = expectObject(value, path)
  const schemaVersion = expectInteger(record['schemaVersion'], `${path}.schemaVersion`, 1)
  if (schemaVersion !== 1) throw new InvalidRecordError(`${path}.schemaVersion`, 'only settings schema version 1 is supported')
  return {
    schemaVersion: 1,
    version: expectInteger(record['version'], `${path}.version`),
    modelNudge: expectBoolean(record['modelNudge'], `${path}.modelNudge`),
    proseCandidates: expectBoolean(record['proseCandidates'], `${path}.proseCandidates`),
    // Absent on rows written before the field was added: opt-in stays off.
    llmExtraction: record['llmExtraction'] === undefined
      ? false
      : expectBoolean(record['llmExtraction'], `${path}.llmExtraction`),
  }
}

/** Backfill pass triggers (`BackfillReportRecord.trigger`). */
export const BACKFILL_TRIGGERS = ['activation', 'rescan'] as const

/**
 * Validate one durable backfill report (the `meta` table's `backfill` key).
 * @param value - untrusted JSON value from the medium.
 * @param path - diagnostic path.
 * @returns the validated report.
 * @throws {InvalidRecordError} when a field is missing or malformed.
 */
export function parseBackfillReportRecord(value: unknown, path = 'backfill'): BackfillReportRecord {
  const record = expectObject(value, path)
  const schemaVersion = expectInteger(record['schemaVersion'], `${path}.schemaVersion`, 1)
  if (schemaVersion !== 1) throw new InvalidRecordError(`${path}.schemaVersion`, 'only backfill report schema version 1 is supported')
  const trigger = expectEnum(record['trigger'], `${path}.trigger`, BACKFILL_TRIGGERS)
  return {
    schemaVersion: 1,
    at: expectInteger(record['at'], `${path}.at`),
    trigger,
    eligible: expectInteger(record['eligible'], `${path}.eligible`),
    folded: expectInteger(record['folded'], `${path}.folded`),
    skipped: expectInteger(record['skipped'], `${path}.skipped`),
    failed: expectInteger(record['failed'], `${path}.failed`),
    drafts: expectInteger(record['drafts'], `${path}.drafts`),
    batches: expectInteger(record['batches'], `${path}.batches`),
    deferred: expectInteger(record['deferred'], `${path}.deferred`),
    durationMs: expectInteger(record['durationMs'], `${path}.durationMs`),
  }
}

/**
 * A row of the `meta` table. One table holds three shapes (install identity,
 * the one settings record, the last backfill report); the durable format is
 * unchanged and the domain version stays 1.
 */
export type MetaRecord = InstallRecord | SettingsRecord | BackfillReportRecord

/**
 * Whether one `meta` row is the install identity.
 * @param record - validated meta row.
 * @returns true for the install record.
 */
export function isInstallRecord(record: MetaRecord): record is InstallRecord {
  return 'installId' in record
}

/**
 * Whether one `meta` row is the durable backfill report.
 * @param record - validated meta row.
 * @returns true for the report record.
 */
export function isBackfillReportRecord(record: MetaRecord): record is BackfillReportRecord {
  return 'trigger' in record
}

/**
 * Whether one `meta` row is the settings record.
 * @param record - validated meta row.
 * @returns true for the settings record.
 */
export function isSettingsRecord(record: MetaRecord): record is SettingsRecord {
  return !isInstallRecord(record) && !isBackfillReportRecord(record)
}

/**
 * Validate one `meta` table row, dispatching on its shape.
 *
 * The settings record and the backfill report share the `meta` table rather
 * than adding tables (which would change the domain format): the install row is
 * keyed `install` and identifies itself by `installId`, the settings row is
 * keyed `settings` (booleans + `schemaVersion`), and the report is keyed
 * `backfill` (a `trigger` that neither other shape has).
 * @param value - untrusted JSON value from the medium.
 * @param path - diagnostic path.
 * @returns the validated meta row.
 * @throws {InvalidRecordError} when the row matches none of the shapes.
 */
export function parseMetaRecord(value: unknown, path = 'meta'): MetaRecord {
  const record = expectObject(value, path)
  if (record['installId'] !== undefined) return parseInstallRecord(value, path)
  if (record['trigger'] !== undefined) return parseBackfillReportRecord(value, path)
  if (record['schemaVersion'] !== undefined || record['modelNudge'] !== undefined
    || record['proseCandidates'] !== undefined || record['llmExtraction'] !== undefined) {
    return parseSettingsRecord(value, path)
  }
  throw new InvalidRecordError(path, 'unknown meta record shape')
}

/**
 * Wrap a record validator as the domain's schema adapter.
 *
 * The storage domain declares table schemas as `ZodType<V>` and the runtime
 * only calls `parse` on them; the manifest is frozen for this branch, so this
 * adapter supplies that exact subset (see the module header).
 * @param parse - the validator.
 * @returns the schema value the domain spec accepts.
 */
export function asDomainSchema<T>(parse: (value: unknown) => T): Parameters<typeof import('@deepseek-ai/dsh-storage-domain').domainTable<string, T>>[0] {
  return { parse } as unknown as Parameters<typeof import('@deepseek-ai/dsh-storage-domain').domainTable<string, T>>[0]
}
