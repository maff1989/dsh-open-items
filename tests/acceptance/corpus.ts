/**
 * Real-corpus acceptance plumbing (PLAN M1 acceptance gate).
 *
 * Reads the user's actual `$DSH_HOME/sessions/**\/*.jsonl.zstd` files
 * **read-only** (`zstdcat` via `child_process`), builds the `CaptureContext`
 * the capture engine expects, runs whatever capture folds are present in
 * `src/host/folds/**` or `src/host/projection.ts`, and computes the M1
 * invariants. Nothing here writes to `$DSH_HOME`; the only file written is
 * `tests/acceptance/last-run.json` in this worktree.
 *
 * The sandbox cannot mount a live profile, so this harness is the closest
 * objective measurement of the M1 gate available offline.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

import type {
  CaptureContext,
  CaptureEvent,
  CaptureSessionInfo,
  DerivedItemDraft,
  FoldState,
} from '../../src/host/capture-contract'
import type { OpenItemKind, WorkspaceRef } from '../../src/shared/schema'

const execFileAsync = promisify(execFile)

/** Read buffer for one decompressed session log (p90 logs are ~6 MB). */
const ZSTD_MAX_BUFFER = 256 * 1024 * 1024

/** Structural-item target from PLAN.md §3 (acceptance gate M1). */
export const M1_MAX_STRUCTURAL_ITEMS = 20

/** Paths the acceptance suite resolves from. */
export const ACCEPTANCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Where the last run is written (the wrapper reads it). */
export const LAST_RUN_PATH = join(ACCEPTANCE_ROOT, 'tests', 'acceptance', 'last-run.json')

/** One session header line of a format-v4 log. */
export interface SessionLogHeader {
  readonly type: 'session'
  readonly version: number
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly isSeeded: boolean
  readonly delegationDepth?: number
  readonly origin?: 'subagent'
  readonly agentPreset?: string
}

/** One parsed corpus session. */
export interface CorpusSession {
  readonly filePath: string
  readonly header: SessionLogHeader
  readonly events: readonly CaptureEvent[]
  /** Skip every event with seq < this (fork cut). 0 for unseeded logs. */
  readonly inheritedEventCount: number
  /** Latest known activity: max event time, else header creation time. */
  readonly updatedAt: number
  /** The contract's session metadata plus the fork cut (harness-only extension). */
  readonly info: CaptureSessionInfo & { readonly inheritedEventCount: number }
}

/** A corpus read problem that did not stop the run. */
export interface CorpusIssue {
  readonly filePath: string
  readonly message: string
}

/** The loaded corpus plus workspace membership. */
export interface LoadedCorpus {
  readonly dshHome: string
  readonly sessionsRoot: string
  readonly files: readonly string[]
  readonly sessions: readonly CorpusSession[]
  readonly issues: readonly CorpusIssue[]
  readonly membership: WorkspaceMembership
}

/** Session→workspace membership read from `$DSH_HOME/storages/workspace.json`. */
export interface WorkspaceMembership {
  readonly bySessionId: ReadonlyMap<string, WorkspaceRef>
  readonly archivedSessionIds: ReadonlySet<string>
  /** Workspace id → session count (report scope). */
  readonly workspaceCounts: ReadonlyMap<string, number>
}

/** A log line could not be parsed; the message names the exact line. */
export class CorpusParseError extends Error {
  constructor(
    readonly filePath: string,
    readonly line: number,
    problem: string,
  ) {
    super(`cannot parse ${filePath}:${line}: ${problem}`)
    this.name = 'CorpusParseError'
  }
}

/**
 * Resolve the DSH home the corpus is read from.
 * @param environment - environment mapping (`$DSH_HOME`).
 * @returns the absolute home.
 */
export function acceptanceDshHome(environment: Record<string, string | undefined> = process.env): string {
  return resolveDshHome(undefined, environment)
}

/**
 * Read every format-v4 `.jsonl.zstd` log under the sessions root.
 * @param dshHome - DSH home.
 * @returns absolute file paths, sorted for determinism.
 */
export async function discoverSessionFiles(dshHome: string): Promise<string[]> {
  const sessionsRoot = join(dshHome, 'sessions')
  let entries: string[]
  try {
    entries = await readdir(sessionsRoot, { recursive: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.endsWith('.jsonl.zstd'))
    .map(entry => join(sessionsRoot, entry))
    .sort()
}

/**
 * Decompress and parse one session log.
 * @param filePath - absolute `.jsonl.zstd` path.
 * @returns the parsed session with its fork cut and activity time.
 * @throws {CorpusParseError} when a line is not a valid event.
 */
export async function readSessionLog(filePath: string): Promise<CorpusSession> {
  const { stdout } = await execFileAsync('zstdcat', [filePath], { maxBuffer: ZSTD_MAX_BUFFER })
  const lines = stdout.split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) throw new CorpusParseError(filePath, 0, 'empty log')
  let header: SessionLogHeader
  try {
    header = JSON.parse(lines[0]!) as SessionLogHeader
  } catch (error) {
    throw new CorpusParseError(filePath, 1, describe(error))
  }
  if (header.type !== 'session' || typeof header.id !== 'string' || typeof header.version !== 'number') {
    throw new CorpusParseError(filePath, 1, 'first line is not a format-v4 session header')
  }

  const events: CaptureEvent[] = []
  let inheritedEventCount = 0
  let updatedAt = header.createdAt
  for (const [index, line] of lines.entries()) {
    if (index === 0) continue
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line) as Record<string, unknown>
    } catch (error) {
      throw new CorpusParseError(filePath, index + 1, describe(error))
    }
    const type = raw['type']
    const seq = raw['seq']
    if (typeof type !== 'string' || typeof seq !== 'number' || !Number.isSafeInteger(seq)) {
      throw new CorpusParseError(filePath, index + 1, 'event line has no string type / integer seq')
    }
    const time = typeof raw['time'] === 'number' ? raw['time'] : updatedAt
    updatedAt = Math.max(updatedAt, time)
    events.push({
      seq,
      type,
      time,
      data: raw['data'],
    })
    // Fork cut: the child-owned marker after the inherited prefix.
    if (type === 'session/end-seed' && isRecord(raw['data']) && raw['data']['inherited'] === true) {
      inheritedEventCount = seq + 1
    }
  }

  return {
    filePath,
    header,
    events,
    inheritedEventCount,
    updatedAt,
    info: {
      sessionId: header.id,
      ...(latestTitle(events) === undefined ? {} : { title: latestTitle(events)! }),
      updatedAt,
      archived: false,
      ...(header.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
      ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      inheritedEventCount,
    },
  }
}

