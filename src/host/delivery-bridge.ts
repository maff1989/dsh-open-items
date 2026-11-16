/**
 * rc.1 Host session bridge for the reply engine.
 *
 * The engine never imports a Host service; this module is the only place that
 * talks to the installed rc.1 runtime. Every service is read lazily with
 * `ctx.get(...)` and feature-detected:
 *
 * - `agents` (`AgentRegistry`) — the live Agent registry, used for the
 *   non-waking probe and `turnBoundaryOf`.
 * - `sessionController` — only for a *confirmed* cold resume. A profile without
 *   it (headless) degrades to `agent-unavailable`, never to a silent success.
 * - `sessions` — the `session/flush` durability barrier. Without it the queue
 *   write still commits (that is the accepted point); only the restart
 *   guarantee is weaker, and the engine says so in its note.
 * - `workspaceRegistry` — the durable archive set. Without it there is no
 *   archive concept in this profile, so no Session can be archived.
 *
 * **Waking rule.** `resolveAgent` is a non-waking probe: it reads the live Agent
 * registry and never resumes. Resuming a cold Session is the exported
 * `resumeAgent` extension, called by the engine only for an explicit,
 * confirmed message delivery, because resolving makes the Session resident
 * until Host shutdown (`research/session-delivery.md` §3.2).
 *
 * @module dsh-open-items/host/delivery-bridge
 */

import { randomUUID } from 'node:crypto'

import type { OpenItemRecord } from '../shared/schema'
import {
  LIVE_ASKS_SERVICE,
  type HostSettleRequest,
  type HostSettleResult,
  type LiveAskCarrier,
  type LiveAskObservation,
  type OutboundMessage,
  type ReplyCapabilities,
  type SessionBridge,
} from './delivery-contract'

/** The slice of the Cordis Host context the bridge reads; the real context satisfies it. */
export interface BridgeContext {
  /** Read a service by name; absent optional services return `undefined`. */
  get(name: string): unknown
}

/** One text block of the durable message the bridge sends. */
export interface MessageTextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Options for {@link createSessionBridge}. */
export interface SessionBridgeOptions {
  /**
   * Build the durable `user/message`. Omitted, the bridge builds the exact
   * structural equivalent of the installed `createUserMessage`
   * (`inst:dsh-llm/lib/index.js`: `deepFreeze(structuredClone({ ...input, id: randomUUID() }))`
   * plus `role: 'user'`). The Host wiring may pass the installed factory
   * instead; this package does not depend on `@deepseek-ai/dsh-llm`, so the
   * default is what runs unless the wiring supplies one.
   * @param input - exact content and source, no role or identity.
   * @returns the durable user message.
   */
  createUserMessage?(input: {
    readonly content: readonly MessageTextBlock[]
    readonly source: OutboundMessage['source']
  }): unknown
}

/** The bridge this module builds: every optional port is present here. */
export interface HostSessionBridge extends SessionBridge {
  /** Resume a cold Session (waking). The engine calls this only for a confirmed send or settle. */
  resumeAgent(sessionId: string): ReturnType<SessionBridge['resolveAgent']>
  /** Settle a continued timed question; refuses honestly when the profile cannot. */
  hostSettle(agent: unknown, request: HostSettleRequest): Promise<HostSettleResult>
  /** Capability report read by `hello` through the engine. */
  capabilities(): ReplyCapabilities
}

/** Loose record test for feature-detected runtime values. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read one callable member without assuming the runtime shape. */
function methodOf(target: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  const value = isRecord(target) ? target[name] : undefined
  if (typeof value !== 'function') return undefined
  return value as (...args: unknown[]) => unknown
}

/** Read one string member without assuming the runtime shape. */
function stringOf(target: unknown, name: string): string | undefined {
  const value = isRecord(target) ? target[name] : undefined
  return typeof value === 'string' ? value : undefined
}

/** Deep-freeze one plain value; the durable message is immutable like `createUserMessage`'s. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const entry of Object.values(value)) deepFreeze(entry)
  }
  return value
}

/**
 * Build the durable user message handed to the agent loop.
 *
 * A message factory is the only blessed constructor (`createUserMessage`), but
 * this package deliberately does not depend on `@deepseek-ai/dsh-llm`; the
 * structural equivalent below is what runs by default, and the wiring can
 * override it through {@link SessionBridgeOptions.createUserMessage}.
 * @param message - the engine's outbound message.
 * @param factory - optional installed message factory.
 * @returns the durable user message.
 */
