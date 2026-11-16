/**
 * Event fixtures copied from the harness's real payload shapes.
 *
 * Every payload below is a faithful instance of the installed rc.1 declaration,
 * not a minimal invention — the fold must survive the real log, and a fixture
 * that is "close enough" hides the shape bugs this suite exists to catch.
 *
 * Shapes:
 * - `tool/call` / `tool/result`: `inst/dsh-session/lib/types/types.d.ts:344-396`
 * - `turn/start` / `turn/end` / `session/end-seed`: same file, `:268-292`, `:438-440`
 * - `approval/asked` / `approval/decided`: `inst/dsh-user-approval/lib/types/types.d.ts:34-59`
 * - `goal/change` snapshot / clear tombstone: `inst/dsh-goal/lib/types/domain.d.ts:14-30`
 * - `team/task` v2: `inst/dsh-experimental-agent-team/lib/types/types.d.ts:55-66, 193-197`
 * - `job/registered` / `job/settled`: `inst/dsh-jobs/lib/types/types.d.ts:20-46`
 * - `user/message` source kinds: `inst/dsh-llm/lib/types/message.d.ts:110-160`
 *
 * @module tests/capture/fixtures
 */

import type { CaptureEvent } from '../../src/host/capture-contract'

/** Fixed base time so every fixture is deterministic. */
export const T0 = 1_760_000_000_000

/** Build one committed-event fixture. */
export function ev(seq: number, type: string, data: unknown, time = T0 + seq * 1000): CaptureEvent {
  return { seq, type, time, data }
}

/** `turn/start` — `{ turn }`. */
export function turnStart(seq: number, turn: number): CaptureEvent {
  return ev(seq, 'turn/start', { turn })
}

/** One `turn/end` — `{ turn, reason }`. */
export function turnEnd(seq: number, turn: number, reason: unknown = { kind: 'completed' }): CaptureEvent {
  return ev(seq, 'turn/end', { turn, reason })
}

/**
 * One `assistant/message` event — `{ turn, step, message, stream }` with the
 * real `AssistantMessage` shape (`inst/dsh-session/lib/types/types.d.ts`).
 *
 * Only `text` blocks are the agent's visible prose; a `reasoning` block is
 * always ignored by the prose gate, and a `tool-call` block models a step that
 * ended on a tool request rather than on words.
 */
export function assistantMessage(
  seq: number,
  turn: number,
  text: string,
  options: {
    readonly step?: number
    readonly reasoning?: string
    readonly toolCall?: { readonly id: string; readonly name: string; readonly arguments?: string }
  } = {},
): CaptureEvent {
  const content: unknown[] = []
  if (options.reasoning !== undefined) content.push({ type: 'reasoning', text: options.reasoning })
  if (options.toolCall !== undefined) {
    content.push({
      type: 'tool-call',
      id: options.toolCall.id,
      name: options.toolCall.name,
      arguments: options.toolCall.arguments ?? '{}',
    })
  }
  if (text !== '') content.push(textBlock(text))
  return ev(seq, 'assistant/message', {
    turn,
    step: options.step ?? 1,
    message: {
      id: `assistant-${seq}`,
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
      content,
    },
    stream: [],
  })
}

/**
 * One `todo/write` whole-list snapshot — `{ todos: TodoItem[] }`
 * (`inst/dsh-tool-todo/lib/types/types.d.ts`): `content` plus a three-state
 * `status`, replaced wholesale on every write.
 */
export function todoWrite(
  seq: number,
  todos: readonly { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }[],
): CaptureEvent {
  return ev(seq, 'todo/write', { todos: todos.map(todo => ({ ...todo })) })
}

/** One `tool/call` event with the raw argument JSON string. */
export function toolCall(
  seq: number,
  callId: string,
  name: string,
  args: unknown,
  position = { turn: 1, step: 1 },
): CaptureEvent {
  return ev(seq, 'tool/call', {
    turn: position.turn,
    step: position.step,
    callId,
    name,
    arguments: JSON.stringify(args),
  })
}

/** One tool-role message content block. */
export function textBlock(text: string): unknown {
  return { type: 'text', text }
}

/** One `tool/result` event for a successful call. */
export function toolResult(
  seq: number,
  callId: string,
  content: readonly unknown[],
  position = { turn: 1, step: 1 },
): CaptureEvent {
  return ev(seq, 'tool/result', {
    turn: position.turn,
    step: position.step,
    message: {
      id: `msg-${callId}`,
      role: 'tool',
      toolCallId: callId,
      source: { kind: 'tool', callId },
      content,
    },
  })
}

/** The exact synthetic result resume repair appends for an unknown outcome. */
export function interruptedResult(seq: number, callId: string, position = { turn: 1, step: 1 }): CaptureEvent {
  return ev(seq, 'tool/result', {
    turn: position.turn,
    step: position.step,
    message: {
      id: `interrupted-tool-result-${callId}-${seq}`,
      role: 'tool',
      toolCallId: callId,
      isError: true,
      source: { kind: 'tool', callId },
      content: [textBlock(
        'The tool call was interrupted after it was recorded, but no result was durably recorded. '
        + 'Its outcome is unknown. Decide whether to retry from the tool semantics.',
      )],
    },
    error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
  })
}

/** One `approval/asked` audit event. */
export function approvalAsked(
  seq: number,
  id: string,
  toolName: string,
  callId?: string,
  reason?: string,
): CaptureEvent {
  return ev(seq, 'approval/asked', {
    id,
    toolName,
    ...callId === undefined ? {} : { callId },
    ...reason === undefined ? {} : { reason },
  })
}