/**
 * Read workspace membership from the durable workspace storage.
 * @param dshHome - DSH home.
 * @returns session→workspace membership plus the archived set.
 */
export async function loadWorkspaceMembership(dshHome: string): Promise<WorkspaceMembership> {
  const empty: WorkspaceMembership = {
    bySessionId: new Map(),
    archivedSessionIds: new Set(),
    workspaceCounts: new Map(),
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8')) as unknown
  } catch {
    return empty
  }
  if (!isRecord(parsed)) return empty
  const global = isRecord(parsed['global']) ? parsed['global'] : {}
  const archived = Array.isArray(global['archivedSessionIds'])
    ? global['archivedSessionIds'].filter((value): value is string => typeof value === 'string')
    : []
  const tables = isRecord(parsed['tables']) ? parsed['tables'] : {}
  const workspaces = isRecord(tables['workspaces']) ? tables['workspaces'] : {}
  const bySessionId = new Map<string, WorkspaceRef>()
  const workspaceCounts = new Map<string, number>()
  for (const [workspaceId, value] of Object.entries(workspaces)) {
    if (!isRecord(value)) continue
    const title = typeof value['title'] === 'string' ? value['title'] : undefined
    const path = typeof value['path'] === 'string' ? value['path'] : undefined
    const sessionIds = Array.isArray(value['sessionIds'])
      ? value['sessionIds'].filter((id): id is string => typeof id === 'string')
      : []
    workspaceCounts.set(workspaceId, sessionIds.length)
    for (const sessionId of sessionIds) {
      bySessionId.set(sessionId, {
        workspaceId,
        ...(title === undefined ? {} : { title }),
        ...(path === undefined ? {} : { path }),
      })
    }
  }
  return { bySessionId, archivedSessionIds: new Set(archived), workspaceCounts }
}

/** Options for {@link loadCorpus}. */
export interface LoadCorpusOptions {
  /** DSH home; defaults to `$DSH_HOME`/`~/.dsh`. */
  readonly dshHome?: string
  /** Cap the number of sessions read (newest first); default: all. */
  readonly maxSessions?: number
}

/**
 * Load the whole corpus: discover, read, attach membership.
 * Unreadable logs become `issues` instead of failing the run.
 * @param options - home and optional cap.
 * @returns the loaded corpus.
 */
export async function loadCorpus(options: LoadCorpusOptions = {}): Promise<LoadedCorpus> {
  const dshHome = options.dshHome ?? acceptanceDshHome()
  const sessionsRoot = join(dshHome, 'sessions')
  const allFiles = await discoverSessionFiles(dshHome)
  const files = options.maxSessions === undefined ? allFiles : allFiles.slice(0, options.maxSessions)
  const membership = await loadWorkspaceMembership(dshHome)
  const sessions: CorpusSession[] = []
  const issues: CorpusIssue[] = []
  for (const filePath of files) {
    try {
      const session = await readSessionLog(filePath)
      sessions.push({
        ...session,
        info: { ...session.info, archived: membership.archivedSessionIds.has(session.header.id) },
      })
    } catch (error) {
      issues.push({ filePath, message: describe(error) })
    }
  }
  return { dshHome, sessionsRoot, files: allFiles, sessions, issues, membership }
}

/**
 * Build the capture engine's context over a loaded corpus.
 * @param corpus - loaded corpus.
 * @returns the `CaptureContext` the folds expect.
 */
export function buildCaptureContext(corpus: LoadedCorpus): CaptureContext & { readonly sessions: readonly CorpusSession[] } {
  const byId = new Map(corpus.sessions.map(session => [session.header.id, session]))
  return {
    sessions: corpus.sessions,
    async listSessions(): Promise<readonly CaptureSessionInfo[]> {
      return corpus.sessions.map(session => session.info)
    },
    async readSession(sessionId: string): Promise<readonly CaptureEvent[]> {
      return byId.get(sessionId)?.events ?? []
    },
    async workspaceOf(sessionId: string): Promise<WorkspaceRef | undefined> {
      return corpus.membership.bySessionId.get(sessionId)
    },
  }
}

/* ------------------------------------------------------------------ *
 * Capture-module probing (dynamic; capture branch may not be merged yet)
 * ------------------------------------------------------------------ */

/** Collects drafts produced by whatever adapter was found. */
export interface DraftCollectorSink {
  readonly installId: string
  upsertDerived(drafts: readonly DerivedItemDraft[]): Promise<number>
}

/** A discovered capture module adapter. */
export interface CaptureAdapter {
  readonly name: string
  /** Fold one session and return its drafts. */
  foldSession(session: CorpusSession): Promise<readonly DerivedItemDraft[]>
}

/** Result of probing for capture modules. */
export interface CaptureAdapterProbe {
  readonly adapter?: CaptureAdapter
  /** Human-readable notes about which candidate interfaces were tried. */
  readonly notes: readonly string[]
  /** Why no adapter could be built. */
  readonly reason?: string
}

