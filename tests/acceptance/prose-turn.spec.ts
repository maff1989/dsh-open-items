/**
 * Acceptance check for the additive prose gate: one incident-shaped turn yields
 * N per-item candidates, all evidence-bearing.
 *
 * This is the hermetic acceptance counterpart to the real-corpus run
 * (`real-corpus.spec.ts`, gated by `OI_ACCEPTANCE=1`). It folds one synthetic
 * root session whose final assistant message ends with the trailing-ask section
 * shape from the reported incident (a heading plus five labelled decision
 * bullets), through the same probed capture adapter the real-corpus harness uses
 * — so it exercises the shipped fold, not a private helper.
 *
 * Contract: `research/prose-audit/IMPLEMENTATION-CONTRACT.md` §1.3, §4, §6.3.
 * It asserts the *contract shape* (counts of this fixture, per-item ids, clean
 * evidence, candidate guarantees) — never the measured corpus totals, which
 * belong to `VERIFY.md` §10.
 *
 * @module tests/acceptance/prose-turn
 */
import { describe, expect, it } from 'vitest'

import type { CaptureEvent, DerivedItemDraft } from '../../src/host/capture-contract'
import {
  loadCaptureAdapter,
  type CaptureAdapter,
  type CorpusSession,
  type SessionLogHeader,
} from './corpus'

/** Fixed base time so the fixture is deterministic. */
const T0 = 1_760_000_000_000

/** The number of asks in the incident-shaped turn (A–E). */
const EXPECTED_ASKS = 5

/** The turn the asks belong to (the incident's turn 2). */
const TURN = 2

/** One committed-event fixture. */
function ev(seq: number, type: string, data: unknown): CaptureEvent {
  return { seq, type, time: T0 + seq * 1_000, data }
}

/** One `assistant/message` with the real payload shape. */
function assistantMessage(seq: number, turn: number, text: string): CaptureEvent {
  return ev(seq, 'assistant/message', {
    turn,
    step: 1,
    message: {
      id: `assistant-${seq}`,
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
      content: [{ type: 'text', text }],
    },
    stream: [],
  })
}

/**
 * The incident-shaped final message: a report body ending in a trailing ask
 * section with five labelled items (the real session's A–E shape).
 */
const INCIDENT_TEXT = [
  'I reviewed the card dismissal path end to end and the storage route matches the diff.',
  '',
  'The receipt write is already idempotent, and the archive transition is covered by the existing tests.',
  '',
  'The only open questions are about how much surface to add in this pass.',
  '',
  '## Decisions I need from you',
  '',
  '- **A** — Card dismiss receipt: (a) reuse the settled record, or (b) introduce a kind: \'dismissed\' row. I recommend (a).',
  '  - nested detail belongs to A and must never become its own item',
  '- **B** — Add an Undo (reopen) action for dismissed items? I recommend leaving it out.',
  '- **C** — Should dismiss also be refused for archived items, or accept it? — your call.',
  '- **D** — W2 item 4: worth the friendlier refusal copy, or accept the raw route message?',
  '- **E** — Ship together as one PR/branch or two (host semantics vs card client)?',
  '',
].join('\n')

