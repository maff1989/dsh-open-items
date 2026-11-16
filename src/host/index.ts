/**
 * Host half of the open-items plugin (PLAN M1 host core).
 *
 * Owns the durable `open_items` storage domain, publishes the `openItems`
 * Cordis service, registers the model-facing `open_items` tool and mounts the
 * browser half's exact Fetch route. The browser half itself is discovered from
 * `dsh.client`; this module never touches a Session log (see
 * `docs/session-log-policy.md`).
 *
 * Optional services are read defensively so the same bundle activates in a
 * deployment that has no web carrier (`connection`), no Agent registry
 * (`agents`, which only enables subagent roll-up) and no delivery layer
 * (`openItemsReply`, which only enables the `reply` endpoint).
 * @module dsh-open-items
 */
import type { Context } from '@deepseek-ai/cordis'

import { Config as ConfigShape, resolveStorePath, type Config as ConfigValues } from './config'
import type { ReplyEngine } from './delivery-contract'
import { createHostCaptureSeams, createHostWorkspaceResolver, type HostCaptureSeams } from './capture-context'
import { registerOpenItemsCapture } from './capture'
import { createReplyEngine } from './delivery'
import { createProseExtractor } from './extraction'
import { createSessionBridge } from './delivery-bridge'
import { createOpenItemsRoute, type ConnectionFetchHost } from './route'
import { OpenItemsService } from './service'
import { OpenItemsStore } from './store'
import { registerOpenItemsTools, type AgentRegistryLike } from './tools'
import { OPEN_ITEMS_ROUTE_PATH, type BackfillReportRecord, type CaptureStatus } from '../shared/protocol'
import type { BackfillReport } from './backfill'
import type { ProseExtractionInput, ProseExtractionVerdict } from './capture-contract'

export { OpenItemsService } from './service'
export { OpenItemsStore } from './store'
export { OPEN_ITEMS_TOOL, MAX_ROLLUP_DEPTH, resolveOwnership } from './tools'
export type { AgentLike, AgentRegistryLike, OpenItemsToolDeps, ResolvedOwnership } from './tools'
export { OPEN_ITEMS_ENDPOINTS, createOpenItemsRoute } from './route'
export type { ConnectionFetchHost, OpenItemsRouteDeps } from './route'
export type { ReplyEngine, ReplyEngineDeps, ReplyStorePort, SessionBridge } from './delivery-contract'
export { openItemsDomain, OPEN_ITEMS_DOMAIN_NAME, OPEN_ITEMS_DOMAIN_VERSION } from './domain'
export { buildRegister, buildSnapshot } from './view'
export { planRetention } from './retention'
export type { Config as OpenItemsConfig } from './config'
export type { AuthoredItemInput, CreateRecordResult, ResolvedStoreLimits, SweepReport } from './store'
export type { RegisterProjection } from './view'
export type * from '../shared/schema'

/** Cordis plugin name (also the Loader row id named by cordis.patch.yml). */
export const name = 'dsh-open-items'

/**
 * Host services this plugin cannot run without: the domain data form and the
 * tool registry. Optional services are read with `ctx.get(...)` elsewhere so a
 * profile without them still activates.
 */
export const inject = ['storageDomain', 'tools']

/** Host plugin configuration schema. */
export const Config = ConfigShape

/** How often the plugin runs the retention/acknowledgement sweep. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000

/**
 * Cordis service name the delivery layer publishes its {@link ReplyEngine}
 * under. Read lazily per request so plugin load order never decides whether
 * `reply` works.
 */
export const REPLY_ENGINE_SERVICE = 'openItemsReply'

/** Mutable capture status the Host exposes through `hello.capture`. */
interface MutableCaptureStatus {
  mounted: boolean
  projection: boolean
  live: boolean
  backfill: boolean
  cursors: number
  catalogSessions?: number
  lastError?: string
  lastBackfill?: CaptureStatus['lastBackfill']
}

/** Alternate names accepted while the delivery layer's name settles. */
const REPLY_ENGINE_SERVICE_ALIASES: readonly string[] = [REPLY_ENGINE_SERVICE, 'openItemsReplyEngine']

/** Structural slice of `ctx.sessionProjections` used for the `raisedBy` label. */
interface ProjectionReaderHost {
  snapshot(session: unknown, keys?: readonly string[]): { readonly values: Readonly<Record<string, unknown>> }
}