/** Fold definition shape (structural restatement of the contract). */
interface FoldLike {
  readonly foldVersion?: number
  fold(state: FoldState, event: CaptureEvent, session: CaptureSessionInfo): { readonly state: FoldState; readonly result: { readonly drafts: readonly DerivedItemDraft[] } } | Promise<{ readonly state: FoldState; readonly result: { readonly drafts: readonly DerivedItemDraft[] } }>
  readonly initial?: unknown
  readonly init?: unknown
}

/** Dynamic module namespace, loose by design (probed, not statically imported). */
type LooseModule = Record<string, unknown>

/**
 * Import one candidate module, if it exists.
 * @param filePath - absolute path to the candidate.
 * @returns the module namespace, or undefined.
 */
async function tryImport(filePath: string): Promise<LooseModule | undefined> {
  try {
    await stat(filePath)
  } catch {
    return undefined
  }
  try {
    return await import(pathToFileURL(filePath).href) as LooseModule
  } catch {
    return undefined
  }
}

/**
 * Discover a usable capture adapter in the package.
 *
 * Tried, in order:
 * 1. `src/host/folds/index.ts` with `createOpenItemsFold()` (+ optional
 *    `initialFoldState`/`initialState`, or a definition carrying `initial`/`init`)
 * 2. `src/host/folds/index.ts` with a bare `foldOpenItemsEvent(state, event, session)`
 * 3. `src/host/projection.ts` with a projection factory/class exposing
 *    `driveSession(session, events)`/`drive(...)`
 * 4. an explicit `createAcceptanceCaptureAdapter()` export in either module
 * @param packageRoot - package root (defaults to this worktree's root).
 * @returns the adapter or a reason with the probes tried.
 */
export async function loadCaptureAdapter(packageRoot: string = ACCEPTANCE_ROOT): Promise<CaptureAdapterProbe> {
  const notes: string[] = []
  const candidates = [
    join(packageRoot, 'src', 'host', 'folds', 'index.ts'),
    join(packageRoot, 'src', 'host', 'projection.ts'),
  ]
  const modules: { path: string; module: LooseModule }[] = []
  for (const candidate of candidates) {
    const module = await tryImport(candidate)
    if (module === undefined) {
      notes.push(`absent: ${candidate.slice(packageRoot.length + 1)}`)
      continue
    }
    modules.push({ path: candidate, module })
    notes.push(`present: ${candidate.slice(packageRoot.length + 1)}`)
  }

  for (const { path, module } of modules) {
    const explicit = module['createAcceptanceCaptureAdapter']
    if (typeof explicit === 'function') {
      const adapter = explicit() as CaptureAdapter
      if (adapter !== undefined && typeof adapter.foldSession === 'function') {
        notes.push(`adapter: ${path.slice(packageRoot.length + 1)} export createAcceptanceCaptureAdapter`)
        return { adapter, notes }
      }
    }
  }

  for (const { path, module } of modules) {
    const factory = module['createOpenItemsFold'] ?? module['openItemsFold'] ?? module['createFold']
    if (typeof factory === 'function') {
      const definition = await (factory as (source?: unknown, options?: unknown) => unknown)(undefined, { historical: true }) as FoldLike
      if (definition !== undefined && typeof definition.fold === 'function') {
        const initCandidates = [
          module['initialFoldState'],
          module['createInitialFoldState'],
          module['initialState'],
          definition.initial,
          definition.init,
        ]
        notes.push(`adapter: ${path.slice(packageRoot.length + 1)} createOpenItemsFold() fold definition`)
        return {
          adapter: {
            name: `${path.slice(packageRoot.length + 1)}#createOpenItemsFold`,
            foldSession: session => foldWithDefinition(definition, initCandidates, session),
          },
          notes,
        }
      }
    }
    const directFold = module['foldOpenItemsEvent'] ?? module['foldOpenItems']
    if (typeof directFold === 'function') {
      notes.push(`adapter: ${path.slice(packageRoot.length + 1)} foldOpenItemsEvent(state, event, session)`)
      return {
        adapter: {
          name: `${path.slice(packageRoot.length + 1)}#foldOpenItemsEvent`,
          foldSession: session => foldWithFunction(directFold as FoldFunction, module, session),
        },
        notes,
      }
    }
  }

  for (const { path, module } of modules) {
    const projectionFactory = module['createOpenItemsProjection']
      ?? module['createProjection']
      ?? module['createProjectionDriver']
      ?? module['OpenItemsProjection']
    if (projectionFactory !== undefined) {
      const adapter = await buildProjectionAdapter(path, module, projectionFactory, notes)
      if (adapter !== undefined) {
        notes.push(`adapter: ${path.slice(packageRoot.length + 1)} projection driver`)
        return { adapter, notes }
      }
    }
  }

  return {
    notes,
    reason: `no supported capture interface found; tried ${notes.join('; ')}. `
      + 'Expected src/host/folds/index.ts exporting createOpenItemsFold()/initialFoldState() or '
      + 'src/host/projection.ts exporting a projection driver with driveSession().',
  }
}

/** Per-event fold function shape for the simple candidate. */
type FoldFunction = (state: FoldState, event: CaptureEvent, session: CaptureSessionInfo) => FoldState | { readonly state: FoldState; readonly result?: { readonly drafts?: readonly DerivedItemDraft[] } }

/**
 * Drive one aggregate fold definition across a session's events.
 * @param definition - fold definition.
 * @param initCandidates - candidate initial-state factories/values.
 * @param session - session to fold.
 * @returns the drafts emitted past the fork cut.
 */