export function buildUserMessage(
  message: OutboundMessage,
  factory?: SessionBridgeOptions['createUserMessage'],
): unknown {
  const input = {
    content: [{ type: 'text' as const, text: message.text }],
    source: message.source,
  }
  if (factory !== undefined) return factory(input)
  return deepFreeze(structuredClone({ ...input, role: 'user' as const, id: randomUUID() }))
}

/** One structured answer item, mirroring the installed `AskUserQuestionAnswerItem`. */
interface AnswerItemLike {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** The answer batch, or the reason the inbox cannot build one. */
type AnswerBatch =
  | { readonly ok: true; readonly answer: { readonly answers: readonly AnswerItemLike[] } }
  | { readonly ok: false; readonly reason: 'needs-batch' | 'bad-answer' }

/**
 * Build the answer batch for one ask from the inbox payload.
 *
 * The inbox row names one choice, so a multi-question ask is refused
 * (`needs-batch`) instead of guessing answers for questions the user never saw.
 * @param questions - the ask's questions from the projection.
 * @param payload - exactly what the user chose.
 * @returns the batch, or the refusal reason.
 */
function answerBatch(questions: readonly unknown[], payload: HostSettleRequest['payload']): AnswerBatch {
  if (payload.type !== 'option' && payload.type !== 'text') return { ok: false, reason: 'bad-answer' }
  if (questions.length !== 1) return { ok: false, reason: 'needs-batch' }
  const question = questions[0]
  const id = isRecord(question) ? stringOf(question, 'id') : undefined
  if (id === undefined || id === '') return { ok: false, reason: 'bad-answer' }
  if (payload.type === 'text') {
    return { ok: true, answer: { answers: [{ id, selected: [], custom: payload.text }] } }
  }
  const options = isRecord(question) && Array.isArray(question['options']) ? question['options'] : []
  const labels = options
    .map(option => (isRecord(option) ? stringOf(option, 'label') : undefined))
    .filter((label): label is string => label !== undefined)
  if (!labels.includes(payload.option)) return { ok: false, reason: 'bad-answer' }
  return { ok: true, answer: { answers: [{ id, selected: [payload.option] }] } }
}

/**
 * Create the Host bridge the reply engine drives.
 * @param ctx - Host context (services are read lazily, so a later mount is picked up).
 * @param options - optional message factory override.
 * @returns the bridge plus the waking extension.
 */
export function createSessionBridge(ctx: BridgeContext, options: SessionBridgeOptions = {}): HostSessionBridge {
  /** Current service instance, or `undefined` when the profile does not mount it. */
  function service(name: string): unknown {
    return ctx.get(name)
  }

  /** Read the Agent registry's live entry and describe it, never resuming. */
  function liveAgent(sessionId: string): unknown {
    const agents = service('agents')
    const get = methodOf(agents, 'get')
    if (get === undefined) return undefined
    const agent = get.call(agents, sessionId)
    return isRecord(agent) ? agent : undefined
  }

  /** Whether the Agent's Session currently has an open turn. */
  function turnOpen(agent: unknown): boolean {
    const agents = service('agents')
    const boundaryOf = methodOf(agents, 'turnBoundaryOf')
    const session = isRecord(agent) ? agent['session'] : undefined
    if (boundaryOf === undefined || !isRecord(session)) {
      // Without the boundary projection, a running driver is the conservative
      // proxy: steering a running Agent is always safe, waking one is not.
      return stringOf(agent, 'status') === 'running'
    }
    const boundary = boundaryOf.call(agents, session)
    if (!isRecord(boundary)) return false
    const open = boundary['openTurnStartSeq']
    return open !== null && open !== undefined
  }

  /** Describe one live Agent for the engine's matrix. */
  function probeOf(agent: unknown): { ok: true; agent: unknown; running: boolean; turnOpen: boolean } {
    const running = stringOf(agent, 'status') === 'running'
    return { ok: true, agent, running, turnOpen: running || turnOpen(agent) }
  }

  /** The Agent field of a controller result, when the call succeeded. */
  function agentOf(resolved: unknown): unknown {
    if (!isRecord(resolved) || 'error' in resolved) return undefined
    return resolved['agent']
  }

  /** The stable Remote error code of a controller result, when the call failed. */
  function errorCodeOf(resolved: unknown): string | undefined {
    if (!isRecord(resolved)) return undefined
    const error = resolved['error']
    return isRecord(error) ? stringOf(error, 'code') : undefined
  }

  /** The `userQuestions` answerer, when this profile mounts it. */
  function questionAnswerer(): { readonly service: unknown; readonly answer: (...args: unknown[]) => unknown } | undefined {
    const questions = service('userQuestions')
    const answer = methodOf(questions, 'answer')
    return answer === undefined ? undefined : { service: questions, answer }
  }

  /** The projection reader used to recover the ask's full question batch. */
  function projectionOf(session: unknown): unknown {
    const projections = service('sessionProjections')
    const snapshot = methodOf(projections, 'snapshot')
    if (snapshot === undefined) return undefined
    return snapshot.call(projections, session, ['userQuestions'])
  }

  /** The `userQuestions` view of one live Session, read from the projection cut. */
  function questionView(session: unknown): unknown {
    const cut = projectionOf(session)
    const values = isRecord(cut) ? cut['values'] : undefined
    const view = isRecord(values) ? values['userQuestions'] : undefined
    return isRecord(view) ? view['active'] : undefined
  }

  /** The observe-only live-ask carrier, when the capture wiring provided one. */
  function liveAskCarrier(): LiveAskCarrier | undefined {
    const candidate = service(LIVE_ASKS_SERVICE)
    const get = methodOf(candidate, 'get')
    return get === undefined ? undefined : candidate as LiveAskCarrier
  }

  /** The carrier's observation for one ask identity, if this Host saw the ask. */
  function observedAsk(sessionId: string, callId: string | undefined): LiveAskObservation | undefined {
    if (callId === undefined || callId === '') return undefined
    const carrier = liveAskCarrier()
    if (carrier === undefined) return undefined
    try {
      return carrier.get(sessionId, callId)
    } catch {
      return undefined
    }
  }

  /** The item's artifact identity (the capture fold's key for the same ask). */
  function artifactOf(item: OpenItemRecord): string | undefined {
    if (item.kind === 'approval') {
      const key = item.source.callId ?? item.source.approvalId
      return key === undefined ? undefined : `approval:${key}`
    }
    if (item.kind === 'question' || item.kind === 'plan-review') {
      return item.source.callId === undefined ? undefined : `question:${item.source.callId}`
    }
    return undefined
  }

  /** Our own capture ledger for the item's session, when the projection carrier is mounted. */
  function ownLedger(session: unknown, item: OpenItemRecord): unknown {
    const projections = service('sessionProjections')
    const snapshot = methodOf(projections, 'snapshot')
    if (snapshot === undefined) return undefined
    const artifactId = artifactOf(item)
    if (artifactId === undefined) return undefined
    const cut = snapshot.call(projections, session, ['openItems'])
    const values = isRecord(cut) ? cut['values'] : undefined
    const ledger = isRecord(values) ? values['openItems'] : undefined
    const items = isRecord(ledger) ? ledger['items'] : undefined
    return isRecord(items) ? items[artifactId] : undefined
  }

  return {
    capabilities(): ReplyCapabilities {
      // Truthful advertisement: track 2 needs both the answerer and the
      // projection that names every question of the ask.
      return {
        clientSettle: true,
        hostSettle: questionAnswerer() !== undefined
          && methodOf(service('sessionProjections'), 'snapshot') !== undefined,
      }
    },

    async hostSettle(agent: unknown, request: HostSettleRequest): Promise<HostSettleResult> {
      const answerer = questionAnswerer()
      const session = isRecord(agent) ? agent['session'] : undefined
      if (answerer === undefined || !isRecord(session)) {
        return { ok: false, reason: 'not-answerable' }
      }
      const active = questionView(session)
      if (!Array.isArray(active)) return { ok: false, reason: 'not-answerable' }
      const pending = active.find(entry => isRecord(entry) && stringOf(entry, 'callId') === request.callId)
      // Only a `continued` ask can be answered out-of-band: an `open` ask is
      // owned by the live card waterfall, and settling it here would race the
      // browser that is showing it.
      if (!isRecord(pending) || stringOf(pending, 'state') !== 'continued') {
        return { ok: false, reason: 'not-answerable' }
      }
      const questions = Array.isArray(pending['questions']) ? pending['questions'] : []
      const batch = answerBatch(questions, request.payload)
      if (!batch.ok) return { ok: false, reason: batch.reason }
      try {
        const accepted = answerer.answer.call(answerer.service, agent, request.callId, batch.answer)
        return accepted === true ? { ok: true } : { ok: false, reason: 'not-answerable' }
      } catch (error) {
        const code = isRecord(error) ? stringOf(error, 'code') : undefined
        if (code === 'REPLY_QUEUED') return { ok: false, reason: 'reply-queued' }
        if (code === 'BAD_ANSWER') return { ok: false, reason: 'bad-answer' }
        // The service threw without a taxonomy this Host understands; never
        // report success, because the steer may or may not have been queued.
        return { ok: false, reason: 'unknown-outcome' }
      }
    },

    async askLiveness(item: OpenItemRecord): Promise<'live' | 'not-live' | 'unknown'> {
      // Only a derived item mirrors a live ask; an authored item has none.
      if (!item.dedupeKey.startsWith('derived|')) return 'unknown'
      const sessionId = item.source.sessionId
      // A live ask cannot outlive its Session's live Agent: the card that owns
      // it is gone, so a settle now would misstate the outcome.
      const agent = liveAgent(sessionId)
      if (agent === undefined) return 'not-live'
      const session = isRecord(agent) ? agent['session'] : undefined

      if (item.kind === 'question' || item.kind === 'plan-review') {
        const callId = item.source.callId
        // Timed asks are reconstructed in the shipped projection: `continued`
        // means the card is gone and only a message can answer it now.
        const active = questionView(session)
        if (Array.isArray(active)) {
          const pending = active.find(entry => isRecord(entry) && stringOf(entry, 'callId') === callId)
          if (isRecord(pending)) return stringOf(pending, 'state') === 'continued' ? 'not-live' : 'live'
        }
        const observed = observedAsk(sessionId, callId)
        if (observed !== undefined && observed.state === 'settled') {
          return observed.outcome === 'unavailable' || observed.outcome === 'cancelled' ? 'not-live' : 'live'
        }
        // A legacy blocking ask is not in the projection; while the capture
        // ledger still holds its artifact it is genuinely in flight.
        if (ownLedger(session, item) !== undefined) return 'live'
        return 'unknown'
      }

      if (item.kind === 'approval') {
        const observed = observedAsk(sessionId, item.source.callId)
        if (observed !== undefined) {
          if (observed.state === 'pending') return 'live'
          // A user decision is the settle this track reports; it is not
          // positive evidence against it. An unavailable/cancelled ask is.
          if (observed.outcome === 'unavailable' || observed.outcome === 'cancelled') return 'not-live'
          return 'unknown'
        }
        if (ownLedger(session, item) !== undefined) return 'live'
        return 'unknown'
      }
      return 'unknown'
    },

    archived(sessionId: string): boolean {
      const registry = service('workspaceRegistry')
      const ids = isRecord(registry) ? registry['archivedSessionIds'] : undefined
      // No registry ⇒ this profile has no archive set, so nothing is archived.
      if (!Array.isArray(ids)) return false
      return ids.some(id => id === sessionId)
    },

    resolveAgent(sessionId: string): ReturnType<SessionBridge['resolveAgent']> {
      const agent = liveAgent(sessionId)
      // Non-waking by contract: a cold Session stays cold here.
      if (agent === undefined) return Promise.resolve({ ok: false, reason: 'agent-unavailable' })
      return Promise.resolve(probeOf(agent))
    },

    resumeAgent(sessionId: string): ReturnType<SessionBridge['resolveAgent']> {
      return (async () => {
        const controller = service('sessionController')
        const resolve = methodOf(controller, 'resolveAgent')
        if (resolve === undefined) return { ok: false as const, reason: 'agent-unavailable' as const }
        let resolved: unknown
        try {
          resolved = await resolve.call(controller, sessionId)
        } catch {
          // The resume threw: the outcome is genuinely unknown (a live Agent may
          // have been published before the failure), so never report success.
          return { ok: false as const, reason: 'unknown-outcome' as const }
        }
        const code = errorCodeOf(resolved)
        // The registry entry is authoritative: a controller result can be a
        // handle published before a shared resume replaced it.
        const agent = liveAgent(sessionId) ?? agentOf(resolved)
        if (agent === undefined) {
          return {
            ok: false as const,
            reason: code === 'session/not-found' || code === 'session/agent-busy'
              ? 'agent-unavailable' as const
              : 'unknown-outcome' as const,
          }
        }
        return probeOf(agent)
      })()
    },

    steer(agent: unknown, message: OutboundMessage): void {
      const steer = methodOf(agent, 'steer')
      if (steer === undefined) throw new Error('the live session does not accept steering')
      steer.call(agent, buildUserMessage(message, options.createUserMessage))
    },

    followup(agent: unknown, message: OutboundMessage): void {
      const followup = methodOf(agent, 'followup')
      if (followup === undefined) throw new Error('the live session does not accept a follow-up message')
      followup.call(agent, buildUserMessage(message, options.createUserMessage))
    },

    async flush(agent: unknown): Promise<void> {
      const sessions = service('sessions')
      const flush = methodOf(sessions, 'flush')
      const session = isRecord(agent) ? agent['session'] : undefined
      // No flush service or no Session: nothing to await. The queue write is
      // still the accepted point; only the restart barrier is missing.
      if (flush === undefined || session === undefined) return
      await flush.call(sessions, session)
    },
  }
}
