/**
 * Fold behaviour over fixtures built from the harness's real event shapes.
 *
 * Each suite names the artifact, the event that raises it, and every closing
 * detector. The fold must be total (unknown/malformed events never throw) and
 * reference-stable for uninteresting events.
 *
 * @module tests/capture/folds.spec
 */

import { describe, expect, it } from 'vitest'

import type { CaptureEvent, CaptureSessionInfo, DerivedItemDraft } from '../../src/host/capture-contract'
import {
  foldOpenItemsEvent,
  initialLedgerState,
  normalizeFoldSession,
  type LedgerState,
  readLedgerState,
} from '../../src/host/folds'
import { finalizeOpenItems } from '../../src/host/folds'
import { foldSession, deriveInheritedEventCount } from '../../src/host/projection'
import { foldTeamTask } from '../../src/host/folds/team-task'
import {
  T0,
  approvalAsked,
  approvalDecided,
  askUserQuestionArgs,
  askUserQuestionAnswers,
  endSeed,
  foreignEvent,
  forkedSessionLog,
  goalClear,
  goalSnapshot,
  interruptedResult,
  jobRegistered,
  jobSettled,
  malformedToolCall,
  teamTask,
  toolCall,
  toolResult,
  turnEnd,
  turnStart,
} from './fixtures'

const SESSION: CaptureSessionInfo = {
  sessionId: 'session-root',
  title: 'Root session',
  updatedAt: T0,
  archived: false,
  cwd: '/work/project',
}

/** Fold a list of events and return the final state plus every draft. */
function run(events: readonly CaptureEvent[]): {
  state: LedgerState
  drafts: readonly DerivedItemDraft[]
} {
  let state = initialLedgerState(0)
  const drafts: DerivedItemDraft[] = []
  for (const event of events) {
    const step = foldOpenItemsEvent(state, event, SESSION, 'log-fold')
    state = step.state
    drafts.push(...step.drafts)
  }
  return { state, drafts }
}

describe('approval fold', () => {
  it('raises approval.blocked for a fail-closed outcome and closes it when the callId is retried and allowed', () => {
    const { state, drafts } = run([
      turnStart(0, 1),
      approvalAsked(1, 'approval-1', 'bash', 'call-1', 'run the test suite'),
      approvalDecided(2, 'approval-1', 'unavailable'),
      turnEnd(3, 1),
      // The model retries the same tool call; this ask is granted.
      turnStart(4, 2),
      approvalAsked(5, 'approval-2', 'bash', 'call-1', 'run the test suite'),
      approvalDecided(6, 'approval-2', 'allowed-once'),
      turnEnd(7, 2),
    ])
    // The pending ask raises at `approval/asked`; the blocked outcome replaces it.
    const open = drafts.find(draft => draft.closes === undefined && draft.detectorCode === 'approval/decided:unavailable')
    expect(open).toBeDefined()
    expect(open?.kind).toBe('approval')
    expect(open?.severity).toBe(1)
    expect(open?.blocking).toBe(true)
    expect(open?.callId).toBe('call-1')
    expect(open?.approvalId).toBe('approval-1')
    expect(open?.detectorCode).toBe('approval/decided:unavailable')
    expect(open?.sessionId).toBe('session-root')
    const close = drafts.find(draft => draft.closes?.artifactId === 'approval:call-1')
    expect(close?.closes?.kind).toBe('detected-closed')
    expect(close?.closes?.code).toBe('approval/decided:allowed-once')
    expect(close?.closes?.at).toBe(T0 + 6 * 1000)
    // The retry's own allowed pair leaves the ledger with no open artifact.
    expect(Object.keys(state.items)).toEqual([])
  })

  it('raises one artifact per non-grant outcome, keyed by approval id when no callId exists', () => {
    const { drafts } = run([
      approvalAsked(0, 'approval-1', 'write_file'),
      approvalDecided(1, 'approval-1', 'rejected'),
      approvalAsked(2, 'approval-2', 'write_file'),
      approvalDecided(3, 'approval-2', 'cancelled'),
    ])
    const decided = drafts.filter(draft => draft.closes === undefined && draft.detectorCode.startsWith('approval/decided'))
    expect(decided.map(draft => draft.artifactId)).toEqual(['approval:approval-1', 'approval:approval-2'])
    expect(decided.map(draft => draft.detectorCode)).toEqual([
      'approval/decided:rejected',
      'approval/decided:cancelled',
    ])
  })

  it('ignores a decided event whose asked event is missing and closes the pending ask of a grant', () => {
    const { state, drafts } = run([
      approvalDecided(0, 'orphan', 'unavailable'),
      approvalAsked(1, 'approval-9', 'bash'),
      approvalDecided(2, 'approval-9', 'allowed-once'),
    ])
    // The pending ask raises and the grant closes it; the orphan decided is ignored.
    expect(drafts.filter(draft => draft.closes === undefined).map(draft => draft.artifactId))
      .toEqual(['approval:approval-9'])
    expect(drafts.filter(draft => draft.closes !== undefined).map(draft => draft.closes?.artifactId))
      .toEqual(['approval:approval-9'])
    expect(Object.keys(state.items)).toEqual([])
  })
})