async function foldWithDefinition(
  definition: FoldLike,
  initCandidates: readonly unknown[],
  session: CorpusSession,
): Promise<readonly DerivedItemDraft[]> {
  let state = await initialFoldState(initCandidates, session)
  const drafts: DerivedItemDraft[] = []
  for (const event of foldableEvents(session)) {
    const outcome = await definition.fold(state, event, session.info)
    state = outcome.state
    drafts.push(...(outcome.result.drafts ?? []))
  }
  return drafts
}

/**
 * Drive one bare per-event fold function (definition-less interface).
 * @param fold - fold function.
 * @param module - module that may export `initialFoldState`.
 * @param session - session to fold.
 * @returns the drafts emitted past the fork cut.
 */
async function foldWithFunction(
  fold: FoldFunction,
  module: LooseModule,
  session: CorpusSession,
): Promise<readonly DerivedItemDraft[]> {
  let state = await initialFoldState(
    [module['initialFoldState'], module['createInitialFoldState'], module['initialState']],
    session,
  )
  const drafts: DerivedItemDraft[] = []
  for (const event of foldableEvents(session)) {
    const outcome = await fold(state, event, session.info)
    if (isRecord(outcome) && 'state' in outcome) {
      state = (outcome as { state: FoldState }).state
      drafts.push(...((outcome as { result?: { drafts?: readonly DerivedItemDraft[] } }).result?.drafts ?? []))
    } else {
      state = outcome as FoldState
    }
  }
  return drafts
}

/**
 * Build an adapter around a projection-driver factory/class.
 * @param path - module path (for the name).
 * @param module - module namespace.
 * @param factory - factory or class.
 * @param notes - probe notes (mutated).
 * @returns the adapter, or undefined when the driver shape is unusable.
 */
async function buildProjectionAdapter(
  path: string,
  module: LooseModule,
  factory: unknown,
  notes: string[],
): Promise<CaptureAdapter | undefined> {
  const sink: DraftCollectorSink & { readonly collected: DerivedItemDraft[] } = {
    installId: 'acceptance',
    collected: [],
    async upsertDerived(drafts: readonly DerivedItemDraft[]): Promise<number> {
      sink.collected.push(...drafts)
      return drafts.length
    },
  }
  let driver: Record<string, unknown>
  try {
    if (typeof factory === 'function') {
      const produced = await (factory as (options: unknown) => unknown)({
        sink,
        now: () => Date.now(),
        isSessionRunning: () => false,
      })
      if (produced !== undefined && isRecord(produced)) driver = produced as Record<string, unknown>
      else if (produced !== undefined && typeof produced === 'object') driver = produced as Record<string, unknown>
      else driver = {}
    } else {
      notes.push(`unusable projection factory in ${path}`)
      return undefined
    }
  } catch (error) {
    notes.push(`projection factory threw in ${path}: ${describe(error)}`)
    return undefined
  }
  const drive = driver['driveSession'] ?? driver['drive'] ?? driver['foldSession'] ?? driver['ingest']
  if (typeof drive !== 'function') {
    notes.push(`projection driver in ${path} exposes no driveSession/drive/foldSession`)
    return undefined
  }
  void module
  return {
    name: `${path}#projectionDriver`,
    async foldSession(session: CorpusSession): Promise<readonly DerivedItemDraft[]> {
      sink.collected.length = 0
      try {
        await (drive as (session: unknown, events: readonly CaptureEvent[]) => Promise<unknown>)
          .call(driver, session.info, session.events)
      } catch {
        await (drive as (events: readonly CaptureEvent[], session: unknown) => Promise<unknown>)
          .call(driver, session.events, session.info)
      }
      return [...sink.collected]
    },
  }
}

/**
 * Resolve an initial fold state from probed candidates.
 * @param candidates - factories/values found on the module/definition.
 * @param session - session being folded.
 * @returns the initial state.
 */
async function initialFoldState(candidates: readonly unknown[], session: CorpusSession): Promise<FoldState> {
  for (const candidate of candidates) {
    if (typeof candidate === 'function') {
      const produced = await (candidate as (inherited: number) => FoldState)(session.inheritedEventCount)
      if (isRecord(produced)) return produced
    } else if (isRecord(candidate)) {
      return candidate
    }
  }
  return { inheritedEventCount: session.inheritedEventCount }
}

/**
 * The events a fold may see: the fork cut is applied here so every adapter
 * shares it.
 * @param session - corpus session.
 * @returns events with seq >= inheritedEventCount.
 */
function foldableEvents(session: CorpusSession): readonly CaptureEvent[] {
  return session.events.filter(event => event.seq >= session.inheritedEventCount)
}

/* ------------------------------------------------------------------ *
 * Artifact-family closure capabilities
 * ------------------------------------------------------------------ */

/**
 * The artifact families the capture pipeline can raise — or deliberately
 * cannot. This is the WP-D "per-family closure map": every family the fold can
 * produce must declare how its artifacts leave the open set, so the acceptance
 * invariant is a *capability* (an explicit declaration) instead of a regex over
 * detector-code strings.
 *
 * The interrupted-turn family (`interrupted:<callId>`) is listed as
 * `interrupted`; no `interview` detector exists in this package.
 */
export type ArtifactFamily =
  | 'question'
  | 'plan-review'
  | 'interrupted'
  | 'approval-pending'
  | 'approval-blocked'
  | 'goal'
  | 'job'
  | 'team-task-disabled'
  | 'prose'
  | 'todo'

/**
 * How artifacts of one family leave the open set.
 *
 * - `detector` — a later committed event always closes it.
 * - `conditional` — a later event closes it only if the agent retries/resumes;
 *   otherwise it is a real decision the user must resolve or dismiss.
 * - `user-only` — no log event closes it; only the user can.
 * - `disabled` — the family emits nothing by decision (D5 team tasks).
 */
