/**
 * In-memory capture doubles: a recording sink and a scripted CaptureContext.
 *
 * These stay in `tests/` so the production package carries no fake store. The
 * real sink is the store branch's; the capture engine only ever sees the
 * {@link CaptureSink} seam.
 *
 * @module tests/capture/fakes
 */

import type {
  CaptureContext,
  CaptureSessionInfo,
  DerivedItemDraft,
} from '../../src/host/capture-contract'
import type { SessionId } from '../../src/shared/schema'

/** One batch the sink received, in call order. */
export interface RecordedBatch {
  readonly drafts: readonly DerivedItemDraft[]
}

/** A recording CaptureSink. */
export class FakeSink {
  readonly batches: RecordedBatch[] = []
  readonly installId = 'install-test'
  /** When set, the next upsertDerived rejects with this error once. */
  failNext?: Error

  /**
   * @param drafts - drafts applied by one capture flush.
   * @returns the number of drafts handled.
   */
  async upsertDerived(drafts: readonly DerivedItemDraft[]): Promise<number> {
    if (this.failNext !== undefined) {
      const error = this.failNext
      this.failNext = undefined
      throw error
    }
    this.batches.push({ drafts: [...drafts] })
    return drafts.length
  }

  /** Every draft across every batch, flattened. */
  get drafts(): readonly DerivedItemDraft[] {
    return this.batches.flatMap(batch => batch.drafts)
  }

  /** Only the drafts that open or refresh an item. */
  get opens(): readonly DerivedItemDraft[] {
    return this.drafts.filter(draft => draft.closes === undefined)
  }

  /** Only the drafts that close an item. */
  get closes(): readonly DerivedItemDraft[] {
    return this.drafts.filter(draft => draft.closes !== undefined)
  }

  /** Find one open draft by artifact id. */
  open(artifactId: string): DerivedItemDraft | undefined {
    return this.opens.find(draft => draft.artifactId === artifactId)
  }

  /** Every close for one artifact id. */
  closuresOf(artifactId: string): readonly DerivedItemDraft[] {
    return this.closes.filter(draft => draft.closes?.artifactId === artifactId)
  }

  /** Drop every recorded batch (keeps the install identity). */
  reset(): void {
    this.batches.length = 0
  }
}

/** A CaptureContext over a fixed session catalog. */
export class FakeCaptureContext implements CaptureContext {
  private readonly sessions: CaptureSessionInfo[]
  private readonly events: Map<SessionId, readonly { seq: number; type: string; time: number; data: unknown }[]>
  private readonly workspaces: Map<SessionId, { workspaceId?: string; title?: string; path?: string }>
  /** Session ids whose readSession rejects. */
  readonly brokenSessions = new Set<SessionId>()
  /** How many times each session log was read (the watermark's cost signal). */
  readonly readCounts = new Map<SessionId, number>()

  constructor(options: {
    sessions: readonly CaptureSessionInfo[]
    events?: ReadonlyMap<SessionId, readonly { seq: number; type: string; time: number; data: unknown }[]>
    workspaces?: ReadonlyMap<SessionId, { workspaceId?: string; title?: string; path?: string }>
  }) {
    this.sessions = [...options.sessions]
    this.events = new Map(options.events ?? [])
    this.workspaces = new Map(options.workspaces ?? [])
  }

  /** Script the events one session reads; returns this context for chaining. */
  withEvents(sessionId: SessionId, events: readonly { seq: number; type: string; time: number; data: unknown }[]): this {
    this.events.set(sessionId, events)
    return this
  }

  /** @returns the fixed catalog. */
  async listSessions(): Promise<readonly CaptureSessionInfo[]> {
    return this.sessions
  }

  /** @param sessionId - session to read. */
  async readSession(sessionId: SessionId): Promise<readonly { seq: number; type: string; time: number; data: unknown }[]> {
    this.readCounts.set(sessionId, (this.readCounts.get(sessionId) ?? 0) + 1)
    if (this.brokenSessions.has(sessionId)) throw new Error(`readSession refused ${sessionId}`)
    return this.events.get(sessionId) ?? []
  }

  /** @param sessionId - session whose workspace membership to resolve. */
  async workspaceOf(sessionId: SessionId): Promise<{ workspaceId?: string; title?: string; path?: string } | undefined> {
    return this.workspaces.get(sessionId)
  }
}

/**
 * Build one session catalog row.
 *
 * Like the real seam, a row does **not** carry `lastActivityAt`: the installed
 * roster cannot prove a log-activity upper bound, so the backfill re-reads and
 * judges by cursor coverage. A test that wants the proven-activity fast path
 * passes `lastActivityAt` explicitly.
 * @param sessionId - session identity.
 * @param overrides - catalog overrides.
 * @returns one catalog row.
 */
export function sessionInfo(sessionId: SessionId, overrides: Partial<CaptureSessionInfo> = {}): CaptureSessionInfo {
  return {
    sessionId,
    updatedAt: 1_760_000_000_000,
    archived: false,
    ...overrides,
  }
}
