/**
 * Fakes for the reply engine and the Host session bridge.
 *
 * No live harness: the store port is an in-memory item map that validates every
 * write through the same durable-boundary parser the real store uses
 * (`parseItemRecord`), and the session bridge records the exact runtime calls
 * the engine makes so the answer matrix can be asserted without a Session.
 */
import type {
  HostSettleRequest,
  HostSettleResult,
  OutboundMessage,
  RecordAttemptInput,
  ReplyCapabilities,
  ReplyStorePort,
  SessionBridge,
} from '../../src/host/delivery-contract'
import { MAX_DELIVERIES, MAX_HISTORY_ENTRIES, parseItemRecord } from '../../src/shared/records'
import type { OpenItemRecord } from '../../src/shared/schema'

/** One failed store write the engine must map to `conflict`. */
export function namedError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

/** In-memory `ReplyStorePort` with the real CAS and transition rules. */
export interface FakeStore extends ReplyStorePort {
  /** Every attempt the engine tried to persist, in order. */
  readonly writes: readonly RecordAttemptInput[]
  /** Current durable record. */
  current(): OpenItemRecord
  /** Replace the record (simulates another writer landing first). */
  set(record: OpenItemRecord): void
  /** Make the next write fail with a lost CAS without changing the record. */
  conflictNextWrite(): void
}

/**
 * Create the fake store port.
 * @param initial - starting item (build it through `makeItem` so it is valid).
 * @returns the port plus test-only inspection helpers.
 */
export function createFakeStore(initial: OpenItemRecord): FakeStore {
  let record = initial
  let conflict = false
  const writes: RecordAttemptInput[] = []
  return {
    writes,
    current: () => record,
    set: next => {
      record = next
    },
    conflictNextWrite: () => {
      conflict = true
    },
    get: id => (record.id === id ? record : undefined),
    async recordAttempt(input: RecordAttemptInput): Promise<OpenItemRecord> {
      writes.push(input)
      const current = record
      if (input.itemId !== current.id) throw namedError('NotFoundError', `open item "${input.itemId}" was not found`)
      if (conflict || input.expectedVersion !== current.version) {
        throw namedError(
          'ConflictError',
          `open item "${current.id}" changed (expected version ${input.expectedVersion}, found ${current.version})`,
        )
      }
      if (current.state !== 'open') {
        throw namedError('InvalidTransitionError', `cannot answer an item in state ${current.state}`)
      }
      const at = input.delivery.at
      // The port owns the next item state (contract: "and the next item state").
      // Mirror DESIGN §6.3: a settled or queued answer leaves the inbox and waits
      // for acknowledgement; a failed attempt leaves the item open.
      const leavesInbox = input.resolution !== undefined
        || input.delivery.state === 'queued'
        || input.delivery.state === 'delivered'
      const acknowledgement = input.acknowledgement
        ?? current.acknowledgement
        ?? (leavesInbox ? { state: 'pending' as const } : undefined)
      const next = parseItemRecord({
        ...current,
        deliveries: [...current.deliveries, input.delivery].slice(-MAX_DELIVERIES),
        version: current.version + 1,
        updatedAt: at,
        history: [...current.history, { at, action: 'delivery', detail: input.delivery.state }]
          .slice(-MAX_HISTORY_ENTRIES),
        ...(leavesInbox ? { state: 'awaiting' } : {}),
        ...(input.resolution === undefined ? {} : { resolution: input.resolution, resolvedAt: undefined }),
        ...(acknowledgement === undefined ? {} : { acknowledgement }),
      })
      record = next
      return next
    },
  }
}

/** One runtime call the engine made through the bridge. */
export interface BridgeCall {
  readonly op: 'steer' | 'followup' | 'flush'
  readonly agent: unknown
  readonly message?: OutboundMessage
}

/** One resolved-session answer the fake returns. */
export type ResolveResult = Awaited<ReturnType<SessionBridge['resolveAgent']>>

