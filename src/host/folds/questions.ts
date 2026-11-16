/**
 * Question and plan-review fold: a `tool/call` for `ask_user_question` or
 * `exit_plan_mode` that never received its `tool/result`.
 *
 * That is the durable trace of "the agent asked and the user never came back":
 * while the ask is in flight the call has no result, and after a crash the log
 * simply ends with the call open (resume repair appends a synthetic result,
 * which both closes this item and raises `turn.interrupted`).
 *
 * Closing detector: the `tool/result` for the same `callId` — a real answer, a
 * timeout payload, or the synthetic `TOOL_OUTCOME_UNKNOWN` repair result.
 *
 * @module dsh-open-items/host/folds/questions
 */

import type { CaptureEvent, CaptureSessionInfo } from '../capture-contract'
import type { DetectionSource } from '../../shared/schema'
import { type FoldStep, closeDraft, openDraft } from './drafts'
import { arrayOf, bodyFrom, parseJsonObject, quoteFrom, recordOf, textOf, titleFrom } from './limits'
import { type LedgerState, type OpenArtifact, type PendingCall, putArtifact, removeArtifact, withMap } from './state'

/** Model-facing tool names this fold treats as a user ask. */
export const ASK_TOOLS = ['ask_user_question', 'exit_plan_mode'] as const

/** Artifact identity for one unanswered ask. */
export function askArtifactId(callId: string): string {
  return `question:${callId}`
}

/**
 * Fold one event for the question/plan-review artifact family.
 * @param state - current ledger state.
 * @param event - next committed event.
 * @param session - owning session metadata.
 * @param source - detector source to stamp on drafts.
 * @returns the next state and drafts, or undefined when the event is unrelated.
 */
export function foldQuestions(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  if (event.type === 'tool/call') return onToolCall(state, event, session, source)
  if (event.type === 'tool/result') return onToolResult(state, event, session, source)
  return undefined
}

/** Open an item for an ask that has no result yet. */
function onToolCall(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  const call = asToolCall(event.data)
  if (call === undefined) return undefined
  // Every tool call is remembered until its result lands: the interrupted-turn
  // fold needs the name of a call whose result never durably recorded one.
  const intent: PendingCall['intent'] | undefined = call.name === 'exit_plan_mode'
    ? 'plan-review'
    : call.name === 'ask_user_question' ? 'question' : undefined
  const pending: PendingCall = { name: call.name, turn: call.turn, seq: event.seq, ...intent === undefined ? {} : { intent } }
  const withCall = withMap(state, 'calls', { ...state.calls, [call.callId]: pending })
  if (intent === undefined) return { state: withCall, drafts: [] }
  const artifact = intent === 'plan-review'
    ? planReviewArtifact(event, call, session)
    : questionArtifact(event, call, session)
  return {
    state: putArtifact(withCall, artifact),
    drafts: [openDraft(artifact, { session, source })],
  }
}

/** Close the ask when its result lands; the result may be a real answer or the repair's synthetic one. */
function onToolResult(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  const callId = toolResultCallId(event.data)
  if (callId === undefined) return undefined
  const pending = state.calls[callId]
  if (pending?.intent === undefined) return undefined
  const artifactId = askArtifactId(callId)
  const artifact = state.items[artifactId] ?? fallbackArtifact(artifactId, pending, event)
  return {
    state: removeArtifact(state, artifactId),
    drafts: [closeDraft(artifact, { session, source }, event.time, 'tool/result')],
  }
}