export type FamilyClosurePolicy = 'detector' | 'conditional' | 'user-only' | 'disabled'

/** One declared family capability, and the evidence code(s) that close it. */
export interface FamilyClosureDeclaration {
  /** Policy determining whether the family has an unconditional log closer. */
  readonly policy: FamilyClosurePolicy
  /** Detector codes that close the family (empty when none can). */
  readonly closers: readonly string[]
  /** Why this is the truth — printed with the report so the map is self-explaining. */
  readonly note: string
}

/**
 * The declared closing-detector capability of every artifact family.
 *
 * `approval-blocked` is `conditional` on purpose: a granted retry closes it, but
 * a blocked approval that is never retried has no later log evidence and is the
 * user's to resolve or dismiss. That is why it is the one family that can leave
 * a standing "no unconditional detector closer" row (the rc.1 release record
 * mislabeled that row as a plan-review detection gap; it is the blocked
 * approval).
 */
export const FAMILY_CLOSURES: Readonly<Record<ArtifactFamily, FamilyClosureDeclaration>> = {
  question: {
    policy: 'detector',
    closers: ['tool/result'],
    note: 'the ask result (answer, timeout payload or repair result) closes it',
  },
  'plan-review': {
    policy: 'detector',
    closers: ['tool/result'],
    note: 'the plan-mode result closes it',
  },
  interrupted: {
    policy: 'detector',
    closers: ['tool/call:retried', 'turn/start:superseded'],
    note: 'a retried call or a later turn closes it',
  },
  'approval-pending': {
    policy: 'detector',
    closers: ['approval/decided'],
    note: 'the decision closes the live-only pending row',
  },
  'approval-blocked': {
    policy: 'conditional',
    closers: ['approval/decided:allowed-once'],
    note: 'a granted retry closes it; otherwise the user resolves or dismisses the blocked action',
  },
  goal: {
    policy: 'detector',
    closers: ['goal/change'],
    note: 'a later goal phase change closes it',
  },
  job: {
    policy: 'detector',
    closers: ['job/settled'],
    note: 'the job settlement closes it',
  },
  'team-task-disabled': {
    policy: 'disabled',
    closers: [],
    note: 'dispatch removed by D5 until the liveness gate is redesigned; the fold emits no item',
  },
  prose: {
    policy: 'detector',
    closers: ['user/message:superseded', 'prose-gate:superseded-by-cap'],
    note: 'a later user message closes every per-item candidate of the turn; the batch-aware per-session open bound (8) closes other turns\' oldest rows. (The one-time store-side migration/reconciliation closures, `prose-gate:superseded-by-scope-change` and `prose-gate:duplicate-of-promoted`, are not fold drafts and are covered by the store migration tests.)',
  },
  todo: {
    policy: 'detector',
    closers: ['todo/write:completed'],
    note: 'a later fully-completed plan closes the aggregate',
  },
}

/** Every declared family, in the report's stable order. */
export const ARTIFACT_FAMILIES: readonly ArtifactFamily[] = Object.keys(FAMILY_CLOSURES) as ArtifactFamily[]

/**
 * Classify one draft into its artifact family.
 *
 * Artifact id is the primary key (it is the fold state's identity); detector
 * codes are the fallback so an id-convention change cannot silently bypass the
 * declared map. Returns `undefined` when a new family was added without
 * declaring its closure capability — the report surfaces that as a violation.
 * @param draft - an open draft or a closure draft.
 * @returns the artifact family, or undefined when the map has no declaration.
 */
export function familyOfDraft(draft: DerivedItemDraft): ArtifactFamily | undefined {
  const artifactId = draft.artifactId
  const code = draft.detectorCode
  if (artifactId.startsWith('question:')) {
    return draft.kind === 'plan-review' ? 'plan-review' : 'question'
  }
  if (artifactId.startsWith('interrupted:')) return 'interrupted'
  if (artifactId.startsWith('approval:')) {
    return code.startsWith('approval/decided') ? 'approval-blocked' : 'approval-pending'
  }
  if (artifactId.startsWith('goal:')) return 'goal'
  if (artifactId.startsWith('job:')) return 'job'
  if (artifactId.startsWith('task:')) return 'team-task-disabled'
  if (artifactId.startsWith('prose:')) return 'prose'
  if (artifactId === 'todo-open' || artifactId.startsWith('todo:')) return 'todo'
  // Fallback by detector code for a changed artifact-id convention.
  if (code.startsWith('prose-gate:')) return 'prose'
  if (code.startsWith('todo/write')) return 'todo'
  if (code.startsWith('team/task:')) return 'team-task-disabled'
  if (code.startsWith('job/')) return 'job'
  if (code.startsWith('goal/')) return 'goal'
  if (code.startsWith('approval/decided')) return 'approval-blocked'
  if (code.startsWith('approval/')) return 'approval-pending'
  if (code.startsWith('tool/result:') || code.startsWith('tool/call:')) {
    return draft.kind === 'plan-review' ? 'plan-review' : 'question'
  }
  return undefined
}

/**
 * Classify a closure whose open draft was never raised in this fold.
 *
 * The only drafts a historical fold suppresses are live-only pending approvals,
 * so an unmatched `approval:` closure is a pending ask's decision — classifying
 * it by the closure code alone would misattribute it to `approval-blocked`.
 * @param draft - the closure draft.
 * @returns the family the closed artifact belonged to, when inferable.
 */
function familyOfClosureWithoutOpen(draft: DerivedItemDraft): ArtifactFamily | undefined {
  return draft.artifactId.startsWith('approval:') ? 'approval-pending' : familyOfDraft(draft)
}

/* ------------------------------------------------------------------ *
 * Invariants and reporting
 * ------------------------------------------------------------------ */

