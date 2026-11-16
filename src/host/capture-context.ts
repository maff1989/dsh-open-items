/**
 * Host wiring for the capture engine: the cold-read, roster and cursor seams
 * built from the optional rc.1 services the profile happens to mount.
 *
 * The capture engine itself is pure (see `capture.ts`, `folds/`); this module is
 * the only place that knows the concrete Host services:
 *
 * - `sessionQuery` — the persisted-log corpus (`listSessions`: every stored
 *   session; `readSession`: committed events). This is the backfill catalog:
 *   `sessionController.list()` is the *visible* sidebar view and only surfaces
 *   resident sessions plus the cold rows it chooses to summarise, which is not
 *   the corpus a historical pass must scan.
 * - `sessionController` — optional roster enrichment: live activity
 *   (`updatedAt`), `running`, titles, and the orphan liveness gate.
 * - `workspaceRegistry` — membership for the workspace snapshot; ownership is
 *   membership in `sessionIds`, never a `cwd` heuristic (DESIGN §5.10).
 *
 * Every seam degrades: without `sessionQuery` there is no backfill (the live
 * projection path still runs), and without the workspace registry items simply
 * carry no workspace snapshot.
 *
 * @module dsh-open-items/host/capture-context
 */

import type { Context } from '@deepseek-ai/cordis'

import type { CaptureContext, CaptureEvent, CaptureSessionInfo } from './capture-contract'
import type { DetectionCursorStore } from './backfill'
import type { OpenItemsStore } from './store'
import type { WorkspaceRef } from '../shared/schema'

/** Structural summary of one Session row; the installed service satisfies it. */
interface SessionSummaryLike {
  readonly sessionId?: unknown
  readonly updatedAt?: unknown
  readonly running?: unknown
  readonly cwd?: unknown
  readonly origin?: unknown
  readonly delegationDepth?: unknown
  readonly projections?: { readonly values?: Readonly<Record<string, unknown>> }
}

/** Structural slice of `ctx.sessionController`. */
interface SessionListLike {
  list(
    request: unknown,
    signal?: AbortSignal,
  ): Promise<{ readonly items?: readonly SessionSummaryLike[] } | readonly SessionSummaryLike[]>
}

/** One persisted Session record as `sessionQuery.listSessions` returns it. */
interface SessionRecordLike {
  readonly header?: {
    readonly id?: unknown
    readonly createdAt?: unknown
    readonly cwd?: unknown
    readonly origin?: unknown
    readonly delegationDepth?: unknown
    readonly parentSession?: unknown
  }
  readonly live?: unknown
  readonly persisted?: unknown
}

/** Structural slice of `ctx.sessionQuery` (the persisted-log corpus). */
interface SessionQueryLike {
  listSessions?(signal?: AbortSignal): Promise<readonly SessionRecordLike[]>
  readSession(sessionId: string, options?: unknown): Promise<{
    readonly events?: readonly { readonly seq: number; readonly type: string; readonly time: number; readonly data: unknown }[]
  }>
}

/** Structural slice of one workspace record. */
interface WorkspaceLike {
  readonly workspaceId?: unknown
  readonly title?: unknown
  readonly path?: unknown
  readonly sessionIds?: readonly unknown[]
}

/** Structural slice of `ctx.workspaceRegistry`. */
interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[]
  readonly archivedSessionIds?: readonly string[]
}

/** The seams the capture registration consumes. */
export interface HostCaptureSeams {
  readonly context: CaptureContext
  readonly cursors: DetectionCursorStore
  readonly isSessionRunning: ((sessionId: string) => boolean | undefined) | undefined
}

/** How long the roster snapshot is reused by the liveness gate. */
/** Read an optional service without widening the Context service table. */
function serviceOf<T>(ctx: Context, name: string): T | undefined {
  const getter = ctx as unknown as { get(name: string): unknown }
  try {
    const value = getter.get(name)
    return value === undefined ? undefined : (value as T)
  } catch {
    return undefined
  }
}