/** Build the question artifact from the raw model arguments (unparsed JSON string). */
function questionArtifact(
  event: CaptureEvent,
  call: { callId: string; name: string; turn: number; arguments: string },
  session: CaptureSessionInfo,
): OpenArtifact {
  const args = parseJsonObject(call.arguments)
  const questions = arrayOf(args?.['questions'])
  const lines: string[] = []
  const options: string[] = []
  let firstQuestion: string | undefined
  for (const entry of questions) {
    const question = recordOf(entry)
    if (question === undefined) continue
    const prompt = textOf(question['question'])
    if (prompt === undefined) continue
    firstQuestion ??= prompt
    const header = textOf(question['header'])
    lines.push(header === undefined ? `• ${prompt}` : `• ${header}: ${prompt}`)
    for (const option of arrayOf(question['options'])) {
      const label = textOf(recordOf(option)?.['label'])
      if (label !== undefined && !options.includes(label)) options.push(label)
    }
  }
  const title = firstQuestion === undefined ? 'Question waiting for an answer' : titleFrom(firstQuestion)
  const body = lines.length === 0
    ? `The agent called \`${call.name}\` and the call has no recorded result.`
    : `The agent is waiting on ${lines.length === 1 ? 'an answer' : `${lines.length} answers`}:\n${lines.join('\n')}`
  return {
    artifactId: askArtifactId(call.callId),
    kind: 'question',
    severity: 1,
    seq: event.seq,
    turn: call.turn,
    title,
    body: bodyFrom(body),
    detectorCode: 'tool/call:awaiting-answer',
    blocking: true,
    raisedAt: event.time,
    callId: call.callId,
    ...firstQuestion === undefined ? {} : { quote: quoteFrom(firstQuestion) },
    reply: {
      controls: options.length === 0 ? ['text'] : ['option', 'text'],
      freeText: true,
      requiresConfirm: true,
      ...options.length === 0 ? {} : { options },
    },
  }
}

/** Build the plan-review artifact from `exit_plan_mode`'s plan argument. */
function planReviewArtifact(
  event: CaptureEvent,
  call: { callId: string; turn: number; arguments: string },
  _session: CaptureSessionInfo,
): OpenArtifact {
  const plan = textOf(parseJsonObject(call.arguments)?.['plan'])
  return {
    artifactId: askArtifactId(call.callId),
    kind: 'plan-review',
    severity: 1,
    seq: event.seq,
    turn: call.turn,
    title: plan === undefined ? 'Plan awaiting review' : titleFrom(`Plan awaiting review: ${plan}`),
    body: bodyFrom(plan === undefined
      ? 'The agent submitted a plan for review and the call has no recorded result.'
      : `The agent submitted a plan for review and the call has no recorded result.\n\n${plan}`),
    detectorCode: 'tool/call:plan-review',
    blocking: true,
    raisedAt: event.time,
    callId: call.callId,
    ...plan === undefined ? {} : { quote: quoteFrom(plan) },
    reply: {
      controls: ['option'],
      options: ['Approve plan', 'Keep planning'],
      freeText: false,
      requiresConfirm: true,
    },
  }
}

/** Best-effort artifact for a close whose open draft was never recorded (state seeded from a cursor). */
function fallbackArtifact(artifactId: string, pending: PendingCall, event: CaptureEvent): OpenArtifact {
  const planReview = pending.intent === 'plan-review'
  return {
    artifactId,
    kind: planReview ? 'plan-review' : 'question',
    severity: 1,
    seq: pending.seq,
    turn: pending.turn,
    title: planReview ? 'Plan awaiting review' : 'Question waiting for an answer',
    body: 'The ask resolved.',
    detectorCode: 'tool/result',
    blocking: true,
    raisedAt: event.time,
    ...planReview ? {} : { callId: artifactId.slice('question:'.length) },
  }
}

/** Read the real `tool/call` payload. */
function asToolCall(data: unknown): { callId: string; name: string; turn: number; arguments: string } | undefined {
  const record = recordOf(data)
  if (record === undefined) return undefined
  const callId = textOf(record['callId'])
  const name = textOf(record['name'])
  const turn = typeof record['turn'] === 'number' ? record['turn'] : undefined
  if (callId === undefined || name === undefined || turn === undefined) return undefined
  return { callId, name, turn, arguments: typeof record['arguments'] === 'string' ? record['arguments'] : '' }
}

/** Read the `tool/result` call identity. */
export function toolResultCallId(data: unknown): string | undefined {
  const message = recordOf(recordOf(data)?.['message'])
  return textOf(message?.['toolCallId'])
}