/** One draft with the session it came from. */
export interface DraftOrigin {
  readonly sessionId: string
  readonly draft: DerivedItemDraft
}

/** One family's declared capability plus the numbers this fold observed. */
export interface FamilyClosureReport extends FamilyClosureDeclaration {
  readonly family: ArtifactFamily
  /** Artifacts of this family raised at any point in the folded logs. */
  readonly raised: number
  /** Raised artifacts still open at log end (no later closure observed). */
  readonly open: number
  /** Closure drafts attributed to the family. */
  readonly closures: number
  /**
   * Of {@link closures}, the ones whose open draft was never raised in this
   * fold — a historical read suppresses live-only pending asks by design, but
   * their decisions still appear as closures.
   */
  readonly closuresWithoutRaise: number
}

/** An artifact the accounting keeps open at log end, with its family. */
export interface OpenArtifactRecord {
  readonly sessionId: string
  readonly artifact: DerivedItemDraft
  readonly family: ArtifactFamily | undefined
}

/** The numbers the M1 gate is judged on. */
export interface AcceptanceReport {
  readonly generatedAt: string
  readonly corpus: {
    readonly dshHome: string
    readonly sessionsRoot: string
    readonly filesFound: number
    readonly sessionsRead: number
    readonly nonRootExcluded: number
    readonly seededSessions: number
    readonly archivedSessions: number
    readonly eventsTotal: number
    readonly inheritedEventsCut: number
    readonly todoWriteEvents: number
    readonly oldestActivity: number | null
    readonly newestActivity: number | null
    readonly workspaceCount: number
    readonly issues: readonly CorpusIssue[]
  }
  readonly capture: {
    readonly available: boolean
    readonly adapter?: string
    readonly reason?: string
    readonly probes: readonly string[]
    readonly foldedSessions: number
    readonly foldErrors: readonly { readonly sessionId: string; readonly message: string }[]
  }
  readonly counts: {
    /** Open items by kind — still open at log end, closures already subtracted. */
    readonly perKind: Readonly<Record<string, number>>
    /** Structural items still open at log end (the M1 target's numerator). */
    readonly structural: number
    /** Candidate items still open at log end. */
    readonly candidate: number
    /** Unique artifacts still open at log end. */
    readonly uniqueArtifacts: number
    /** Unique artifacts raised at any point (open + later closed). */
    readonly raisedArtifacts: number
    /** Raised artifacts that have a later closure. */
    readonly closedArtifacts: number
    /** Closure drafts emitted (one can close an artifact that was never raised here). */
    readonly closures: number
    /** Closure drafts whose target artifact was never raised in this fold (live-only history). */
    readonly unmatchedClosures: number
    readonly totalDrafts: number
  }
  readonly invariants: {
    readonly rootOnlyViolations: readonly { readonly sessionId: string; readonly artifactId: string; readonly kind: OpenItemKind }[]
    /** Raised todo-derived artifacts (informational: candidates are allowed by D3). */
    readonly todoDerived: readonly { readonly sessionId: string; readonly artifactId: string; readonly detectorCode: string }[]
    /** Todo-derived artifacts that are structural — must always be empty. */
    readonly todoDerivedNeedsYou: readonly { readonly sessionId: string; readonly artifactId: string; readonly detectorCode: string }[]
    /**
     * Items still open at log end whose family has no *unconditional* log
     * closer (`conditional` / `user-only` / `disabled`), by declared capability.
     * Not a regex match; the family and policy are reported with the row.
     */
    readonly noClosureDetector: readonly {
      readonly sessionId: string
      readonly artifactId: string
      readonly family: ArtifactFamily
      readonly policy: FamilyClosurePolicy
    }[]
    /** Raised artifacts whose family is missing from {@link FAMILY_CLOSURES}. */
    readonly unclassifiedArtifacts: readonly { readonly sessionId: string; readonly artifactId: string; readonly detectorCode: string }[]
    /** The declared per-family closure map with this fold's observed numbers. */
    readonly familyClosures: readonly FamilyClosureReport[]
  }
  readonly target: {
    readonly maxStructural: number
    readonly met: boolean
    readonly strict: boolean
  }
  readonly skipped?: string
}

/** One artifact raised by the fold, with its last observed disposition. */
interface TracedArtifact {
  readonly origin: DraftOrigin
  readonly family: ArtifactFamily | undefined
  /** Last disposition in log order: a later closure overrides an open draft. */
  disposition: 'open' | 'closed'
}

/**
 * Compute the M1 invariants over the drafts a fold run produced.
 *
 * **Accounting:** the fold emits an open draft when an artifact appears and a
 * closure draft (with `closes`) when it resolves, so a raw count of open drafts
 * overstates the inbox — it counts *raised* items, not items open at log end.
 * Drafts are replayed in fold order and each artifact keeps its last
 * disposition: an artifact closed by a later draft is subtracted. Re-raises are
 * deduped by session+artifact (one item); a re-raise after a closure re-opens it.
 *
 * **Closure capability:** whether a raised artifact *can* be closed is decided
 * by its family's declaration in {@link FAMILY_CLOSURES}, not by matching words
 * in its detector code.
 * @param origins - drafts with their sessions, in fold order.
 * @param sessions - corpus sessions (for root-only checks).
 * @param corpus - corpus metadata for the report header.
 * @param capture - adapter availability metadata.
 * @param now - report timestamp (defaults to `Date.now`).
 * @returns the acceptance report.
 */
