/**
 * Opt-in model-assisted prose extraction seam (PLAN-remediation §12.4).
 *
 * The capture engine owns *when* extraction runs: only on the live path, only
 * after the `proseCandidates` setting gate, only for a prose **raise** (never a
 * closure) and with that raise's own turn text. The extractor owns the model
 * call; capture only applies the verdict:
 * - `undefined` ⇒ keep the gate's draft unchanged;
 * - `keep:false` ⇒ drop it (never queued, never sinked);
 * - otherwise ⇒ emit a refined clone overriding only `kind`/`title`.
 * Structural and todo drafts are never extracted, the backfill never extracts,
 * and a throwing extractor is contained so it cannot break the live path.
 *
 * @module tests/capture/extraction.spec
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CaptureEvent, DerivedItemDraft, ProseExtractionInput, ProseExtractionVerdict } from '../../src/host/capture-contract'
import { createCaptureDriver, registerOpenItemsCapture, type LiveSessionLike } from '../../src/host/capture'
import { PROSE_EXTRACTION_SYSTEM_PROMPT } from '../../src/host/extraction'
import { FakeCaptureContext, FakeSink, sessionInfo } from './fakes'
import {
  T0,
  approvalAsked,
  assistantMessage,
  todoWrite,
  turnEnd,
  turnStart,
  userPrompt,
} from './fixtures'

const NOW = T0 + 5 * 24 * 60 * 60 * 1000
const SESSION = sessionInfo('session-root', { updatedAt: NOW })

/** A final assistant message that passes the strict prose gate. */
const QUESTION_TEXT = 'I reviewed the migration plan and the storage schema matches the diff. '
  + 'Do you want me to run the full verification ladder now?'

/** The gate's marker sentence for {@link QUESTION_TEXT}. */
const GATE_QUOTE = 'Do you want me to run the full verification ladder now?'

/** A short ask section with two decision items (one per-item raise each). */
const TWO_ITEM_TEXT = [
  '## Decisions I need from you',
  '',
  '- **A** — Choose (a) keep the current guard or (b) replace it?',
  '- **B** — Should the route refuse archived rows too?',
].join('\n')

/** One complete two-ask section turn. */
function sectionTurn(): CaptureEvent[] {
  return [turnStart(0, 1), assistantMessage(1, 1, TWO_ITEM_TEXT), turnEnd(2, 1)]
}

/** One complete prose turn: turn start, final assistant text, turn end. */
function proseTurn(): CaptureEvent[] {
  return [turnStart(0, 1), assistantMessage(1, 1, QUESTION_TEXT), turnEnd(2, 1)]
}

/** A real `Session`-shaped record (facts in `header`), as `session/event` passes it. */
function liveSession(): LiveSessionLike {
  return { id: 'session-live', inheritedEventCount: 0, header: { id: 'session-live', createdAt: T0 } }
}

/** The prose drafts among a list. */
function proseDrafts(drafts: readonly DerivedItemDraft[]): readonly DerivedItemDraft[] {
  return drafts.filter(draft => draft.artifactId.startsWith('prose:'))
}

