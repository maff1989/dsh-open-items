/**
 * `todo_write` abandonment fold (PLAN-remediation §5, decision D3).
 *
 * One aggregate candidate per session when a turn (or the log) ends with
 * unfinished plan items; closed by a later fully-completed write; never closed
 * by the user merely continuing the conversation. Cold-baseline emission is the
 * point: the abandoned plans are historical sessions.
 *
 * @module tests/capture/todo.spec
 */

import { describe, expect, it } from 'vitest'

import type { CaptureEvent, CaptureSessionInfo, DerivedItemDraft } from '../../src/host/capture-contract'
import { createCaptureDriver } from '../../src/host/capture'
import { finalizeOpenItems, foldOpenItemsEvent, initialLedgerState, readLedgerState, type LedgerState } from '../../src/host/folds'
import {
  TODO_ARTIFACT_ID,
  TODO_COMPLETED_CODE,
  TODO_DETECTOR_CODE,
  TODO_LIMITS,
  todoPlanOf,
} from '../../src/host/folds/todo'
import { foldSession } from '../../src/host/projection'
import { FakeSink, sessionInfo } from './fakes'
import { T0, assistantMessage, todoWrite, turnEnd, turnStart, userPrompt } from './fixtures'

const SESSION: CaptureSessionInfo = {
  sessionId: 'session-root',
  title: 'Root session',
  updatedAt: T0,
  archived: false,
}

/** Fold a list of events and return the final state plus every draft. */
function run(events: readonly CaptureEvent[]): { state: LedgerState; drafts: readonly DerivedItemDraft[] } {
  let state = initialLedgerState(0)
  const drafts: DerivedItemDraft[] = []
  for (const event of events) {
    const step = foldOpenItemsEvent(state, event, SESSION, 'log-fold')
    state = step.state
    drafts.push(...step.drafts)
  }
  return { state, drafts }
}

/** Two unfinished plan items as the real `todo/write` snapshot shape. */
function unfinishedPlan(seq = 1): CaptureEvent {
  return todoWrite(seq, [
    { content: 'Add the settings page', status: 'completed' },
    { content: 'Wire the rescan interval', status: 'in_progress' },
    { content: 'Update the CHANGELOG', status: 'pending' },
  ])
}

/** The same plan, all completed. */
function finishedPlan(seq: number): CaptureEvent {
  return todoWrite(seq, [
    { content: 'Add the settings page', status: 'completed' },
    { content: 'Wire the rescan interval', status: 'completed' },
    { content: 'Update the CHANGELOG', status: 'completed' },
  ])
}

describe('todoPlanOf', () => {
  it('counts pending and in_progress as unfinished and keeps only those labels', () => {
    expect(todoPlanOf(unfinishedPlan(0).data)).toEqual({
      pending: 2,
      items: ['Wire the rescan interval', 'Update the CHANGELOG'],
    })
  })

  it('bounds the labels and normalises whitespace', () => {
    const plan = todoPlanOf({
      todos: Array.from({ length: TODO_LIMITS.maxLabels + 2 }, (_value, index) => ({
        content: `  Step   ${index}  `,
        status: index === 0 ? 'completed' : 'pending',
      })),
    })
    expect(plan?.pending).toBe(TODO_LIMITS.maxLabels + 1)
    expect(plan?.items).toHaveLength(TODO_LIMITS.maxLabels)
    expect(plan?.items[0]).toBe('Step 1')
  })

  it('treats an empty list as a legitimate completed plan and a missing list as malformed', () => {
    expect(todoPlanOf({ todos: [] })).toEqual({ pending: 0, items: [] })
    expect(todoPlanOf({})).toBeUndefined()
    expect(todoPlanOf(undefined)).toBeUndefined()
  })
})

