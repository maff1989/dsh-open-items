/**
 * E2E composition harness: the real Host plugin half with fake external services.
 *
 * The point of the M6 composition suite is to prove the *wiring*, not the units:
 * `apply()` mounts the storage-domain store, the service, the tool, the exact
 * Fetch route, the reply engine (bridge included) and the capture engine exactly
 * as a profile does; only services the plugin cannot own (connection carrier,
 * agent registry, session roster/query, workspace registry, storage backend) are
 * faked here.
 *
 * Two compositions are exposed:
 * - {@link composePlugin}: full `apply()` — route, reply engine and capture wiring.
 * - {@link composeCore}: store + service + `createHostCaptureSeams` + explicit
 *   `registerOpenItemsCapture`, so a test can await one `backfillNow()` pass
 *   deterministically instead of racing activation's background pass.
 *
 * @module tests/e2e/harness
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { CaptureEvent } from '../../src/host/capture-contract'
import { registerOpenItemsCapture, type OpenItemsCapture } from '../../src/host/capture'
import { createHostCaptureSeams, type HostCaptureSeams } from '../../src/host/capture-context'
import { Config, type Config as ConfigValues } from '../../src/host/config'
import { apply } from '../../src/host/index'
import { OpenItemsService } from '../../src/host/service'
import { OpenItemsStore } from '../../src/host/store'
import { OPEN_ITEMS_ROUTE_PATH, type RouteReply } from '../../src/shared/protocol'
import { createFakeDomain, type FakeDomain } from '../fake-domain'

/** Schemastery's call signature is over the validated type; the Loader feeds partials. */
const validateConfig = Config as unknown as (input: unknown) => ConfigValues

/** One fake live Agent: records the queue writes the reply engine makes. */
export interface FakeAgent {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: { readonly id: string; append(type: string, data: unknown): void }
  /** Parent Agent, for a subagent whose raise must roll up to the root (OI-02). */
  readonly parentAgent?: FakeAgent
  readonly steers: unknown[]
  readonly followups: unknown[]
  /** The bridge's steer/followup entry points (the agent loop receives the message). */
  steer(message: unknown): void
  followup(message: unknown): void
  /** Times the plugin tried to append to the Session log (must stay 0). */
  readonly appendCalls: () => number
}

/**
 * Build one fake live Agent.
 * @param sessionId - session identity.
 * @param status - agent status (only `running` steers; idle follow-ups need confirmation).
 * @param parentAgent - parent Agent for a subagent (set only where roll-up matters).
 * @returns the fake agent plus its append counter.
 */
export function fakeAgent(sessionId: string, status: 'idle' | 'running' = 'idle', parentAgent?: FakeAgent): FakeAgent {
  let appends = 0
  const steers: unknown[] = []
  const followups: unknown[] = []
  return {
    id: sessionId,
    status,
    ...(parentAgent === undefined ? {} : { parentAgent }),
    session: {
      id: sessionId,
      append() {
        appends += 1
        throw new Error('the plugin must never append to the Session log')
      },
    },
    steers,
    followups,
    steer(message: unknown): void {
      steers.push(message)
    },
    followup(message: unknown): void {
      followups.push(message)
    },
    appendCalls: () => appends,
  }
}

/** One roster row the fake `sessionController.list` returns. */
export interface FakeSessionRow {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly cwd?: string
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly title?: string
}