export function computeInvariants(
  origins: readonly DraftOrigin[],
  sessions: readonly CorpusSession[],
  corpus: LoadedCorpus,
  capture: { readonly available: boolean; readonly adapter?: string; readonly reason?: string; readonly probes: readonly string[]; readonly foldedSessions: number; readonly foldErrors: readonly { readonly sessionId: string; readonly message: string }[] },
  now: number = Date.now(),
): AcceptanceReport {
  const sessionById = new Map(sessions.map(session => [session.header.id, session]))
  const traced = new Map<string, TracedArtifact>()
  const closureDrafts: DraftOrigin[] = []
  for (const origin of origins) {
    const key = `${origin.sessionId}|${origin.draft.artifactId}`
    if (origin.draft.closes !== undefined) {
      closureDrafts.push(origin)
      const existing = traced.get(key)
      if (existing !== undefined) existing.disposition = 'closed'
      continue
    }
    // A later open draft after a closure re-opens the artifact (last one wins).
    traced.set(key, {
      origin,
      family: familyOfDraft(origin.draft),
      disposition: 'open',
    })
  }
  const raised = [...traced.values()]
  const openArtifacts = raised.filter(artifact => artifact.disposition === 'open')

  const perKind: Record<string, number> = {}
  let structural = 0
  let candidate = 0
  for (const { origin } of openArtifacts) {
    const { draft } = origin
    perKind[draft.kind] = (perKind[draft.kind] ?? 0) + 1
    if (draft.tier === 'structural') structural += 1
    else candidate += 1
  }

  const rootOnlyViolations: { sessionId: string; artifactId: string; kind: OpenItemKind }[] = []
  const todoDerived: { sessionId: string; artifactId: string; detectorCode: string }[] = []
  const todoDerivedNeedsYou: { sessionId: string; artifactId: string; detectorCode: string }[] = []
  for (const { origin, family } of openArtifacts) {
    const { draft } = origin
    const session = sessionById.get(origin.sessionId)
    const nonRoot = session !== undefined
      && (session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0)
    if (nonRoot) {
      rootOnlyViolations.push({
        sessionId: origin.sessionId,
        artifactId: draft.artifactId,
        kind: draft.kind,
      })
    }
    if (family === 'todo' || mentionsTodo(draft)) {
      const todoRow = {
        sessionId: origin.sessionId,
        artifactId: draft.artifactId,
        detectorCode: draft.detectorCode,
      }
      todoDerived.push(todoRow)
      if (draft.tier === 'structural') todoDerivedNeedsYou.push(todoRow)
    }
  }

  // Declared capability: an item still open at log end whose family has no
  // *unconditional* log closer needs a user action; an artifact whose family is
  // not declared at all is a map gap, reported separately so a new family
  // cannot slip in unclassified.
  const noClosureDetector: { sessionId: string; artifactId: string; family: ArtifactFamily; policy: FamilyClosurePolicy }[] = []
  const unclassifiedArtifacts: { sessionId: string; artifactId: string; detectorCode: string }[] = []
  for (const { origin, family } of raised) {
    if (family !== undefined) continue
    unclassifiedArtifacts.push({
      sessionId: origin.sessionId,
      artifactId: origin.draft.artifactId,
      detectorCode: origin.draft.detectorCode,
    })
  }
  for (const { origin, family } of openArtifacts) {
    if (family === undefined) continue
    const policy = FAMILY_CLOSURES[family].policy
    if (policy === 'detector') continue
    noClosureDetector.push({
      sessionId: origin.sessionId,
      artifactId: origin.draft.artifactId,
      family,
      policy,
    })
  }

  // Attribute every closure to the family of the artifact it closed. When the
  // open draft was suppressed (historical live-only pending asks), infer the
  // family from the artifact identity instead.
  const closureAttribution: { readonly family: ArtifactFamily | undefined; readonly matched: boolean }[] = closureDrafts.map(origin => {
    const key = `${origin.sessionId}|${origin.draft.closes!.artifactId}`
    const target = traced.get(key)
    return {
      family: target?.family ?? familyOfClosureWithoutOpen(origin.draft),
      matched: target !== undefined,
    }
  })

  const familyClosures: FamilyClosureReport[] = ARTIFACT_FAMILIES.map(family => {
    const declared = FAMILY_CLOSURES[family]
    const familyRaised = raised.filter(artifact => artifact.family === family)
    const familyClosures = closureAttribution.filter(entry => entry.family === family)
    return {
      family,
      policy: declared.policy,
      closers: declared.closers,
      note: declared.note,
      raised: familyRaised.length,
      open: familyRaised.filter(artifact => artifact.disposition === 'open').length,
      closures: familyClosures.length,
      closuresWithoutRaise: familyClosures.filter(entry => !entry.matched).length,
    }
  })

  const times = sessions.map(session => session.updatedAt).filter(value => Number.isFinite(value))
  const rootSessions = sessions.filter(session => !(session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0))
  const strict = process.env['OI_ACCEPTANCE_STRICT'] === '1'

  return {
    generatedAt: new Date(now).toISOString(),
    corpus: {
      dshHome: corpus.dshHome,
      sessionsRoot: corpus.sessionsRoot,
      filesFound: corpus.files.length,
      sessionsRead: sessions.length,
      nonRootExcluded: sessions.length - rootSessions.length,
      seededSessions: sessions.filter(session => session.header.isSeeded).length,
      archivedSessions: sessions.filter(session => session.info.archived).length,
      eventsTotal: sessions.reduce((total, session) => total + session.events.length, 0),
      inheritedEventsCut: sessions.reduce((total, session) => total + session.inheritedEventCount, 0),
      todoWriteEvents: sessions.reduce(
        (total, session) => total + session.events.filter(event => event.type === 'todo/write').length,
        0,
      ),
      oldestActivity: times.length === 0 ? null : Math.min(...times),
      newestActivity: times.length === 0 ? null : Math.max(...times),
      workspaceCount: corpus.membership.workspaceCounts.size,
      issues: corpus.issues,
    },
    capture,
    counts: {
      perKind,
      structural,
      candidate,
      uniqueArtifacts: openArtifacts.length,
      raisedArtifacts: raised.length,
      closedArtifacts: raised.length - openArtifacts.length,
      closures: closureDrafts.length,
      unmatchedClosures: closureAttribution.filter(entry => !entry.matched).length,
      totalDrafts: origins.length,
    },
    invariants: { rootOnlyViolations, todoDerived, todoDerivedNeedsYou, noClosureDetector, unclassifiedArtifacts, familyClosures },
    target: {
      maxStructural: M1_MAX_STRUCTURAL_ITEMS,
      met: structural <= M1_MAX_STRUCTURAL_ITEMS,
      strict,
    },
  }
}