describe('abandoned-plan aggregate', () => {
  it('raises one candidate at turn end with candidate tier and FYI severity', () => {
    const { state, drafts } = run([
      turnStart(0, 1),
      unfinishedPlan(1),
      assistantMessage(2, 1, 'I finished the first step; the plan is still open.'),
      turnEnd(3, 1),
    ])
    const open = drafts.find(draft => draft.closes === undefined)
    expect(open?.artifactId).toBe(TODO_ARTIFACT_ID)
    expect(open?.kind).toBe('follow-up')
    expect(open?.tier).toBe('candidate')
    expect(open?.severity).toBe(3)
    expect(open?.blocking).toBe(false)
    expect(open?.detectorCode).toBe(TODO_DETECTOR_CODE)
    expect(open?.title).toBe('Plan left unfinished (2 items)')
    expect(open?.body).toContain('• Wire the rescan interval')
    expect(open?.body).toContain('• Update the CHANGELOG')
    expect(open?.body).toContain('The session ended with plan items not completed.')
    expect(open?.quote).toBe('Wire the rescan interval')
    expect(open?.seq).toBe(1)
    // The todo aggregate keeps the driver/provenance source, not the gate's.
    expect(open?.detectedBy).toEqual(['log-fold'])
    expect(state.items[TODO_ARTIFACT_ID]).toBeDefined()
  })

  it('does not raise before the turn ends and does not re-raise while open', () => {
    const { drafts } = run([
      turnStart(0, 1),
      unfinishedPlan(1),
      turnEnd(2, 1),
      turnStart(3, 2),
      unfinishedPlan(4),
      turnEnd(5, 2),
    ])
    expect(drafts.filter(draft => draft.closes === undefined)).toHaveLength(1)
  })

  it('closes on a later fully completed write with the completed detector', () => {
    const { state, drafts } = run([
      turnStart(0, 1),
      unfinishedPlan(1),
      turnEnd(2, 1),
      turnStart(3, 2),
      finishedPlan(4),
      turnEnd(5, 2),
    ])
    const close = drafts.find(draft => draft.closes?.artifactId === TODO_ARTIFACT_ID)
    expect(close?.closes?.kind).toBe('detected-closed')
    expect(close?.closes?.code).toBe(TODO_COMPLETED_CODE)
    expect(close?.closes?.at).toBe(T0 + 4 * 1000)
    expect(state.items[TODO_ARTIFACT_ID]).toBeUndefined()
  })

  it('does not close on a user message: plans legitimately continue', () => {
    const { state, drafts } = run([
      turnStart(0, 1),
      unfinishedPlan(1),
      turnEnd(2, 1),
      userPrompt(3, 'Continue with the next step.'),
    ])
    expect(drafts.filter(draft => draft.closes !== undefined)).toEqual([])
    expect(state.items[TODO_ARTIFACT_ID]).toBeDefined()
  })

  it('closes when a later write truncates the plan to an empty list', () => {
    const { drafts } = run([
      turnStart(0, 1),
      unfinishedPlan(1),
      turnEnd(2, 1),
      todoWrite(3, []),
    ])
    expect(drafts.find(draft => draft.closes?.artifactId === TODO_ARTIFACT_ID)?.closes?.code)
      .toBe(TODO_COMPLETED_CODE)
  })

  it('raises from finalize when the log ends mid-turn (crash tail)', () => {
    const afterPlan = run([
      turnStart(0, 1),
      unfinishedPlan(1),
    ])
    const finalized = finalizeOpenItems(afterPlan.state, SESSION, 'log-fold', T0 + 2000)
    expect(finalized.drafts.map(draft => draft.artifactId)).toEqual([TODO_ARTIFACT_ID])
    expect(finalized.drafts[0]?.detectorCode).toBe(TODO_DETECTOR_CODE)
  })

  it('round-trips the snapshot and the candidate tier through a JSON checkpoint', () => {
    const { state } = run([turnStart(0, 1), unfinishedPlan(1), turnEnd(2, 1)])
    const restored = readLedgerState(JSON.parse(JSON.stringify(state)) as never)
    expect(restored.todo?.pending).toBe(2)
    expect(restored.todo?.items).toEqual(['Wire the rescan interval', 'Update the CHANGELOG'])
    expect(restored.items[TODO_ARTIFACT_ID]?.tier).toBe('candidate')
  })

  it('survives a cold baseline: an unfinished historical plan is emitted', () => {
    const folded = foldSession([
      turnStart(0, 1),
      unfinishedPlan(1),
      turnEnd(2, 1),
    ], { session: SESSION, source: 'log-fold', mode: 'baseline' })
    const open = folded.drafts.filter(draft => draft.closes === undefined && draft.artifactId === TODO_ARTIFACT_ID)
    expect(open).toHaveLength(1)
    expect(open[0]?.tier).toBe('candidate')
    expect(open[0]?.severity).toBe(3)
  })

  it('emits from the live driver with the driver provenance and always regardless of prose settings', async () => {
    const sink = new FakeSink()
    const driver = createCaptureDriver({
      sink,
      source: 'projection',
      now: () => T0,
      settings: () => ({ proseCandidates: false }),
    })
    const drafts = await driver.driveSession(sessionInfo('session-root', { updatedAt: T0 }), [
      turnStart(0, 1),
      unfinishedPlan(1),
      turnEnd(2, 1),
    ])
    expect(drafts.map(draft => draft.artifactId)).toEqual([TODO_ARTIFACT_ID])
    expect(drafts[0]?.detectedBy).toEqual(['projection'])
    expect(drafts[0]?.tier).toBe('candidate')
  })

  it('ignores malformed todo payloads without throwing', () => {
    const malformed: CaptureEvent = { seq: 0, type: 'todo/write', time: T0, data: { todos: 'nope' } }
    const { state, drafts } = run([malformed, turnEnd(1, 1)])
    expect(drafts).toEqual([])
    expect(state.todo).toBeNull()
  })

  it('does not raise when only completed items remain', () => {
    const { drafts } = run([
      turnStart(0, 1),
      finishedPlan(1),
      turnEnd(2, 1),
    ])
    expect(drafts).toEqual([])
  })
})