/** Behaviour switches for {@link createFakeSessions}. */
export interface FakeSessionsOptions {
  /** Whether the workspace registry lists the Session as archived. */
  readonly archived?: boolean
  /** What the non-waking probe reports (default: cold). */
  readonly probe?: ResolveResult
  /** What the waking resume reports, or the error it throws. */
  readonly resume?: ResolveResult | Error
  /** Throw from `steer` (queue write rejected). */
  readonly steerThrows?: Error
  /** Throw from `followup`. */
  readonly followupThrows?: Error
  /** Reject from `flush` (durability barrier failed after the queue write). */
  readonly flushThrows?: Error
  /** Omit the waking extension entirely (a Host with no `sessionController`). */
  readonly withoutResume?: boolean
  /** Host-settle port behaviour; absent means the Host cannot settle out-of-band. */
  readonly hostSettle?: HostSettleResult | Error
}

/** The fake bridge plus call inspection. */
export interface FakeSessions extends SessionBridge {
  readonly calls: readonly BridgeCall[]
  /** Non-waking probe calls. */
  readonly probes: number
  /** Waking resume calls. */
  readonly resumes: number
  /** Archive checks. */
  readonly archiveChecks: number
  /** Waking extension the engine feature-detects. */
  resumeAgent?(sessionId: string): Promise<ResolveResult>
  /** Host-settle port the engine feature-detects. */
  hostSettle?(agent: unknown, request: HostSettleRequest): Promise<HostSettleResult>
  /** Capability report read by `hello` through the engine. */
  capabilities?(): ReplyCapabilities
  /** Every host-settle request the engine made. */
  readonly hostSettleCalls: readonly HostSettleRequest[]
  /** Test-only archive switch. */
  setArchived(value: boolean): void
  /** Test-only probe switch. */
  setProbe(value: ResolveResult): void
}

/**
 * Create the fake bridge.
 * @param options - behaviour switches.
 * @returns the bridge plus counters.
 */
export function createFakeSessions(options: FakeSessionsOptions = {}): FakeSessions {
  const calls: BridgeCall[] = []
  const cold: ResolveResult = { ok: false, reason: 'agent-unavailable' }
  const liveIdle: ResolveResult = { ok: true, agent: { name: 'agent' }, running: false, turnOpen: false }
  let archived = options.archived ?? false
  let probe = options.probe ?? cold
  let resumeCalls = 0
  let probeCalls = 0
  let archiveCalls = 0
  const hostSettleCalls: HostSettleRequest[] = []

  const bridge: FakeSessions = {
    calls,
    hostSettleCalls,
    get probes() {
      return probeCalls
    },
    get resumes() {
      return resumeCalls
    },
    get archiveChecks() {
      return archiveCalls
    },
    setArchived: value => {
      archived = value
    },
    setProbe: value => {
      probe = value
    },
    archived: () => {
      archiveCalls += 1
      return archived
    },
    resolveAgent: async () => {
      probeCalls += 1
      return probe
    },
    steer: (agent, message) => {
      calls.push({ op: 'steer', agent, message })
      if (options.steerThrows !== undefined) throw options.steerThrows
    },
    followup: (agent, message) => {
      calls.push({ op: 'followup', agent, message })
      if (options.followupThrows !== undefined) throw options.followupThrows
    },
    flush: async (agent: unknown) => {
      calls.push({ op: 'flush', agent })
      if (options.flushThrows !== undefined) throw options.flushThrows
    },
  }

  const settleBehaviour = options.hostSettle
  if (settleBehaviour !== undefined) {
    bridge.hostSettle = async (_agent, request) => {
      hostSettleCalls.push(request)
      if (settleBehaviour instanceof Error) throw settleBehaviour
      return settleBehaviour
    }
    bridge.capabilities = () => ({ clientSettle: true, hostSettle: true })
  } else {
    bridge.capabilities = () => ({ clientSettle: true, hostSettle: false })
  }

  if (options.withoutResume !== true) {
    bridge.resumeAgent = async () => {
      resumeCalls += 1
      if (options.resume instanceof Error) throw options.resume
      const result = options.resume ?? liveIdle
      probe = result
      return result
    }
  }
  return bridge
}