/** Whether a draft looks derived from a `todo_write` snapshot (safety net over the family map). */
function mentionsTodo(draft: DerivedItemDraft): boolean {
  const haystack = `${draft.artifactId} ${draft.detectorCode} ${draft.title}`.toLowerCase()
  return haystack.includes('todo')
}

/** Format an acceptance report as the short human summary the wrapper prints. */
export function formatReport(report: AcceptanceReport): string {
  if (report.skipped !== undefined) {
    return [
      'Open Items M1 acceptance — SKIPPED',
      `  reason: ${report.skipped}`,
      `  probes: ${report.capture.probes.join('; ') || '(none)'}`,
      `  corpus: ${report.corpus.filesFound} file(s) found under ${report.corpus.sessionsRoot}`,
    ].join('\n')
  }
  const kinds = Object.entries(report.counts.perKind)
    .sort((left, right) => right[1] - left[1])
    .map(([kind, count]) => `${kind}=${count}`)
    .join(', ') || '(none)'
  const target = report.target.met ? 'MET' : 'MISSED'
  const familyLines = report.invariants.familyClosures.map(family => {
    const closer = family.closers.length === 0 ? '(none)' : family.closers.join(' | ')
    const suppressed = family.closuresWithoutRaise === 0 ? '' : `, of which ${family.closuresWithoutRaise} without a raised row`
    return `    ${family.family}: ${family.policy} ${closer}`
      + ` — raised=${family.raised}, open=${family.open}, closures=${family.closures}${suppressed}`
  })
  const noCloserLines = report.invariants.noClosureDetector.slice(0, 5).map(row => (
    `    ${row.family} (${row.policy}): ${row.artifactId}`
  ))
  return [
    'Open Items M1 acceptance — real corpus',
    `  adapter: ${report.capture.adapter ?? '(none)'}`,
    `  corpus: ${report.corpus.filesFound} file(s), ${report.corpus.sessionsRead} read`
      + ` (${report.corpus.nonRootExcluded} non-root excluded), ${report.corpus.seededSessions} seeded`
      + `, ${report.corpus.eventsTotal} events (${report.corpus.inheritedEventsCut} inherited cut)`,
    `  workspace membership: ${report.corpus.workspaceCount} workspace(s)`,
    `  per-kind: ${kinds}`,
    `  structural items: ${report.counts.structural} open at log end (target ≤${report.target.maxStructural} — ${target};`
      + ` candidate=${report.counts.candidate}, raised=${report.counts.raisedArtifacts},`
      + ` closed=${report.counts.closedArtifacts}, closures=${report.counts.closures}`
      + `, unmatched closures=${report.counts.unmatchedClosures})`,
    '  closure map (declared capability; observed in this fold):',
    ...familyLines,
    `  invariants: root-only violations=${report.invariants.rootOnlyViolations.length},`
      + ` todo-derived=${report.invariants.todoDerived.length}`
      + ` (needs-you=${report.invariants.todoDerivedNeedsYou.length}),`
      + ` no unconditional detector closer=${report.invariants.noClosureDetector.length},`
      + ` unclassified families=${report.invariants.unclassifiedArtifacts.length}`,
    ...(noCloserLines.length === 0 ? [] : ['  user-closable rows (no later log evidence):', ...noCloserLines]),
    `  fold errors: ${report.capture.foldErrors.length}`,
    `  last run: ${LAST_RUN_PATH}`,
  ].join('\n')
}

/**
 * Persist the last run next to the suite (the wrapper reads it).
 * @param report - report to write.
 * @param path - destination (defaults to {@link LAST_RUN_PATH}).
 */
export async function writeLastRun(report: AcceptanceReport, path: string = LAST_RUN_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

/**
 * Run the capture adapter over the root sessions of a corpus.
 * @param adapter - capture adapter.
 * @param corpus - loaded corpus.
 * @returns draft origins plus fold errors and the folded-session count.
 */
export async function foldCorpus(
  adapter: CaptureAdapter,
  corpus: LoadedCorpus,
): Promise<{
  origins: readonly DraftOrigin[]
  foldedSessions: number
  foldErrors: readonly { readonly sessionId: string; readonly message: string }[]
}> {
  const origins: DraftOrigin[] = []
  const foldErrors: { sessionId: string; message: string }[] = []
  let foldedSessions = 0
  for (const session of corpus.sessions) {
    if (session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0) continue
    foldedSessions += 1
    try {
      const drafts = await adapter.foldSession(session)
      for (const draft of drafts) origins.push({ sessionId: session.header.id, draft })
    } catch (error) {
      foldErrors.push({ sessionId: session.header.id, message: describe(error) })
    }
  }
  return { origins, foldedSessions, foldErrors }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Narrow unknown to a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Describe an unknown error. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Latest title carried by a `session/title` event. */
function latestTitle(events: readonly CaptureEvent[]): string | undefined {
  let title: string | undefined
  for (const event of events) {
    if (event.type !== 'session/title') continue
    if (isRecord(event.data) && typeof event.data['title'] === 'string' && event.data['title'] !== '') {
      title = event.data['title']
    }
  }
  return title
}