describe('extraction verdict application', () => {
  it('drops the prose candidate on keep:false and sends the gate evidence', async () => {
    const inputs: ProseExtractionInput[] = []
    const sink = new FakeSink()
    const driver = createCaptureDriver({
      sink,
      source: 'projection',
      now: () => NOW,
      extraction: async (input) => {
        inputs.push(input)
        return { keep: false }
      },
    })
    const drafts = await driver.driveSession(SESSION, proseTurn())
    expect(drafts).toEqual([])
    expect(sink.drafts).toEqual([])
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({
      sessionId: 'session-root',
      quote: GATE_QUOTE,
      title: GATE_QUOTE,
    })
    // The text is the fold's final-assistant-text tail, not a re-read of the log.
    expect(inputs[0]?.text).toContain(GATE_QUOTE)
    expect(inputs[0]?.text).toContain('I reviewed the migration plan')
  })

  it('emits a refined clone overriding only kind and title on a keep verdict', async () => {
    const events = proseTurn()
    const plain = await createCaptureDriver({ sink: new FakeSink(), source: 'projection', now: () => NOW })
      .driveSession(SESSION, events)
    const baseline = plain[0]
    expect(baseline).toBeDefined()
    if (baseline === undefined) return

    const sink = new FakeSink()
    const driver = createCaptureDriver({
      sink,
      source: 'projection',
      now: () => NOW,
      extraction: async (): Promise<ProseExtractionVerdict> => ({
        keep: true,
        kind: 'decision',
        title: '  Refined decision title  ',
      }),
    })
    const drafts = await driver.driveSession(SESSION, events)
    expect(drafts).toHaveLength(1)
    const refined = drafts[0]
    expect(refined).toBeDefined()
    if (refined === undefined) return
    expect(refined.kind).toBe('decision')
    expect(refined.title).toBe('Refined decision title')
    // Everything but the two overridden fields is the gate's draft, unchanged.
    expect({ ...refined, kind: baseline.kind, title: baseline.title }).toEqual(baseline)
    expect(sink.opens).toEqual([refined])
  })

  it('keeps the gate draft unchanged on an undefined verdict', async () => {
    const events = proseTurn()
    const plain = await createCaptureDriver({ sink: new FakeSink(), source: 'projection', now: () => NOW })
      .driveSession(SESSION, events)
    const sink = new FakeSink()
    const driver = createCaptureDriver({
      sink,
      source: 'projection',
      now: () => NOW,
      extraction: async () => undefined,
    })
    const drafts = await driver.driveSession(SESSION, events)
    expect(drafts).toEqual(plain)
    expect(sink.opens).toEqual(plain)
  })

  it('treats a malformed verdict as undefined (keep the gate draft)', async () => {
    const sink = new FakeSink()
    const driver = createCaptureDriver({
      sink,
      source: 'projection',
      now: () => NOW,
      // The extractor is typed, but capture must stay total on a bad runtime value.
      extraction: async () => ({ keep: 'yes', kind: 'nope', title: 42 }) as never,
    })
    const drafts = await driver.driveSession(SESSION, proseTurn())
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.kind).toBe('question')
    expect(drafts[0]?.title).toBe(GATE_QUOTE)
    expect(sink.opens).toHaveLength(1)
  })

  it('contains a throwing extractor and keeps the gate candidate', async () => {
    const errors: unknown[] = []
    const sink = new FakeSink()
    const driver = createCaptureDriver({
      sink,
      source: 'projection',
      now: () => NOW,
      onError: error => { errors.push(error) },
      extraction: async () => { throw new Error('extraction model offline') },
    })
    const drafts = await driver.driveSession(SESSION, proseTurn())
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.kind).toBe('question')
    expect(errors).toHaveLength(1)
    expect(sink.opens).toHaveLength(1)
  })

  it('never extracts structural drafts, only the prose candidate in the same drive', async () => {
    const inputs: ProseExtractionInput[] = []
    const driver = createCaptureDriver({
      sink: new FakeSink(),
      source: 'projection',
      now: () => NOW,
      extraction: async (input) => {
        inputs.push(input)
        return { keep: false }
      },
    })
    // Turn 1 raises a structural approval (so the prose gate rule-3 suppression
    // does not apply to turn 2); turn 2 raises the prose candidate.
    const drafts = await driver.driveSession(SESSION, [
      turnStart(0, 1),
      approvalAsked(1, 'approval-1', 'bash', 'call-1', 'run the suite'),
      turnEnd(2, 1),
      turnStart(3, 2),
      assistantMessage(4, 2, QUESTION_TEXT),
      turnEnd(5, 2),
    ])
    expect(inputs).toHaveLength(1)
    expect(drafts.map(draft => draft.artifactId)).toEqual(['approval:call-1'])
    expect(drafts[0]?.tier).toBe('structural')
  })

  it('calls extraction once per prose raise, never once per turn', async () => {
    const inputs: ProseExtractionInput[] = []
    const driver = createCaptureDriver({
      sink: new FakeSink(),
      source: 'projection',
      now: () => NOW,
      extraction: async (input) => {
        inputs.push(input)
        return { keep: true, title: `Refined: ${input.title}` }
      },
    })
    const drafts = await driver.driveSession(SESSION, sectionTurn())
    expect(inputs).toHaveLength(2)
    expect(new Set(inputs.map(input => input.title)).size).toBe(2)
    expect(proseDrafts(drafts)).toHaveLength(2)
    expect(proseDrafts(drafts).every(draft => draft.title.startsWith('Refined: '))).toBe(true)
    expect(drafts.every(draft => draft.closes === undefined)).toBe(true)
  })

  it('never extracts a prose closure (a closure is lifecycle, not a judgement)', async () => {
    const inputs: ProseExtractionInput[] = []
    const driver = createCaptureDriver({
      sink: new FakeSink(),
      source: 'projection',
      now: () => NOW,
      extraction: async (input) => {
        inputs.push(input)
        return { keep: false }
      },
    })
    const raised = await driver.driveSession(SESSION, proseTurn())
    expect(raised).toEqual([])
    expect(inputs).toHaveLength(1)
    const closed = await driver.driveSession(SESSION, [userPrompt(3, 'Yes, run it.')])
    expect(closed).toHaveLength(1)
    expect(closed[0]?.closes?.kind).toBe('detected-closed')
    // The extractor was not consulted for the closure.
    expect(inputs).toHaveLength(1)
  })

  it('sends a raise its own turn text when one batch spans two turns', async () => {
    const inputs: ProseExtractionInput[] = []
    const driver = createCaptureDriver({
      sink: new FakeSink(),
      source: 'projection',
      now: () => NOW,
      extraction: async (input) => {
        inputs.push(input)
        return undefined
      },
    })
    const secondText = 'The register row looks consistent and the schema matches. '
      + 'Should I also update the changelog before shipping?'
    await driver.driveSession(SESSION, [
      ...proseTurn(),
      turnStart(3, 2),
      assistantMessage(4, 2, secondText),
      turnEnd(5, 2),
    ])
    expect(inputs).toHaveLength(2)
    expect(inputs[0]?.text).toContain('verification ladder')
    expect(inputs[1]?.text).toContain('update the changelog')
  })

  it('fixes the prompt kind rules (semantic decision/question, no "ends with a question")', () => {
    expect(PROSE_EXTRACTION_SYSTEM_PROMPT).not.toMatch(/ends with a question/iu)
    expect(PROSE_EXTRACTION_SYSTEM_PROMPT).toMatch(/choose among alternatives/iu)
    expect(PROSE_EXTRACTION_SYSTEM_PROMPT).toMatch(/needs an answer/iu)
    expect(PROSE_EXTRACTION_SYSTEM_PROMPT).toMatch(/never emit "approval"/iu)
    // Still one strict JSON object with the phase-1 kind vocabulary.
    expect(PROSE_EXTRACTION_SYSTEM_PROMPT).toContain('"question"|"decision"')
  })

  it('leaves the todo aggregate untouched in the same turn as the prose candidate', async () => {
    const inputs: ProseExtractionInput[] = []
    const sink = new FakeSink()
    const driver = createCaptureDriver({
      sink,
      source: 'projection',
      now: () => NOW,
      extraction: async (input) => {
        inputs.push(input)
        return { keep: true, title: 'Refined prose title' }
      },
    })
    const drafts = await driver.driveSession(SESSION, [
      turnStart(0, 1),
      assistantMessage(1, 1, QUESTION_TEXT),
      todoWrite(2, [{ content: 'Wire the rescan interval', status: 'pending' }]),
      turnEnd(3, 1),
    ])
    expect(inputs).toHaveLength(1)
    expect(proseDrafts(drafts)).toHaveLength(1)
    expect(proseDrafts(drafts)[0]?.title).toBe('Refined prose title')
    const todo = drafts.find(draft => draft.artifactId === 'todo-open')
    expect(todo).toBeDefined()
    expect(todo?.tier).toBe('candidate')
    expect(todo?.title).toBe('Plan left unfinished (1 items)')
    expect(todo?.detectorCode).toBe('todo/write:unfinished-plan')
    expect(sink.opens.map(draft => draft.artifactId).sort()).toEqual(
      drafts.map(draft => draft.artifactId).sort(),
    )
  })
})