describe('question and plan-review fold', () => {
  it('raises question with the question text and options, then closes on the tool result', () => {
    const { state, drafts } = run([
      turnStart(0, 1),
      toolCall(1, 'call-ask', 'ask_user_question', askUserQuestionArgs('Ship it?', ['Yes (Recommended)', 'No'])),
      toolResult(2, 'call-ask', [{ type: 'text', text: JSON.stringify(askUserQuestionAnswers('q1', ['Yes (Recommended)'])) }]),
      turnEnd(3, 1),
    ])
    const open = drafts.find(draft => draft.artifactId === 'question:call-ask' && draft.closes === undefined)
    expect(open?.kind).toBe('question')
    expect(open?.severity).toBe(1)
    expect(open?.title).toBe('Ship it?')
    expect(open?.quote).toBe('Ship it?')
    expect(open?.reply?.options).toEqual(['Yes (Recommended)', 'No'])
    expect(open?.reply?.freeText).toBe(true)
    expect(drafts.find(draft => draft.closes?.artifactId === 'question:call-ask')?.closes?.code).toBe('tool/result')
    expect(Object.keys(state.items)).toEqual([])
  })

  it('raises plan-review for exit_plan_mode from the plan argument', () => {
    const { drafts } = run([
      turnStart(0, 1),
      toolCall(1, 'call-plan', 'exit_plan_mode', { plan: '# Plan\n\nDo the thing.' }),
    ])
    const open = drafts.find(draft => draft.closes === undefined)
    expect(open?.artifactId).toBe('question:call-plan')
    expect(open?.kind).toBe('plan-review')
    expect(open?.title).toContain('Plan awaiting review')
    expect(open?.body).toContain('# Plan')
    expect(open?.reply?.options).toEqual(['Approve plan', 'Keep planning'])
  })

  it('keeps an unanswered ask open when the log ends before its result', () => {
    const folded = foldSession(
      [turnStart(0, 1), toolCall(1, 'call-ask', 'ask_user_question', askUserQuestionArgs('Anyone there?', []))],
      { session: SESSION, source: 'log-fold' },
    )
    expect(folded.drafts.filter(draft => draft.closes === undefined).map(draft => draft.artifactId))
      .toEqual(['question:call-ask'])
    expect(folded.state.items['question:call-ask']?.blocking).toBe(true)
  })
})