/**
 * Read one optional Cordis service without declaring it in the Context type
 * table, so this bundle keeps working in profiles that mount only `tools` and
 * `storageDomain`.
 * @param ctx - plugin context.
 * @param names - candidate service names, in priority order.
 * @returns the first mounted service, or undefined.
 */
function optionalService<T>(ctx: Context, ...names: readonly string[]): T | undefined {
  const getter = ctx as unknown as { get(name: string): unknown }
  for (const name of names) {
    const value = getter.get(name)
    if (value !== undefined) return value as T
  }
  return undefined
}

/**
 * Structural slice of `ctx.systemPrompt` (`@deepseek-ai/dsh-system-prompt`).
 *
 * Declared structurally instead of imported so this bundle keeps activating in
 * profiles that do not mount the system-prompt service (contract §1). The real
 * service's `section()` returns the Cordis effect disposer that unregisters the
 * section.
 */
export interface SystemPromptSectionHost {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: string
  }): () => void
}

/** Name of the opt-in model-nudge section (one section per plugin). */
export const NUDGE_SECTION_NAME = 'open-items:nudge'
/** Placement order of the nudge section (contract §1). */
export const NUDGE_SECTION_ORDER = 60
/**
 * The opt-in instruction (contract §1: English, at most three sentences).
 *
 * It is deliberately short: every model turn pays this cost, so it says only
 * what the tool description cannot — the kind taxonomy in one place, the
 * *end-of-turn* moment to declare, and the resolve loop once the user has
 * answered. Still opt-in/default off (decision D4): better wording only.
 */
export const NUDGE_SECTION_TEXT =
  'The open_items tool declares what is waiting on the user: decision = a choice between named options (pass '
  + 'options), question = needs an answer, approval = permission for an action. When you end a turn with such an '
  + 'item — one item per real decision, at most 5 in a turn, never a summary of work already done — call '
  + 'open_items raise; after the user answers in conversation, call open_items resolve with the item id.'

/** Handle over the dynamically registered model-nudge section. */
export interface ModelNudge {
  /** Register the section while enabled, dispose it while disabled (idempotent). */
  apply(enabled: boolean): void
  /** Dispose the section, if registered. */
  dispose(): void
}

/**
 * Build the opt-in model-nudge controller.
 *
 * Registration is dynamic because the setting changes at runtime: the route
 * writes the record, the service notifies, and this controller registers or
 * disposes the section on the same turn (contract §1 "settings changes apply
 * immediately"). A profile without `systemPrompt` degrades silently.
 * @param ctx - plugin context (the section registers in its scope).
 * @param log - plugin logger (only unexpected failures are reported).
 * @returns the controller; the caller owns {@link ModelNudge.dispose}.
 */
export function createModelNudge(ctx: Context, log: ReturnType<Context['logger']>): ModelNudge {
  let disposeSection: (() => void) | undefined
  const disposeCurrent = (): void => {
    if (disposeSection === undefined) return
    const dispose = disposeSection
    disposeSection = undefined
    try {
      dispose()
    } catch {
      // The section was already torn down with the service: nothing to do.
    }
  }
  const apply = (enabled: boolean): void => {
    if (!enabled) {
      disposeCurrent()
      return
    }
    if (disposeSection !== undefined) return
    // Resolved per call: the Loader may mount `systemPrompt` after this row.
    const host = optionalService<SystemPromptSectionHost>(ctx, 'systemPrompt')
    if (host === undefined) return
    try {
      disposeSection = host.section({
        name: NUDGE_SECTION_NAME,
        order: NUDGE_SECTION_ORDER,
        text: NUDGE_SECTION_TEXT,
      })
    } catch (error) {
      disposeSection = undefined
      log.warn('open-items: model nudge unavailable: %s', error instanceof Error ? error.message : String(error))
    }
  }
  return { apply, dispose: disposeCurrent }
}

/**
 * Build the Session display-title reader: the title comes from the
 * session-title projection and labels both the root Session (`source.sessionTitle`)
 * and the asking subagent (`raisedBy.title`). Best-effort by design — the label
 * is cosmetic, so any absent key or projection failure yields undefined.
 * @param ctx - plugin context.
 * @returns a synchronous reader, or undefined when no projection registry mounts.
 */