describe('extraction wiring', () => {
  const disposers: (() => void)[] = []
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose()
  })

  it('passes the extraction seam to the live driver', async () => {
    const ctx = new Context()
    const sink = new FakeSink()
    const calls: ProseExtractionInput[] = []
    const capture = registerOpenItemsCapture(ctx, {
      sink,
      context: new FakeCaptureContext({ sessions: [] }),
      now: () => NOW,
      autoBackfill: false,
      extraction: async (input) => {
        calls.push(input)
        return { keep: true, title: 'Wired refined title' }
      },
    })
    disposers.push(() => { void capture.dispose() })
    for (const event of proseTurn()) ctx.emit('session/event', liveSession() as never, event as never)
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1)
      expect(sink.opens[0]?.title).toBe('Wired refined title')
    })
  })

  it('does not extract on the backfill path (historical candidates stay gate-only)', async () => {
    const ctx = new Context()
    const sink = new FakeSink()
    const calls: ProseExtractionInput[] = []
    const context = new FakeCaptureContext({ sessions: [sessionInfo('s1', { updatedAt: NOW })] })
      .withEvents('s1', proseTurn())
    const capture = registerOpenItemsCapture(ctx, {
      sink,
      context,
      now: () => NOW,
      extraction: async (input) => {
        calls.push(input)
        return { keep: false }
      },
    })
    disposers.push(() => { void capture.dispose() })
    await vi.waitFor(() => {
      expect(proseDrafts(sink.opens)).toHaveLength(1)
    })
    expect(calls).toEqual([])
    // The gate's own title survived: extraction never ran.
    expect(proseDrafts(sink.opens)[0]?.title).toBe(GATE_QUOTE)
  })
})