/** One `approval/decided` audit event. */
export function approvalDecided(seq: number, id: string, outcome: string): CaptureEvent {
  return ev(seq, 'approval/decided', { id, outcome })
}

/** The real `ask_user_question` argument payload (legacy blocking schema). */
export function askUserQuestionArgs(question: string, options: readonly string[], detail?: string): unknown {
  return {
    questions: [{
      id: 'q1',
      question,
      header: 'Confirm',
      options: options.map(label => ({ label, description: `about ${label}` })),
      ...detail === undefined ? {} : { detail },
    }],
  }
}

/** The real answer batch a successful `ask_user_question` result carries. */
export function askUserQuestionAnswers(questionId: string, selected: readonly string[]): unknown {
  return { answers: [{ id: questionId, selected: [...selected] }] }
}

/** The timed tool's pending payload, as its result content records it. */
export function pendingQuestionPayload(callId: string): unknown {
  return { pending: true, callId }
}

/** One `goal/change` snapshot event. */
export function goalSnapshot(
  seq: number,
  operation: string,
  goal: {
    id: string
    revision: number
    objective: string
    phase: string
    maxGoalRounds?: number
    blockedReason?: { code: string; message: string }
  },
): CaptureEvent {
  return ev(seq, 'goal/change', {
    kind: 'goal/change',
    version: 1,
    operation,
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      maxGoalRounds: goal.maxGoalRounds ?? 5,
      ...goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason },
    },
    roundsStarted: 2,
    createdAt: T0,
    updatedAt: T0 + seq * 1000,
  })
}

/** One `goal/change` clear tombstone. */
export function goalClear(seq: number, goalId: string): CaptureEvent {
  return ev(seq, 'goal/change', {
    kind: 'goal/change',
    version: 1,
    operation: 'clear',
    cleared: { id: goalId, revision: 3 },
    clearedAt: T0 + seq * 1000,
  })
}

/** One `team/task` version-2 snapshot. */
export function teamTask(
  seq: number,
  task: {
    id: string
    revision?: number
    subject?: string
    description?: string
    status: string
    ownerId?: string
    blockedBy?: readonly string[]
  },
  teamId = 'root-session',
): CaptureEvent {
  return ev(seq, 'team/task', {
    version: 2,
    teamId,
    task: {
      id: task.id,
      revision: task.revision ?? 1,
      subject: task.subject ?? 'Audit the driver',
      description: task.description ?? 'Check the Vulkan driver for regressions.',
      status: task.status,
      ...task.ownerId === undefined ? {} : { ownerId: task.ownerId },
      blockedBy: [...task.blockedBy ?? []],
      writeScopes: [],
    },
  })
}

/** One `job/registered` event. */
export function jobRegistered(seq: number, jobId: string, label = 'npm test'): CaptureEvent {
  return ev(seq, 'job/registered', {
    jobId,
    owner: 'root-session',
    kind: 'bash',
    label,
    startedAt: T0 + seq * 1000,
  })
}

/** One `job/settled` event (terminal record, same job registered facts). */
export function jobSettled(seq: number, jobId: string, label = 'npm test', status = 'completed'): CaptureEvent {
  return ev(seq, 'job/settled', {
    jobId,
    owner: 'root-session',
    kind: 'bash',
    label,
    startedAt: T0,
    finishedAt: T0 + seq * 1000,
    status,
    cause: 'producer',
    producerReported: true,
  })
}

/** The inherited-prefix marker a seeded fork carries at its exact cut. */
export function endSeed(seq: number, inherited = true): CaptureEvent {
  return ev(seq, 'session/end-seed', inherited ? { inherited: true } : {})
}

/** One ordinary human prompt (`user/message` with `source.kind: 'user'`). */
export function userPrompt(seq: number, text: string): CaptureEvent {
  return ev(seq, 'user/message', {
    id: `user-${seq}`,
    role: 'user',
    content: [textBlock(text)],
    source: { kind: 'user' },
  })
}

/** A `user/message` late reply to a continued question (`source.kind: 'user-question-reply'`). */
export function questionReply(seq: number, callId: string, text: string): CaptureEvent {
  return ev(seq, 'user/message', {
    id: `reply-${seq}`,
    role: 'user',
    content: [textBlock(text)],
    source: { kind: 'user-question-reply', callId, outcome: 'answered' },
  })
}

/** An event type no fold knows; the fold must ignore it and never throw. */
export function foreignEvent(seq: number): CaptureEvent {
  return ev(seq, 'some-plugin/private-event', { foo: 'bar', nested: { list: [1, 2, 3] } })
}

/** A known event type with a malformed payload; the fold must ignore it. */
export function malformedToolCall(seq: number): CaptureEvent {
  return ev(seq, 'tool/call', { callId: 42, name: null, arguments: 'not json' })
}

/** A session's committed log with a fork prefix, then its own work. */
export function forkedSessionLog(): CaptureEvent[] {
  return [
    // Inherited prefix (belongs to the parent session): its approval and ask.
    approvalAsked(0, 'approval-parent', 'bash', 'call-parent', 'parent approval'),
    approvalDecided(1, 'approval-parent', 'unavailable'),
    toolCall(2, 'call-parent-ask', 'ask_user_question', askUserQuestionArgs('Parent question?', ['Yes', 'No'])),
    endSeed(3, true),
    // Child-owned work.
    turnStart(4, 1),
    toolCall(5, 'call-child-ask', 'ask_user_question', askUserQuestionArgs('Child question?', ['Left', 'Right'])),
    turnEnd(6, 1),
  ]
}