describe('interrupted turn fold', () => {
  it('raises turn.interrupted for a synthetic TOOL_OUTCOME_UNKNOWN result and closes the ask it answers', () => {
    const { state, drafts } = run([
      turnStart(0, 1),
      toolCall(1, 'call-bash', 'bash', { command: 'rm -rf build' }),
      interruptedResult(2, 'call-bash'),
    ])
    const open = drafts.find(draft => draft.artifactId === 'interrupted:call-bash' && draft.closes === undefined)
    expect(open?.kind).toBe('blocker')
    expect(open?.severity).toBe(1)
    expect(open?.blocking).toBe(true)
    expect(open?.title).toBe('Unknown outcome: bash')
    expect(open?.quote).toContain('outcome is unknown')
    expect(open?.detectorCode).toBe('tool/result:TOOL_OUTCOME_UNKNOWN')
    expect(state.interrupted['call-bash']?.name).toBe('bash')
  })

  it('closes when the same tool is retried by name inside the same turn', () => {
    const { drafts } = run([
      turnStart(0, 1),
      toolCall(1, 'call-bash', 'bash', { command: 'npm test' }),
      interruptedResult(2, 'call-bash'),
      // A same-turn retry (the model retries after the unknown outcome).
      toolCall(3, 'call-bash-2', 'bash', { command: 'npm test' }),
    ])
    expect(drafts.find(draft => draft.closes?.artifactId === 'interrupted:call-bash')?.closes?.code)
      .toBe('tool/call:retried')
  })

  it('closes when a later turn starts', () => {
    const { state, drafts } = run([
      turnStart(0, 1),
      toolCall(1, 'call-bash', 'bash', { command: 'npm test' }),
      interruptedResult(2, 'call-bash'),
      turnEnd(3, 1, { kind: 'interrupted' }),
      turnStart(4, 2),
    ])
    expect(drafts.find(draft => draft.closes?.artifactId === 'interrupted:call-bash')?.closes?.code)
      .toBe('turn/start:superseded')
    expect(Object.keys(state.interrupted)).toEqual([])
  })

  it('does not treat TOOL_NOT_STARTED as an interrupted outcome', () => {
    const result = toolResult(2, 'call-x', [])
    const data = result.data as Record<string, unknown>
    data['error'] = { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' }
    const { drafts } = run([turnStart(0, 1), toolCall(1, 'call-x', 'bash', {}), result])
    expect(drafts.filter(draft => draft.closes === undefined)).toEqual([])
  })
})

describe('goal fold', () => {
  it('raises goal.blocked at severity 2 and closes on a later non-blocked mutation', () => {
    const { drafts } = run([
      goalSnapshot(0, 'create', {
        id: 'goal-1',
        revision: 1,
        objective: 'Migrate the storage layer',
        phase: 'active',
      }),
      goalSnapshot(1, 'block', {
        id: 'goal-1',
        revision: 2,
        objective: 'Migrate the storage layer',
        phase: 'blocked',
        blockedReason: { code: 'rounds', message: 'max rounds exhausted' },
      }),
      goalSnapshot(2, 'resume', {
        id: 'goal-1',
        revision: 3,
        objective: 'Migrate the storage layer',
        phase: 'active',
      }),
    ])
    const open = drafts.find(draft => draft.artifactId === 'goal:goal-1' && draft.closes === undefined)
    expect(open?.kind).toBe('blocker')
    expect(open?.severity).toBe(2)
    expect(open?.detectorCode).toBe('goal/change:blocked')
    expect(open?.body).toContain('max rounds exhausted')
    expect(drafts.find(draft => draft.closes?.artifactId === 'goal:goal-1')?.closes?.code).toBe('goal/change:active')
  })

  it('closes on complete and on a clear tombstone', () => {
    const base = [
      goalSnapshot(0, 'block', { id: 'goal-1', revision: 1, objective: 'Ship it', phase: 'blocked' }),
    ]
    const complete = run([
      ...base,
      goalSnapshot(1, 'complete', { id: 'goal-1', revision: 2, objective: 'Ship it', phase: 'complete' }),
    ])
    expect(complete.drafts.find(draft => draft.closes?.artifactId === 'goal:goal-1')?.closes?.code)
      .toBe('goal/change:complete')
    const cleared = run([...base, goalClear(1, 'goal-1')])
    expect(cleared.drafts.find(draft => draft.closes?.artifactId === 'goal:goal-1')?.closes?.code)
      .toBe('goal/change:clear')
  })
})

describe('team task fold (module retained, dispatch disabled by D5)', () => {
  /** Fold events through the retained module directly: the aggregate skips it. */
  function runTeamTask(events: readonly CaptureEvent[]): {
    state: LedgerState
    drafts: readonly DerivedItemDraft[]
  } {
    let state = initialLedgerState(0)
    const drafts: DerivedItemDraft[] = []
    for (const event of events) {
      const step = foldTeamTask(state, event, SESSION, 'log-fold')
      if (step === undefined) continue
      state = step.state
      drafts.push(...step.drafts)
    }
    return { state, drafts }
  }

  it('raises an orphan task for in_progress with an owning session and closes on completion', () => {
    const { drafts } = runTeamTask([
      teamTask(0, { id: 'task-1', status: 'in_progress', ownerId: 'session-child' }),
      teamTask(1, { id: 'task-1', revision: 2, status: 'completed', ownerId: 'session-child' }),
    ])
    const open = drafts.find(draft => draft.artifactId === 'team-task:task-1' && draft.closes === undefined) as
      | { taskId?: string; ownerSessionId?: string }
      | undefined
    expect(open?.taskId).toBe('task-1')
    expect(open?.ownerSessionId).toBe('session-child')
    expect(drafts.find(draft => draft.closes?.artifactId === 'team-task:task-1')?.closes?.code)
      .toBe('team/task:completed')
  })

  it('raises an unowned in-progress task without an owner id', () => {
    const { drafts } = runTeamTask([teamTask(0, { id: 'task-2', status: 'in_progress' })])
    const open = drafts.find(draft => draft.closes === undefined)
    expect(open?.artifactId).toBe('team-task:task-2')
    expect((open as { ownerSessionId?: string }).ownerSessionId).toBeUndefined()
  })

  it('ignores pending and deleted tasks', () => {
    const { drafts } = runTeamTask([
      teamTask(0, { id: 'task-3', status: 'pending', ownerId: 'session-child' }),
      teamTask(1, { id: 'task-4', status: 'deleted' }),
    ])
    expect(drafts).toEqual([])
  })

  it('is not dispatched by the aggregate fold, live or cold', () => {
    const events = [
      teamTask(0, { id: 'task-5', status: 'in_progress', ownerId: 'session-child' }),
      teamTask(1, { id: 'task-6', status: 'in_progress' }),
    ]
    expect(run(events).drafts).toEqual([])
    const cold = foldSession(events, { session: SESSION, source: 'log-fold', mode: 'baseline' })
    expect(cold.drafts).toEqual([])
  })
})

describe('background job fold', () => {
  it('raises only after the owning turn ends and closes on settlement', () => {
    const { state, drafts } = run([
      turnStart(0, 1),
      jobRegistered(1, 'job-1', 'npm test'),
      // Settles inside the turn: no item.
      jobSettled(2, 'job-1', 'npm test'),
      turnEnd(3, 1),
      turnStart(4, 2),
      jobRegistered(5, 'job-2', 'npm run build'),
      turnEnd(6, 2),
    ])
    const opens = drafts.filter(draft => draft.closes === undefined)
    expect(opens.map(draft => draft.artifactId)).toEqual(['job:job-2'])
    expect(opens[0]?.kind).toBe('follow-up')
    expect(opens[0]?.severity).toBe(3)
    expect(opens[0]?.detectorCode).toBe('job/registered:unsettled-after-turn')
    expect(state.items['job:job-2']?.jobId).toBe('job-2')
    const settled = run([
      turnStart(0, 1),
      jobRegistered(1, 'job-1', 'npm test'),
      turnEnd(2, 1),
      turnStart(3, 2),
      jobSettled(4, 'job-1', 'npm test'),
    ])
    expect(settled.drafts.find(draft => draft.closes?.artifactId === 'job:job-1')?.closes?.code).toBe('job/settled')
  })

  it('finalizes a crash tail that registered a job but never ended its turn', () => {
    const state = readLedgerState(initialLedgerState(0))
    const afterRegister = foldOpenItemsEvent(
      foldOpenItemsEvent(state, turnStart(0, 1), SESSION, 'log-fold').state,
      jobRegistered(1, 'job-9', 'sleep 300'),
      SESSION,
      'log-fold',
    ).state
    const finalized = finalizeOpenItems(afterRegister, SESSION, 'log-fold', T0 + 2000)
    expect(finalized.drafts.map(draft => draft.artifactId)).toEqual(['job:job-9'])
    expect(finalized.drafts[0]?.detectorCode).toBe('job/registered:unsettled-at-log-end')
  })
})

describe('session normalization', () => {
  it('reads the live Session.header shape for every durable fact', () => {
    const live = {
      id: 'session-live',
      inheritedEventCount: 1,
      header: {
        id: 'session-live',
        createdAt: T0,
        cwd: '/work/live',
        origin: 'subagent',
        delegationDepth: 1,
        parentSession: 'session-parent',
      },
    }
    expect(normalizeFoldSession(live)).toEqual({
      sessionId: 'session-live',
      updatedAt: T0,
      archived: false,
      cwd: '/work/live',
      origin: 'subagent',
      delegationDepth: 1,
      createdAt: T0,
      parentSession: 'session-parent',
    })
  })

  it('keeps the flat harness metadata shape working', () => {
    expect(normalizeFoldSession({
      sessionId: 'session-flat',
      updatedAt: 7,
      archived: true,
      delegationDepth: 2,
      cwd: '/work/flat',
      title: 'Flat',
    })).toEqual({
      sessionId: 'session-flat',
      updatedAt: 7,
      archived: true,
      cwd: '/work/flat',
      title: 'Flat',
      delegationDepth: 2,
    })
  })

  it('never throws on a malformed or empty record', () => {
    expect(normalizeFoldSession(undefined)).toEqual({ sessionId: '', updatedAt: 0, archived: false })
    expect(normalizeFoldSession(null)).toEqual({ sessionId: '', updatedAt: 0, archived: false })
    expect(normalizeFoldSession({ header: { id: 42, origin: 'other' } })).toEqual({
      sessionId: '',
      updatedAt: 0,
      archived: false,
    })
  })
})

describe('fold invariants', () => {
  it('never throws on foreign or malformed events and returns the same state reference', () => {
    const state = initialLedgerState(0)
    for (const event of [foreignEvent(0), malformedToolCall(1), { seq: 2, type: 'tool/result', time: T0, data: {} }]) {
      const step = foldOpenItemsEvent(state, event, SESSION, 'log-fold')
      expect(step.drafts).toEqual([])
      expect(step.state).toBe(state)
    }
  })

  it('skips every event before the inherited fork cut', () => {
    const events = forkedSessionLog()
    expect(deriveInheritedEventCount(events)).toBe(4)
    const folded = foldSession(events, { session: SESSION, source: 'log-fold' })
    const opens = folded.drafts.filter(draft => draft.closes === undefined).map(draft => draft.artifactId)
    expect(opens).toEqual(['question:call-child-ask'])
    expect(folded.state.inheritedEventCount).toBe(4)
    expect(folded.state.items['question:call-child-ask']?.seq).toBe(5)
  })

  it('is deterministic: the same log folds to the same state and drafts', () => {
    const events = forkedSessionLog()
    const first = foldSession(events, { session: SESSION, source: 'log-fold' })
    const second = foldSession(events, { session: SESSION, source: 'log-fold' })
    expect(JSON.stringify(first.state)).toBe(JSON.stringify(second.state))
    expect(first.drafts.map(draft => draft.artifactId)).toEqual(second.drafts.map(draft => draft.artifactId))
  })

  it('normalises a foreign persisted state instead of throwing', () => {
    const fromGarbage = readLedgerState({ inheritedEventCount: 'x', items: { bad: 1 }, calls: null })
    expect(fromGarbage.inheritedEventCount).toBe(0)
    expect(fromGarbage.items).toEqual({})
    expect(fromGarbage.calls).toEqual({})
  })

  it('does not re-raise an artifact that is already open (idempotent replay)', () => {
    const events: CaptureEvent[] = [
      approvalAsked(0, 'approval-1', 'bash', 'call-1'),
      approvalDecided(1, 'approval-1', 'unavailable'),
    ]
    const once = run(events)
    const twice = run([...events, ...events.map((event, index) => ({ ...event, seq: event.seq + 10, time: event.time + 10_000 }))])
    // The pending raise plus the blocked raise; the replayed batch raises only
    // the blocked row again because the artifact is already open.
    expect(once.drafts.filter(draft => draft.closes === undefined)).toHaveLength(2)
    expect(twice.drafts.filter(draft => draft.closes === undefined)).toHaveLength(3)
    expect(Object.keys(twice.state.items)).toEqual(['approval:call-1'])
  })
})

describe('approval closure on a same-tool retry', () => {
  it('closes a blocked approval when the retry gets a fresh callId', () => {
    const { state, drafts } = run([
      turnStart(0, 1),
      approvalAsked(1, 'approval-1', 'bash', 'call-1', 'run the test suite'),
      approvalDecided(2, 'approval-1', 'unavailable'),
      turnEnd(3, 1),
      // The model retries the same tool; the harness asks again under a new
      // approval id AND a new call id.
      turnStart(4, 2),
      approvalAsked(5, 'approval-2', 'bash', 'call-2', 'run the test suite'),
      approvalDecided(6, 'approval-2', 'allowed-once'),
      turnEnd(7, 2),
    ])
    const open = drafts.filter(draft => draft.closes === undefined)
    // The first ask's pending and blocked rows share the artifact id, then the
    // retry raises its own live pending ask.
    expect(open.map(draft => draft.artifactId))
      .toEqual(['approval:call-1', 'approval:call-1', 'approval:call-2'])
    const close = drafts.find(draft => draft.closes?.artifactId === 'approval:call-1')
    expect(close?.closes?.code).toBe('approval/decided:allowed-once')
    expect(close?.closes?.at).toBe(T0 + 6 * 1000)
    expect(Object.keys(state.items)).toEqual([])
    // No stale blocked marker survives the closure.
    expect(Object.keys(state.approvals)).toEqual([])
  })

  it('closes a blocked approval without any callId when the same tool is later granted', () => {
    const { state, drafts } = run([
      approvalAsked(0, 'approval-1', 'write_file', undefined, 'edit the config'),
      approvalDecided(1, 'approval-1', 'rejected'),
      approvalAsked(2, 'approval-2', 'write_file', undefined, 'edit the config'),
      approvalDecided(3, 'approval-2', 'allowed-once'),
    ])
    expect(drafts.filter(draft => draft.closes === undefined && draft.detectorCode.startsWith('approval/decided'))
      .map(draft => draft.artifactId)).toEqual(['approval:approval-1'])
    // The retry's pending ask is closed by its grant, as is the blocked item.
    expect(drafts.filter(draft => draft.closes !== undefined).map(draft => draft.closes?.artifactId))
      .toEqual(['approval:approval-1', 'approval:approval-2'])
    expect(Object.keys(state.items)).toEqual([])
    expect(Object.keys(state.approvals)).toEqual([])
  })

  it('never closes a blocked approval when a different tool is granted', () => {
    const { state, drafts } = run([
      approvalAsked(0, 'approval-1', 'bash', 'call-1', 'run the suite'),
      approvalDecided(1, 'approval-1', 'cancelled'),
      approvalAsked(2, 'approval-2', 'write_file', 'call-2', 'edit the config'),
      approvalDecided(3, 'approval-2', 'allowed-once'),
    ])
    // Only the unrelated retry's own pending ask is closed; the blocked row for
    // the other tool stays open.
    expect(drafts.filter(draft => draft.closes !== undefined).map(draft => draft.closes?.artifactId))
      .toEqual(['approval:call-2'])
    expect(Object.keys(state.items)).toEqual(['approval:call-1'])
    // The unrelated granted ask leaves the blocked marker for bash in place.
    expect(Object.keys(state.approvals)).toEqual(['approval-1'])
  })

  it('keeps one blocked item per retry that is itself blocked', () => {
    const { state, drafts } = run([
      approvalAsked(0, 'approval-1', 'bash', 'call-1', 'run the suite'),
      approvalDecided(1, 'approval-1', 'unavailable'),
      approvalAsked(2, 'approval-2', 'bash', 'call-2', 'run the suite'),
      approvalDecided(3, 'approval-2', 'rejected'),
    ])
    expect([...new Set(drafts.filter(draft => draft.closes === undefined).map(draft => draft.artifactId))])
      .toEqual(['approval:call-1', 'approval:call-2'])
    expect(Object.keys(state.items)).toEqual(['approval:call-1', 'approval:call-2'])
  })
})