/** Normalize either roster shape to a flat array. */
function rowsOf(list: { readonly items?: readonly SessionSummaryLike[] } | readonly SessionSummaryLike[]): readonly SessionSummaryLike[] {
  return Array.isArray(list) ? list : (list as { readonly items?: readonly SessionSummaryLike[] }).items ?? []
}

/** One projection value as a trimmed non-empty string, or undefined. */
function projectionText(summary: SessionSummaryLike, key: string): string | undefined {
  const value = summary.projections?.values?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Build a session→workspace resolver from the durable workspace registry.
 *
 * Ownership is membership in `sessionIds` (DESIGN §5.10), never a `cwd`
 * heuristic; the first workspace in durable order wins, and no match means
 * "Ungrouped". The tool raise path and the capture seams share this resolver.
 * @param ctx - Host plugin context.
 * @returns the resolver, or undefined when no workspace registry is mounted.
 */
export function createHostWorkspaceResolver(
  ctx: Context,
): ((sessionId: string) => WorkspaceRef | undefined) | undefined {
  const registry = serviceOf<WorkspaceRegistryLike>(ctx, 'workspaceRegistry')
  if (registry === undefined) return undefined
  /** Registry list, tolerating a throwing service. */
  const list = (): readonly WorkspaceLike[] => {
    try {
      return registry.list() ?? []
    } catch {
      return []
    }
  }
  return (sessionId: string): WorkspaceRef | undefined => {
    for (const workspace of list()) {
      if (!Array.isArray(workspace.sessionIds)) continue
      if (!workspace.sessionIds.includes(sessionId)) continue
      const title = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : undefined
      const path = typeof workspace.path === 'string' && workspace.path !== '' ? workspace.path : undefined
      return {
        ...(typeof workspace.workspaceId === 'string' ? { workspaceId: workspace.workspaceId } : {}),
        ...(title === undefined ? {} : { title }),
        ...(path === undefined ? {} : { path }),
      }
    }
    return undefined
  }
}

/**
 * Build the capture seams from the optional Host services.
 * @param ctx - Host plugin context.
 * @param store - the mounted store, used for cursors.
 * @returns the seams, or undefined when this Host cannot read sessions at all.
 */
export function createHostCaptureSeams(ctx: Context, store: OpenItemsStore): HostCaptureSeams | undefined {
  const query = serviceOf<SessionQueryLike>(ctx, 'sessionQuery')
  if (query === undefined || typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') {
    return undefined
  }
  // The roster is optional enrichment: liveness, live activity time and titles.
  const controller = serviceOf<SessionListLike>(ctx, 'sessionController')
  const registry = serviceOf<WorkspaceRegistryLike>(ctx, 'workspaceRegistry')

  /** Roster cache for the orphan liveness gate; refreshed by `listSessions`. */
  const roster = new Map<string, boolean>()

  const archived = (): ReadonlySet<string> => {
    const ids = registry?.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
  }

  const workspaces = (): readonly WorkspaceLike[] => {
    try {
      return registry?.list() ?? []
    } catch {
      return []
    }
  }

  /** Workspace membership, first match in durable order (never `cwd`). */
  const workspaceOf = (sessionId: string): WorkspaceRef | undefined => {
    for (const workspace of workspaces()) {
      if (!Array.isArray(workspace.sessionIds)) continue
      if (!workspace.sessionIds.includes(sessionId)) continue
      const title = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : undefined
      const path = typeof workspace.path === 'string' && workspace.path !== '' ? workspace.path : undefined
      return {
        ...(typeof workspace.workspaceId === 'string' ? { workspaceId: workspace.workspaceId } : {}),
        ...(title === undefined ? {} : { title }),
        ...(path === undefined ? {} : { path }),
      }
    }
    return undefined
  }

  /** Read the roster rows once per catalog read; absence is not an error. */
  const rosterRows = async (): Promise<readonly SessionSummaryLike[]> => {
    if (controller === undefined) return []
    try {
      return rowsOf(await controller.list({}))
    } catch {
      return []
    }
  }

  /**
   * One persisted record as the fold metadata the engine expects.
   *
   * The persisted header carries the durable facts (id, createdAt, cwd, origin,
   * delegation depth); the roster, when mounted, adds live activity and title.
   * A record without a usable id is skipped rather than guessed.
   * @param record - one `sessionQuery.listSessions` row.
   * @param summary - the matching roster row, when the controller is mounted.
   * @returns capture metadata, or undefined for a malformed record.
   */
  const recordInfoOf = (
    record: SessionRecordLike,
    summary: SessionSummaryLike | undefined,
  ): CaptureSessionInfo | undefined => {
    const header = record.header
    const sessionId = typeof header?.id === 'string' ? header.id : undefined
    if (sessionId === undefined) return undefined
    const headerCreatedAt = typeof header?.createdAt === 'number' && Number.isFinite(header.createdAt)
      ? header.createdAt
      : 0
    const rosterUpdatedAt = summary !== undefined && typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt)
      ? summary.updatedAt
      : undefined
    const title = summary === undefined ? undefined : projectionText(summary, 'title')
    const origin = header?.origin === 'subagent'
      ? 'subagent' as const
      : summary?.origin === 'subagent' ? 'subagent' as const : undefined
    const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
    const delegationDepth = typeof header?.delegationDepth === 'number' ? header.delegationDepth : undefined
    return {
      sessionId,
      // `updatedAt` is the sort/eligibility clock only. It is deliberately NOT a
      // watermark: the installed roster derives it from `max(createdAt,
      // lastPromptAt)`, so it is a *lower* bound on log activity and would hide
      // tool/approval events committed after the last user prompt. `lastActivityAt`
      // (a proven upper bound) is omitted here for the same reason, which makes
      // the backfill re-read the log and decide by cursor coverage.
      updatedAt: rosterUpdatedAt ?? headerCreatedAt,
      archived: archived().has(sessionId),
      ...(title === undefined ? {} : { title }),
      ...(origin === undefined ? {} : { origin }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(delegationDepth === undefined ? {} : { delegationDepth }),
    }
  }

  const context: CaptureContext = {
    async listSessions() {
      // Catalog = every persisted log (the corpus a historical pass must read),
      // not the visible-session view: `sessionController.list()` omits cold
      // sessions the sidebar does not summarise, which silently shrank the
      // backfill to the resident chats.
      const records = await (query.listSessions as NonNullable<SessionQueryLike['listSessions']>)().catch(() => [] as readonly SessionRecordLike[])
      const rows = await rosterRows()
      // Refresh the liveness snapshot on every catalog read: the backfill calls
      // this once per pass and the live path uses the most recent one.
      roster.clear()
      const summaries = new Map<string, SessionSummaryLike>()
      for (const row of rows) {
        if (typeof row.sessionId !== 'string') continue
        summaries.set(row.sessionId, row)
        roster.set(row.sessionId, row.running === true)
      }
      const infos: CaptureSessionInfo[] = []
      for (const record of records) {
        const id = record.header?.id
        if (typeof id !== 'string') continue
        const info = recordInfoOf(record, summaries.get(id))
        if (info !== undefined) infos.push(info)
      }
      return infos
    },
    async readSession(sessionId: string) {
      const snapshot = await query.readSession(sessionId)
      const events = Array.isArray(snapshot.events) ? snapshot.events : []
      const mapped: CaptureEvent[] = []
      for (const event of events) {
        if (typeof event?.seq !== 'number' || typeof event.type !== 'string' || typeof event.time !== 'number') continue
        mapped.push({ seq: event.seq, type: event.type, time: event.time, data: event.data })
      }
      return mapped
    },
    async workspaceOf(sessionId: string) {
      return workspaceOf(sessionId)
    },
  }

  const cursors: DetectionCursorStore = {
    get: sessionId => Promise.resolve(store.getCursor(sessionId)),
    put: cursor => store.putCursor(cursor),
  }

  return {
    context,
    cursors,
    isSessionRunning: (sessionId: string) => roster.get(sessionId),
  }
}