function sessionTitleReader(ctx: Context): ((session: unknown) => string | undefined) | undefined {
  const projections = optionalService<ProjectionReaderHost>(ctx, 'sessionProjections')
  if (projections === undefined) return undefined
  return (session) => {
    try {
      const values = projections.snapshot(session, ['title']).values
      const title = values['title']
      return typeof title === 'string' && title.trim() !== '' ? title : undefined
    } catch {
      return undefined
    }
  }
}

/**
 * Open the storage domain, publish the service, register the tool, start the
 * retention sweep and mount the Fetch route when the profile has a web carrier.
 * Activation awaits the store, so a profile that lists this bundle either gets a
 * working inbox or fails loudly; optional services degrade, they do not fail.
 * @param ctx - Host plugin context.
 * @param config - validated plugin configuration.
 */
export async function apply(ctx: Context, config: ConfigValues): Promise<void> {
  const log = ctx.logger('open-items')
  const store = await OpenItemsStore.open(ctx, {
    legacyStorePath: resolveStorePath(config),
    maxLiveItems: config.maxLiveItems,
    maxResolvedRecords: config.maxResolvedRecords,
    activeResolveDays: config.activeResolveDays,
    acknowledgementWindowHours: config.acknowledgementWindowHours,
    log,
  })
  ctx.effect(() => () => {
    void store.close()
  }, 'open-items: store')

  const migration = store.migration
  if (migration?.quarantinedPath !== undefined) {
    log.warn('open-items: legacy store document was unreadable and quarantined at %s', migration.quarantinedPath)
  } else if (migration?.migratedPath !== undefined) {
    log.info('open-items: migrated %d legacy item(s) from %s', migration.imported, migration.migratedPath)
  }

  // Publishing the service is the Cordis Service contract: the instance
  // registers as `ctx.openItems` on this fiber and is removed with the plugin.
  const service = new OpenItemsService(ctx, store)

  // Decision D5: team-task alerts are disabled. Rows raised before the change
  // are still open in the inbox, so close them once (audit-visible detector
  // code) instead of leaving false "needs you" items forever.
  try {
    const retired = await service.retireTeamTaskItems()
    log.warn('open-items: retired %d open team-task item(s); team-task alerts are disabled (%s)',
      retired, 'team/task:alerts-disabled')
  } catch (error) {
    log.warn('open-items: team-task retirement failed: %s', error instanceof Error ? error.message : String(error))
  }

  // Prose candidates changed identity (one artifact per ask, per-item ids) and
  // `promote` can now correct a row in place (contract §2.2). Both fixups MUST
  // run before the capture mount: the fold+projection version bump replays every
  // session as a baseline, and the replay is what surfaces the new per-item rows
  // next to the retired legacy ones. Same precedent as the team-task retirement
  // above; failures are contained so a bad row can never fail activation.
  try {
    await service.retireLegacyProseCandidates()
    await service.migrateLegacyProseSuppressors()
  } catch (error) {
    log.warn('open-items: legacy prose migration failed: %s', error instanceof Error ? error.message : String(error))
  }

  // The opt-in model nudge (decision D4): registered while settings.modelNudge
  // is true, disposed the moment it goes false. The listener is what makes a
  // Settings toggle take effect immediately, without a restart.
  const nudge = createModelNudge(ctx, log)
  ctx.effect(() => () => nudge.dispose(), 'open-items: model nudge')
  ctx.effect(
    () => service.onSettingsChange(settings => nudge.apply(settings.modelNudge)),
    'open-items: settings changes',
  )
  nudge.apply(service.settings().modelNudge)

  // Opt-in model-assisted extraction (PLAN §12): built only when the deployment
  // configures a provider and model. The settings toggle and a late-mounted
  // `ctx.llm` are checked lazily inside the extractor, so toggling it needs no
  // rewiring; absence of either keeps every candidate gate-only.
  const extractor = createProseExtractor({
    ctx,
    service,
    config: {
      provider: config.extractionProvider.trim(),
      model: config.extractionModel.trim(),
      dailyBudget: config.extractionDailyBudget,
      timeoutMs: config.extractionTimeoutMs,
      maxInputBytes: config.extractionMaxInputBytes,
    },
    log,
  })
  ctx.effect(() => () => extractor?.dispose(), 'open-items: extraction')

  ctx.effect(() => {
    const timer = setInterval(() => {
      // The store's sweep wakes due snoozes as well as applying retention, so a
      // deferred item returns to the inbox even while no browser is open (the
      // read path wakes lazily too, for the case where somebody reads first).
      void service.sweep().catch((error: unknown) => {
        log.warn('open-items: retention sweep failed: %s', error instanceof Error ? error.message : String(error))
      })
    }, SWEEP_INTERVAL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'open-items: retention sweep')

  const agents = optionalService<AgentRegistryLike>(ctx, 'agents')
  const sessionTitleOf = sessionTitleReader(ctx)
  const workspaceOf = createHostWorkspaceResolver(ctx)
  ctx.effect(() => {
    const tool = registerOpenItemsTools(ctx, {
      service,
      listLimit: config.listLimit,
      ...(agents === undefined ? {} : { agents }),
      ...(sessionTitleOf === undefined ? {} : { sessionTitleOf }),
      ...(workspaceOf === undefined ? {} : { workspaceOf }),
    })
    return () => tool.dispose()
  }, 'open-items: open_items tool')

  // Capture status is the only way to explain an empty inbox: the backfill is
  // automatic and has no UI trigger. `hello` reports it, and every transition is
  // also logged at warn level because this app surfaces warnings, not info.
  // The last pass is seeded from the durable report so a restart does not claim
  // "nothing ran" (contract §12.5).
  const persistedBackfill = store.backfillReport()
  const captureStatus: MutableCaptureStatus = {
    mounted: false,
    projection: false,
    live: false,
    backfill: false,
    cursors: 0,
    ...(persistedBackfill === undefined ? {} : { lastBackfill: captureReportStatus(persistedBackfill) }),
  }
  mountRoute(ctx, service, log, () => {
    captureStatus.cursors = store.cursorCount()
    return captureStatus
  })
  mountReplyEngine(ctx, service, log)
  mountCaptureWhenReady(ctx, service, store, log, captureStatus, {
    rescanIntervalMs: config.rescanIntervalMinutes * 60_000,
    ...(extractor === undefined
      ? {}
      : { extraction: (input: ProseExtractionInput) => extractor.extract(input) }),
    reportBackfill: (report, trigger) => {
      const record: BackfillReportRecord = {
        schemaVersion: 1,
        at: Date.now(),
        trigger,
        eligible: report.sessionsEligible,
        folded: report.sessionsFolded,
        skipped: report.sessionsSkipped,
        failed: report.sessionsFailed,
        drafts: report.draftsEmitted,
        batches: report.batches,
        deferred: report.deferredByLimit,
        durationMs: report.durationMs,
      }
      // Status first (cheap, synchronous), then the durable write; a failed
      // persist must never break the pass or the status it just reported.
      captureStatus.lastBackfill = captureReportStatus(record)
      void service.putBackfillReport(record).catch((error: unknown) => {
        log.warn('open-items: backfill report persist failed: %s', error instanceof Error ? error.message : String(error))
      })
      // The pass has fully settled (cursors written, drafts accepted), so this
      // is the moment to close candidates that duplicate an already-promoted
      // item from the same session+turn (contract §2.2) — the post-bump replay
      // must not re-offer a decision the user confirmed. Contained: a failed
      // reconciliation never breaks the pass or its report.
      void service.reconcileProseCandidates().catch((error: unknown) => {
        log.warn('open-items: prose reconciliation failed: %s', error instanceof Error ? error.message : String(error))
      })
    },
  })

  const counts = service.counts()
  log.info('open items ready at %s (%d need you, %d awaiting)', store.domainName, counts.needsYou, counts.awaiting)
}

/* ------------------------------------------------------------------ *
 * Reply engine and capture mounting
 * ------------------------------------------------------------------ */

/**
 * Publish the reply engine under the name the route resolves per request.
 *
 * Publishing through reflection (rather than capturing the engine when the route
 * mounts) keeps the two halves independent of Loader row order: the route reads
 * `ctx.get('openItemsReply')` when a request arrives, and `hello` reports
 * `canDeliver` from the same probe.
 * @param ctx - plugin context.
 * @param service - the mounted inbox service (the engine's store port).
 * @param log - plugin logger.
 */
function mountReplyEngine(ctx: Context, service: OpenItemsService, log: ReturnType<Context['logger']>): void {
  try {
    const bridge = createSessionBridge(ctx as unknown as { get(name: string): unknown })
    const engine = createReplyEngine({ store: service, sessions: bridge, now: () => Date.now() })
    ctx.effect(() => {
      const dispose = ctx.reflect.provide(REPLY_ENGINE_SERVICE, engine)
      return () => {
        dispose()
      }
    }, 'open-items: reply engine')
    log.info('open-items: reply engine published as %s', REPLY_ENGINE_SERVICE)
  } catch (error) {
    log.warn('open-items: reply engine unavailable: %s', error instanceof Error ? error.message : String(error))
  }
}

/**
 * Optional capture wiring this Host supplies on top of the seams (contract §12).
 *
 * `extraction` is present only when the deployment configured a provider+model
 * (the extractor itself still checks the Settings toggle lazily); `reportBackfill`
 * persists every completed pass and mirrors it into `hello.capture.lastBackfill`.
 */
interface CaptureWiring {
  readonly rescanIntervalMs: number
  readonly extraction?: (input: ProseExtractionInput) => Promise<ProseExtractionVerdict | undefined>
  readonly reportBackfill: (report: BackfillReport, trigger: 'activation' | 'rescan') => void
}

/**
 * Map one durable backfill report onto the bounded status `hello` carries.
 * @param record - persisted (or just-completed) pass report.
 * @returns the status shape `hello.capture.lastBackfill` documents.
 */
function captureReportStatus(record: BackfillReportRecord): NonNullable<CaptureStatus['lastBackfill']> {
  return {
    eligible: record.eligible,
    folded: record.folded,
    skipped: record.skipped,
    failed: record.failed,
    drafts: record.drafts,
    durationMs: record.durationMs,
    at: record.at,
  }
}

/**
 * Mount the capture engine: the client-visible projection unit, the live session
 * drive and the bounded cold-session backfill.
 *
 * Every capability degrades on its own. Without a session roster/query pair there
 * is no backfill (the live projection still runs); without a projection registry
 * the live drive still folds; failures never take the plugin down.
 * @param ctx - plugin context.
 * @param service - the mounted inbox service (the capture sink).
 * @param store - the store, for durable detection cursors.
 * @param log - plugin logger.
 */
function mountCaptureWhenReady(
  ctx: Context,
  service: OpenItemsService,
  store: OpenItemsStore,
  log: ReturnType<Context['logger']>,
  status: MutableCaptureStatus,
  wiring: CaptureWiring,
): void {
  // The Loader mounts rows asynchronously, so `sessionQuery` can be registered
  // after this row's apply even though it is composed earlier. Wait for it the
  // same way the Fetch route waits for `connection`; otherwise the whole capture
  // engine is skipped on a cold boot (measured: the backfill then covers only
  // whatever the roster happened to have resident).
  const immediate = createHostCaptureSeams(ctx, store)
  if (immediate !== undefined) {
    mountCapture(ctx, service, store, immediate, log, status, wiring)
    return
  }
  log.warn('open-items: capture waiting for sessionQuery to mount')
  const binding = ctx.inject(['sessionQuery'], (scoped: Context) => {
    mountCapture(scoped ?? ctx, service, store, createHostCaptureSeams(scoped ?? ctx, store), log, status, wiring)
  })
  void Promise.resolve(binding).catch((error: unknown) => {
    log.warn('open-items: capture wait failed: %s', error instanceof Error ? error.message : String(error))
  })
}

/**
 * Mount the capture engine and report its first backfill pass at warn level.
 *
 * `warn` (not `info`) is deliberate: capture skipping itself silently was the
 * difference between "the inbox fills itself" and "the inbox looks empty with no
 * explanation", and this app surfaces warnings but not info.
 * @param ctx - plugin context.
 * @param service - the mounted inbox service (capture sink).
 * @param store - the store, for durable detection cursors.
 * @param seams - already-resolved cold-read/roster seams.
 * @param log - plugin logger.
 */
function mountCapture(
  ctx: Context,
  service: OpenItemsService,
  store: OpenItemsStore,
  seams: HostCaptureSeams | undefined,
  log: ReturnType<Context['logger']>,
  status: MutableCaptureStatus,
  wiring: CaptureWiring,
): void {
  try {
    if (seams === undefined) {
      log.warn('open-items: capture unavailable — sessionQuery is missing, so no log backfill runs')
      return
    }
    const capture = registerOpenItemsCapture(ctx, {
      sink: service,
      context: seams.context,
      cursors: seams.cursors,
      // Contract §8: the prose gate is user-controlled, and the backfill is
      // re-run periodically so a closure detected outside the live path lands.
      settings: () => ({ proseCandidates: service.settings().proseCandidates }),
      rescanIntervalMs: wiring.rescanIntervalMs,
      reportBackfill: wiring.reportBackfill,
      ...(wiring.extraction === undefined ? {} : { extraction: wiring.extraction }),
      ...(seams.isSessionRunning === undefined ? {} : { isSessionRunning: seams.isSessionRunning }),
      onError: (error: unknown) => {
        log.warn('open-items: capture error: %s', error instanceof Error ? error.message : String(error))
      },
    })
    ctx.effect(() => () => {
      void capture.dispose()
    }, 'open-items: capture')
    status.mounted = true
    status.projection = capture.projection
    status.live = capture.live
    status.backfill = capture.backfill
    // Probe the catalog once so `hello.capture.catalogSessions` can explain an
    // inbox that stays empty even though capture mounted. Failures are recorded
    // instead of silently shrinking the pass.
    void seams.context.listSessions().then((sessions) => {
      status.catalogSessions = sessions.length
      log.warn('open-items: backfill catalog = %d session(s)', sessions.length)
    }).catch((error: unknown) => {
      status.lastError = `catalog: ${error instanceof Error ? error.message : String(error)}`
      log.warn('open-items: backfill catalog read failed: %s', status.lastError)
    })
    log.warn(
      'open-items: capture mounted (projection=%s live=%s backfill=%s)',
      String(capture.projection),
      String(capture.live),
      String(capture.backfill),
    )
    void capture.backfillNow().then((report) => {
      // The status and the durable report are owned by `wiring.reportBackfill`
      // (the capture engine calls it for every pass); this log stays here.
      if (report === undefined) return
      log.warn(
        'open-items: backfill pass done — eligible=%d folded=%d skipped=%d failed=%d drafts=%d in %dms',
        report.sessionsEligible,
        report.sessionsFolded,
        report.sessionsSkipped,
        report.sessionsFailed,
        report.draftsEmitted,
        report.durationMs,
      )
    }).catch((error: unknown) => {
      status.lastError = `backfill: ${error instanceof Error ? error.message : String(error)}`
      log.warn('open-items: backfill failed: %s', status.lastError)
    })
  } catch (error) {
    log.warn('open-items: capture unavailable: %s', error instanceof Error ? error.message : String(error))
  }
}

/* ------------------------------------------------------------------ *
 * Exact Fetch route mounting
 * ------------------------------------------------------------------ */

/** Resolve the live reply engine, if the delivery layer has activated. */
function replyEngineOf(ctx: Context): ReplyEngine | undefined {
  return optionalService<ReplyEngine>(ctx, ...REPLY_ENGINE_SERVICE_ALIASES)
}

/**
 * Register the `/api/open-items` route on the Host Connection carrier.
 *
 * A profile without the web carrier must still activate: when `connection` is
 * absent at apply time the registration waits for it (`ctx.inject`) instead of
 * failing, and when it never arrives the inbox simply has no browser half. The
 * reply engine is resolved per request, so the delivery layer may activate in
 * any row order.
 * @param ctx - plugin context.
 * @param service - the mounted inbox service.
 * @param log - plugin logger.
 */
function mountRoute(
  ctx: Context,
  service: OpenItemsService,
  log: ReturnType<Context['logger']>,
  capture: () => CaptureStatus,
): void {
  const mount = (host: ConnectionFetchHost): void => {
    ctx.effect(
      () => {
        const dispose = host.fetch.register(createOpenItemsRoute({
          service,
          engine: () => replyEngineOf(ctx),
          capture,
          log,
        }))
        return () => {
          void dispose()
        }
      },
      `open-items: ${OPEN_ITEMS_ROUTE_PATH}`,
    )
    log.info('open-items: route ready at %s (reply %s)', OPEN_ITEMS_ROUTE_PATH,
      replyEngineOf(ctx) === undefined ? 'not wired yet' : 'wired')
  }

  const immediate = optionalService<ConnectionFetchHost>(ctx, 'connection')
  if (immediate !== undefined) {
    mount(immediate)
    return
  }
  // Late availability: the web carrier may activate after this row.
  const binding = ctx.inject(['connection'], (scoped: Context) => {
    const host = optionalService<ConnectionFetchHost>(scoped ?? ctx, 'connection')
    if (host !== undefined) mount(host)
  })
  void Promise.resolve(binding).catch((error: unknown) => {
    log.warn('open-items: connection wait failed: %s', error instanceof Error ? error.message : String(error))
  })
}