/** One synthetic root session holding the incident-shaped turn. */
function incidentSession(): CorpusSession {
  const events: readonly CaptureEvent[] = [
    ev(0, 'turn/start', { turn: 1 }),
    assistantMessage(1, 1, 'Turn one installed the scaffold. **Done** — nothing to decide.'),
    ev(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev(3, 'user/message', {
      id: 'user-3',
      role: 'user',
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }),
    ev(4, 'turn/start', { turn: TURN }),
    assistantMessage(5, TURN, INCIDENT_TEXT),
    ev(6, 'turn/end', { turn: TURN, reason: { kind: 'completed' } }),
  ]
  const header: SessionLogHeader = {
    type: 'session',
    version: 4,
    id: 'session-incident',
    createdAt: T0,
    cwd: '/tmp/project',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }
  return {
    filePath: '/tmp/session-incident/session.v4.jsonl.zstd',
    header,
    events,
    inheritedEventCount: 0,
    updatedAt: events[events.length - 1]!.time,
    info: {
      sessionId: header.id,
      title: 'Incident-shaped turn',
      updatedAt: events[events.length - 1]!.time,
      archived: false,
      inheritedEventCount: 0,
    },
  }
}

/** Fold one session through the probed adapter and return the prose drafts. */
async function proseDraftsOf(adapter: CaptureAdapter): Promise<readonly DerivedItemDraft[]> {
  const drafts = await adapter.foldSession(incidentSession())
  return drafts.filter(draft => draft.artifactId.startsWith('prose:'))
}

describe('incident-shaped turn — additive per-item prose acceptance', () => {
  it('yields N evidence-bearing candidate items from one multi-decision turn', async (testContext) => {
    const probe = await loadCaptureAdapter()
    if (probe.adapter === undefined) {
      // Same graceful path as the real-corpus suite: the capture interface is
      // probed, so an absent module is a recorded skip, not a false pass.
      console.warn(`prose-turn acceptance skipped: ${probe.reason ?? 'capture adapter absent'}`)
      testContext.skip()
      return
    }

    const drafts = await proseDraftsOf(probe.adapter)
    expect(drafts).toHaveLength(EXPECTED_ASKS)

    const ids = drafts.map(draft => draft.artifactId)
    expect(new Set(ids).size).toBe(EXPECTED_ASKS)
    for (const id of ids) {
      // Per-item identity: stable per turn/item, not a message-level fingerprint.
      expect(id).toMatch(/^prose:t2:[0-9a-f]{12}(?:~\d+)?$/u)
    }

    for (const draft of drafts) {
      // Candidate-tier guarantees are unchanged by the additive gate.
      expect(draft.tier).toBe('candidate')
      expect(draft.severity).toBe(2)
      expect(draft.blocking).toBe(false)
      expect(draft.detectedBy).toContain('regex-gate')
      expect(draft.detectorCode).toBe('prose-gate:decision-request')
      expect(draft.sessionId).toBe('session-incident')
      // Semantic kind: every A–E item names alternatives / is decisions-heading
      // scoped, so all five are decisions (the incident's mis-kinding is gone).
      expect(draft.kind).toBe('decision')
      expect(draft.seq).toBeDefined()
      expect(draft.turn).toBe(TURN)

      // Evidence-bearing: a verbatim, bounded, markdown-clean quote + title.
      const quote = draft.quote ?? ''
      expect(quote).not.toBe('')
      expect(quote.length).toBeLessThanOrEqual(300)
      expect(draft.title.length).toBeGreaterThan(0)
      expect(draft.title.length).toBeLessThanOrEqual(120)
      for (const text of [draft.title, quote, draft.body]) {
        expect(text).not.toContain('**')
        expect(text).not.toContain('`')
        expect(text).not.toContain('](#')
        expect(text.trimStart().startsWith('- ')).toBe(false)
      }
      expect(draft.body).toMatch(/^Decision [1-5] of 5 from the turn that ended/u)
    }

    // The labels make the items distinguishable, and the four labelled-
    // alternative asks render option controls without fabricating a yes/no.
    const labelled = drafts.filter(draft => /^[A-E] — /u.test(draft.title))
    expect(labelled).toHaveLength(EXPECTED_ASKS)
    const withOptions = drafts.filter(draft => (draft.reply?.options ?? []).length > 0)
    expect(withOptions.length).toBeGreaterThanOrEqual(1)
    for (const draft of withOptions) {
      expect(draft.reply?.controls).toContain('option')
      expect(draft.reply?.options!.length).toBeGreaterThanOrEqual(2)
      expect(draft.reply?.options!.length).toBeLessThanOrEqual(4)
      for (const option of draft.reply!.options!) {
        expect(option.trim()).not.toBe('')
        expect(option.length).toBeLessThanOrEqual(200)
      }
    }

    // Replay is idempotent: the same per-item identities, nothing new.
    const replay = await proseDraftsOf(probe.adapter)
    expect(replay.map(draft => draft.artifactId)).toEqual(ids)
  }, 60_000)
})