/** One workspace row the fake `workspaceRegistry.list` returns. */
export interface FakeWorkspaceRow {
  readonly workspaceId: string
  readonly title: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

/** Options shared by both compositions. */
export interface ComposeOptions {
  /** Live Agents by session id. */
  readonly agents?: ReadonlyMap<string, FakeAgent>
  /** Roster rows for `sessionController.list` (backfill catalog + liveness gate). */
  readonly sessions?: readonly FakeSessionRow[]
  /** Committed events per session for `sessionQuery.readSession` (backfill). */
  readonly sessionEvents?: ReadonlyMap<string, readonly CaptureEvent[]>
  /** Workspace registry rows. */
  readonly workspaces?: readonly FakeWorkspaceRow[]
  /** Archived session ids (the reply engine's archive guard reads this). */
  readonly archived?: readonly string[]
  /** Config overrides (defaults are the shipped limits). */
  readonly config?: Partial<ConfigValues>
  /** Injectable clock for the store/capture composition (defaults to `Date.now`). */
  readonly now?: () => number
  /**
   * Reuse an existing storage domain. A second composition over the same domain
   * simulates a process restart: the store rebuilds its index and the detection
   * cursors from the durable tables.
   */
  readonly domain?: FakeDomain
}

/** One parsed route response. */
export interface ParsedResponse {
  readonly status: number
  readonly contentType: string | null
  readonly body: RouteReply<unknown>
}

/** The full-plugin composition. */
export interface ComposedPlugin {
  readonly ctx: Context
  readonly domain: FakeDomain
  readonly service: OpenItemsService
  readonly routes: ConnectionFetchRoute[]
  readonly toolDefinitions: ToolDefinition[]
  readonly agents: ReadonlyMap<string, FakeAgent>
  /** Every fake Agent's append count (must stay 0). */
  appends(): number
  /** POST one envelope through the registered exact route. */
  post(envelope: unknown): Promise<ParsedResponse>
  /** POST one envelope and return its value (asserts `ok: true`). */
  ok<T>(endpoint: string, payload?: unknown): Promise<T>
  /** POST one envelope and return its error code (asserts `ok: false`). */
  failCode(endpoint: string, payload?: unknown): Promise<string>
  /** Execute the registered `open_items` tool. */
  runTool(args: Record<string, unknown>, sessionId?: string, callId?: string): Promise<unknown>
  /** Close the store/domain and remove the temp legacy directory. */
  close(): Promise<void>
}

/**
 * Compose the full plugin through `apply()` with fake external services.
 * @param options - fakes and config overrides.
 * @returns the mounted plugin and route helpers.
 */
export async function composePlugin(options: ComposeOptions = {}): Promise<ComposedPlugin> {
  const domain = options.domain ?? createFakeDomain()
  const ctx = new Context()
  const routes: ConnectionFetchRoute[] = []
  const toolDefinitions: ToolDefinition[] = []
  const agents = options.agents ?? new Map<string, FakeAgent>()
  const rows = options.sessions ?? []
  const events = options.sessionEvents ?? new Map<string, readonly CaptureEvent[]>()
  const workspaces = options.workspaces ?? []
  const archived = options.archived ?? []
  const legacyDirectory = await mkdtemp(join(tmpdir(), 'oi-e2e-'))

  ctx.provide('storageDomain', { open: async () => domain })
  ctx.provide('tools', {
    register(definition: ToolDefinition): () => void {
      toolDefinitions.push(definition)
      return () => undefined
    },
  })
  ctx.provide('connection', {
    fetch: {
      register(route: ConnectionFetchRoute): () => void {
        routes.push(route)
        return () => undefined
      },
    },
  })
  ctx.provide('agents', {
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    isOwnedBy: () => false,
    turnBoundaryOf: () => ({ openTurnStartSeq: null }),
  })
  ctx.provide('sessions', { flush: async () => undefined })
  ctx.provide('sessionController', {
    list: async () => ({ items: rows }),
    resolveAgent: async (sessionId: string) => {
      const agent = agents.get(sessionId)
      return agent === undefined ? { error: { code: 'session/not-found' } } : { agent }
    },
  })
  ctx.provide('sessionQuery', {
    // The persisted-log corpus, i.e. every stored session. This is the backfill
    // catalog; `sessionController.list` is only roster enrichment.
    listSessions: async () => rows.map(row => ({
      header: {
        id: row.sessionId,
        createdAt: row.updatedAt,
        ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
        ...(row.origin === undefined ? {} : { origin: row.origin }),
        ...(row.delegationDepth === undefined ? {} : { delegationDepth: row.delegationDepth }),
      },
      live: row.running,
      persisted: true,
    })),
    readSession: async (sessionId: string) => ({ events: events.get(sessionId) ?? [] }),
  })
  ctx.provide('workspaceRegistry', {
    list: () => workspaces,
    archivedSessionIds: archived,
  })

  const config = validateConfig({
    storePath: join(legacyDirectory, 'legacy.json'),
    ...options.config,
  })
  await apply(ctx, config)

  const mounted = routes[0]
  if (mounted === undefined) throw new Error('composePlugin: apply() registered no /api/open-items route')
  const route: ConnectionFetchRoute = mounted

  /**
   * POST one envelope through the registered route.
   * @param envelope - `{ endpoint, payload? }` or a raw string body.
   * @returns the parsed response.
   */
  async function post(envelope: unknown): Promise<ParsedResponse> {
    const body = typeof envelope === 'string' ? envelope : JSON.stringify(envelope)
    const response = await route.fetch(new Request(`http://localhost${OPEN_ITEMS_ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }))
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: await response.json() as RouteReply<unknown>,
    }
  }

  return {
    ctx,
    domain,
    service: ctx.openItems,
    routes,
    toolDefinitions,
    agents,
    appends: () => [...agents.values()].reduce((total, agent) => total + agent.appendCalls(), 0),
    post,
    async ok<T>(endpoint: string, payload?: unknown): Promise<T> {
      const parsed = await post({ endpoint, ...(payload === undefined ? {} : { payload }) })
      if (!parsed.body.ok) throw new Error(`${endpoint} failed: ${JSON.stringify(parsed.body)}`)
      return parsed.body.value as T
    },
    async failCode(endpoint: string, payload?: unknown): Promise<string> {
      const parsed = await post({ endpoint, ...(payload === undefined ? {} : { payload }) })
      if (parsed.body.ok) throw new Error(`${endpoint} unexpectedly succeeded`)
      return parsed.body.error.code
    },
    async runTool(args: Record<string, unknown>, sessionId = 'session-1', callId = 'call-e2e'): Promise<unknown> {
      const definition = toolDefinitions.find(entry => entry.name === 'open_items')
      if (definition === undefined) throw new Error('open_items tool was not registered')
      const agent = agents.get(sessionId)
      const exec = {
        callId,
        agent: agent ?? { id: sessionId, session: { id: sessionId } },
      } as unknown as ToolRunContext
      return await definition.execute(args, exec)
    },
    async close(): Promise<void> {
      await ctx.openItems.close()
      await rm(legacyDirectory, { recursive: true, force: true })
    },
  }
}

/** The store+service+capture composition used for deterministic backfill tests. */
export interface ComposedCore {
  readonly ctx: Context
  readonly domain: FakeDomain
  readonly store: OpenItemsStore
  readonly service: OpenItemsService
  readonly seams: HostCaptureSeams
  readonly capture: OpenItemsCapture
  close(): Promise<void>
}

/**
 * Compose store, service and the real capture engine over the real seams.
 * @param options - fakes and config overrides.
 * @returns the core composition; call `capture.backfillNow()` to drive a pass.
 */
export async function composeCore(options: ComposeOptions = {}): Promise<ComposedCore> {
  const domain = options.domain ?? createFakeDomain()
  const ctx = new Context()
  const agents = options.agents ?? new Map<string, FakeAgent>()
  const rows = options.sessions ?? []
  const events = options.sessionEvents ?? new Map<string, readonly CaptureEvent[]>()
  const workspaces = options.workspaces ?? []
  const archived = options.archived ?? []

  ctx.provide('storageDomain', { open: async () => domain })
  ctx.provide('agents', {
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    isOwnedBy: () => false,
  })
  ctx.provide('sessionController', {
    list: async () => ({ items: rows }),
    resolveAgent: async (sessionId: string) => {
      const agent = agents.get(sessionId)
      return agent === undefined ? { error: { code: 'session/not-found' } } : { agent }
    },
  })
  ctx.provide('sessionQuery', {
    // The persisted-log corpus, i.e. every stored session. This is the backfill
    // catalog; `sessionController.list` is only roster enrichment.
    listSessions: async () => rows.map(row => ({
      header: {
        id: row.sessionId,
        createdAt: row.updatedAt,
        ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
        ...(row.origin === undefined ? {} : { origin: row.origin }),
        ...(row.delegationDepth === undefined ? {} : { delegationDepth: row.delegationDepth }),
      },
      live: row.running,
      persisted: true,
    })),
    readSession: async (sessionId: string) => ({ events: events.get(sessionId) ?? [] }),
  })
  ctx.provide('workspaceRegistry', {
    list: () => workspaces,
    archivedSessionIds: archived,
  })

  const now = options.now ?? (() => Date.now())
  const store = await OpenItemsStore.open(ctx, { now })
  const service = new OpenItemsService(ctx, store)
  const seams = createHostCaptureSeams(ctx, store)
  if (seams === undefined) throw new Error('composeCore: capture seams unavailable')
  const capture = registerOpenItemsCapture(ctx, {
    sink: service,
    context: seams.context,
    cursors: seams.cursors,
    ...seams.isSessionRunning === undefined ? {} : { isSessionRunning: seams.isSessionRunning },
    ...options.now === undefined ? {} : { now: options.now },
    autoBackfill: false,
  })
  return {
    ctx,
    domain,
    store,
    service,
    seams,
    capture,
    async close(): Promise<void> {
      await capture.dispose()
      await service.close()
    },
  }
}
