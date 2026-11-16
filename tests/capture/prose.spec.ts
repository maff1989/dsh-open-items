/**
 * Prose candidate gate (PLAN-remediation §4, D1/D2; prose-audit remediation §1).
 *
 * Two layers are pinned here:
 * - the pure gate (`proseGateOf`): the additive section mode on the real
 *   incident-shaped final message (five labelled asks A–E), the anchored
 *   trailing-heading accept/reject table, the shipped prose fallback (recall
 *   parity, semantic kinds, the "confirm guard" false positive), markdown
 *   projection, full-width `？` and the per-item identity rules;
 * - the turn lifecycle through the aggregate fold: one candidate per ask at
 *   `turn/end`, batch-aware session bound, closure on continuation, rule-3
 *   structural suppression, replay idempotence, cold-baseline survival,
 *   mid-turn finalization and the settings gate (raises only, closures pass).
 *
 * @module tests/capture/prose.spec
 */

import { describe, expect, it } from 'vitest'

import type { CaptureEvent, CaptureSessionInfo, DerivedItemDraft } from '../../src/host/capture-contract'
import { createCaptureDriver } from '../../src/host/capture'
import {
  finalizeOpenItems,
  foldOpenItemsEvent,
  initialLedgerState,
  readLedgerState,
  type LedgerState,
} from '../../src/host/folds'
import {
  PROSE_CAP_CODE,
  PROSE_DETECTED_BY,
  PROSE_DETECTOR_CODE,
  PROSE_LIMITS,
  PROSE_SUPERSEDED_CODE,
  proseArtifactId,
  proseGateOf,
  type ProseAsk,
} from '../../src/host/folds/prose'
import { foldSession } from '../../src/host/projection'
import { FakeSink, sessionInfo } from './fakes'
import { T0, approvalAsked, assistantMessage, turnEnd, turnStart, userPrompt } from './fixtures'

const SESSION: CaptureSessionInfo = {
  sessionId: 'session-root',
  title: 'Root session',
  updatedAt: T0,
  archived: false,
}

/**
 * The verbatim final assistant message of the incident turn (real log, seq 368):
 * a plan whose last heading is `## Decisions I need from you`, followed by the
 * five labelled asks A–E. This is the message that shipped one `question`
 * candidate (E) and silently lost four decisions.
 */
const INCIDENT_TEXT: string = "## W2 — Dismiss is refused while the answer is in flight (`awaiting`)\n\nToday `store.dismiss` allows `awaiting → resolved` ([store.ts:804](dsh-open-items/src/host/store.ts#L804)); the message is already in the session log, and dismissing then overwrites a pending acknowledgement with `{state: 'none'}` — the fold drops late evidence (`service.ts:424-432`) and the register lies forever. DESIGN.md §7.4.2's table already says dismissed ⇒ acknowledgement `n/a`; this enforces it.\n\n**Changes**\n\n1. `src/host/store.ts` `dismiss`: reject `current.state === 'awaiting'` with `InvalidTransitionError` (route maps it to `conflict` — copy already exists: \"that action is not allowed while the item is awaiting\"). Update the doc comment to `open/stale/snoozed → resolved`. Re-check the archive-sweep invariant: resolved rows with `retention.class: 'archived'` still rejected by the `resolved` guard. (`archived` state: see Decision C.)\n2. `src/host/tools.ts` `dismissItem`: pre-check `existing.state === 'awaiting'` → `refusalValue('dismiss', 'already-answered', deps)` — reuses the existing refusal reason and copy; no new `OpenItemsRefusal` member.\n3. Docs:\n   - `DESIGN.md` §7.4.2 — amend the dismissed/superseded row: \"at the user action — **only from `open`/`snoozed`**; an `awaiting` item must be acknowledged, swept by the acknowledgement window, or reopened before it can be dismissed\"; one sentence on why (the answer is already in the session log and cannot be un-sent).\n   - `route.ts:321` comment (`open → resolved` is already approximate) → `open/stale/snoozed → resolved; awaiting refused`.\n   - `README.md` dismiss mention (check for \"awaiting\" adjacency when editing) and `CHANGELOG.md` entry.\n4. Surfaces that *offer* dismiss need no logic change (inbox page never lists `awaiting`; register detail offers Reopen; card Dismiss dead-ends earlier), but:\n   - Inbox page dismiss toast already surfaces errors from the route — a lost race (item answered elsewhere between render and click) now yields \"that action is not allowed while the item is open/awaiting\" instead of silently clobbering the pending ack. That's the desired UX; no code change.\n   - Optional (Decision D): when dismissing from the detail footer is refused with non-CAS transition, show \"already answered elsewhere; refresh\" instead of the raw message.\n5. Tests:\n   - `tests/store.spec.ts`: dismiss on `awaiting` throws `InvalidTransitionError`; dismiss on `snoozed` still ok; answer → ack → resolved flow unaffected; reopen from awaiting → dismiss now allowed (regression guard for the intended escape hatch).\n   - `tests/tools.spec.ts`: `dismiss` on an awaiting item → refusal value `already-answered` (not an exception); on open item → succeeds.\n   - `tests/route.spec.ts`: dismiss on awaiting → `conflict`; on resolved → still `conflict`; CAS mismatch unchanged.\n   - Migration/projection/suppress paths untouched.\n\n## W3 — Sweep comments & guards that contradict the rule\n\n- `src/client/derive/inbox-view.ts:10` stale comment \"Needs you = open, stale or awaiting\" → \"open|stale only; awaiting has the in-flight band\" (drive-by, separate commit).\n- Verify no other `LIVE_STATES`-adjacent path can write a dismissal onto an `awaiting` record: `suppress` (candidates only, rejects non-live), `deleteForever` (resolved/tombstone only — confirm guard), `answer` (rejects `awaiting`) — all already correct.\n- `CHANGELOG.md`: two entries under the next rc2 heading.\n\n## Sequencing\n\nW1 and W2 are independent; both are small. Suggested order: W2 (host semantics; ~1 h incl. tests) → W1 (card client; ~1–2 h) → W3 → full `vitest` + `tsc`. Each workstream its own commit.\n\n## Decisions I need from you\n\n- **A** — Card dismiss receipt: (a) reuse `settled:{outcome:'applied', dismissed:true}` (smallest diff), or (b) introduce a `kind:'dismissed'` settlement variant in `ItemUi` for precise typing. I recommend (a).\n- **B** — Add an Undo (reopen) action to the card's dismissed receipt, or leave Undo to the page's Toast only? I recommend leaving it out.\n- **C** — Should `dismiss` also be refused for `state: 'archived'` (open item archived by the live-cap sweep, never resolved)? I lean to also refusing (archive is terminal; reopen-then-decide is the honest path) but it's beyond the reported inconsistency — your call.\n- **D** — W2 item 4: worth the friendlier refusal copy, or accept the raw route message?\n- **E** — Ship together as one PR/branch or two (host semantics vs card client)?"

/** A long final message that ends on a direct question (shipped fallback). */
const QUESTION_TEXT = 'I reviewed the migration plan and the storage schema matches the diff. '
  + 'Do you want me to run the full verification ladder now?'

/** A long final message that names a decision without a question mark. */
const DECISION_TEXT = 'The storage migration is finished and the projection checkpoint is current. '
  + 'Let me know whether the release note should mention the new settings page.'

/** The marker sentence the fallback must quote from {@link QUESTION_TEXT}. */
const QUESTION_QUOTE = 'Do you want me to run the full verification ladder now?'

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

/** One turn's final assistant message plus its `turn/end` (no `turn/start`). */
function turn(seq: number, turnNumber: number, text: string): CaptureEvent[] {
  return [assistantMessage(seq, turnNumber, text), turnEnd(seq + 1, turnNumber)]
}

/** Every open (raising) draft the fold produced. */
function opens(drafts: readonly DerivedItemDraft[]): readonly DerivedItemDraft[] {
  return drafts.filter(draft => draft.closes === undefined)
}

/** The prose raises among a fold's output. */
function proseOpens(drafts: readonly DerivedItemDraft[]): readonly DerivedItemDraft[] {
  return opens(drafts).filter(draft => draft.artifactId.startsWith('prose:'))
}

/** The prose closures among a fold's output. */
function proseCloses(drafts: readonly DerivedItemDraft[]): readonly DerivedItemDraft[] {
  return drafts.filter(draft => draft.closes?.artifactId.startsWith('prose:') === true)
}

/** Ids of the artifacts the fold currently holds open. */
function openProseIds(state: LedgerState): readonly string[] {
  return Object.keys(state.items).filter(artifactId => artifactId.startsWith('prose:')).sort()
}

describe('proseGateOf: section mode on the incident-shaped message', () => {
  it('emits the five labelled asks, all decision, with clean per-item evidence', () => {
    const gate = proseGateOf(INCIDENT_TEXT, 2)
    expect(gate.pass).toBe(true)
    expect(gate.mode).toBe('section')
    expect(gate.truncated).toBe(0)
    expect(gate.asks).toHaveLength(5)
    expect(gate.asks.map(ask => ask.label)).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(gate.asks.map(ask => ask.kind)).toEqual(['decision', 'decision', 'decision', 'decision', 'decision'])
    expect(gate.identitySeed).toMatch(/^[0-9a-f]{16}$/u)
    for (const ask of gate.asks) {
      expect(ask.quote.length).toBeGreaterThan(0)
      expect(ask.quote.length).toBeLessThanOrEqual(PROSE_LIMITS.quoteChars)
      expect(ask.title.length).toBeGreaterThan(0)
      expect(ask.title.length).toBeLessThanOrEqual(120)
      expect(ask.title.startsWith(`${ask.label} — `)).toBe(true)
      // Markdown projection: no bold markers, backticks or list markers survive.
      expect(ask.quote).not.toContain('**')
      expect(ask.quote).not.toContain('`')
      expect(ask.quote.startsWith('- ')).toBe(false)
      expect(ask.title).not.toContain('**')
      expect(ask.title).not.toContain('`')
    }
    // The title summarises the first sentence; the quote is the verbatim item.
    const before = gate.asks[0]
    expect(before?.title).toContain('Card dismiss receipt:')
    expect(before?.quote.startsWith('Card dismiss receipt:')).toBe(true)
    expect(before?.quote).toContain('reuse')
  })

  it('gives every ask a distinct, deterministic, turn-scoped identity', () => {
    const gate = proseGateOf(INCIDENT_TEXT, 2)
    const ids = gate.asks.map(ask => proseArtifactId(2, ask, 0))
    expect(new Set(ids).size).toBe(5)
    expect(ids.every(id => /^prose:t2:[0-9a-f]{12}$/u.test(id))).toBe(true)
    // Replaying the same text yields the same ids; a later turn re-asking the
    // same items is a new set of candidates (the turn is part of the identity).
    const again = proseGateOf(INCIDENT_TEXT, 2)
    expect(again.asks.map(ask => proseArtifactId(2, ask, 0))).toEqual(ids)
    const nextTurn = proseGateOf(INCIDENT_TEXT, 3)
    expect(nextTurn.asks.map(ask => proseArtifactId(3, ask, 0))).not.toEqual(ids)
  })

  it('does not re-id unrelated items when one item is edited', () => {
    const gate = proseGateOf(INCIDENT_TEXT, 2)
    const edited = INCIDENT_TEXT.replace(
      'W2 item 4: worth the friendlier refusal copy, or accept the raw route message?',
      'W2 item 4: rewrite the refusal copy, or leave the raw route message?',
    )
    const changed = proseGateOf(edited, 2)
    const before = gate.asks.map(ask => proseArtifactId(2, ask, 0))
    const after = changed.asks.map(ask => proseArtifactId(2, ask, 0))
    expect(after).toHaveLength(5)
    // Only the edited item's identity moves.
    expect(after.filter((id, index) => id !== before[index])).toHaveLength(1)
  })

  it('attaches verbatim options only where the author wrote labelled alternatives', () => {
    const gate = proseGateOf(INCIDENT_TEXT, 2)
    const options = gate.asks.map(ask => ask.options)
    // A offers "(a) … or (b) …"; the other four present no labelled options.
    expect(options[0]).toEqual([
      "(a) reuse settled:{outcome:'applied', dismissed:true} (smallest diff)",
      "(b) introduce a kind:'dismissed' settlement variant in ItemUi for precise typing.",
    ])
    expect(options.slice(1).every(entry => entry === undefined)).toBe(true)
  })

  it('truncates to the per-turn bound and counts the rest', () => {
    const bullets = Array.from({ length: 7 }, (_, index) => `- **${String.fromCharCode(65 + index)}** — Choose option (a) keep it or (b) drop it?`)
    const text = ['## Decisions I need from you', '', ...bullets].join('\n')
    const gate = proseGateOf(text, 4)
    expect(gate.mode).toBe('section')
    expect(gate.asks).toHaveLength(PROSE_LIMITS.maxItemsPerTurn)
    expect(gate.truncated).toBe(2)
  })

  it('emits a single-item section as one ask', () => {
    const text = ['## Decisions I need from you', '', '- **A** — Ship it together or split it into two PRs?'].join('\n')
    const gate = proseGateOf(text, 1)
    expect(gate.mode).toBe('section')
    expect(gate.asks).toHaveLength(1)
    expect(gate.asks[0]?.label).toBe('A')
    expect(gate.asks[0]?.kind).toBe('decision')
  })

  it('drops non-ask bullets from an ask section', () => {
    const text = [
      '## Decisions I need from you',
      '',
      '- **Deliberately not done:** remove the in-session card.',
      '- **A** — Ship the card fix together or split it into two PRs?',
    ].join('\n')
    const gate = proseGateOf(text, 1)
    expect(gate.mode).toBe('section')
    expect(gate.asks.map(ask => ask.label)).toEqual(['A'])
  })
})

describe('proseGateOf: anchored trailing ask heading', () => {
  const accepted: readonly { readonly name: string; readonly text: string }[] = [
    { name: 'decisions', text: '## Decisions I need from you\n\n- **A** — Ship it as one PR or two?' },
    { name: 'open questions', text: '## Open questions\n\n- What should the release title be?' },
    { name: 'your call', text: '## Your call\n\n- Keep the note short or expand it into a section?' },
    { name: 'numbered questions', text: '### 2. Questions\n\n- Which guard should the route keep?' },
    { name: 'sign-off', text: '## Sign-off\n\n- Approve the plan as written?' },
  ]

  for (const entry of accepted) {
    it(`accepts a trailing "${entry.name}" section`, () => {
      const gate = proseGateOf(entry.text, 1)
      expect(gate.mode).toBe('section')
      expect(gate.asks.length).toBeGreaterThan(0)
    })
  }

  it('rejects a heading that merely contains "decision" (advice, not a request)', () => {
    const text = [
      '### 10. A decision framework for choosing your cadence',
      '',
      '- Blast radius of a bad change? High — keep PRs small.',
      '- Serialize the risky step or keep it batched?',
    ].join('\n')
    const gate = proseGateOf(text, 1)
    expect(gate.mode).not.toBe('section')
    // The advice block is not parsed as a multi-item section; only the shipped
    // tail fallback may fire (it ends on a '?'), with a projected single quote.
    expect(gate.mode).toBe('prose')
    expect(gate.asks).toHaveLength(1)
    expect(gate.asks[0]?.quote.startsWith('- ')).toBe(false)
    expect(gate.asks[0]?.quote).toBe('Serialize the risky step or keep it batched?')
  })

  it('rejects a heading that recounts an earlier decision', () => {
    const text = [
      '### From the tag/version decision (2026-11-14)',
      '',
      '- Promote the row before shipping.',
      '- Keep the register readable.',
    ].join('\n')
    expect(proseGateOf(text, 1).mode).not.toBe('section')
  })

  it('rejects an ask heading superseded by a later heading', () => {
    const text = [
      '## Decisions I need from you',
      '',
      '- **A** — Ship it as one PR or two?',
      '',
      '## Next steps',
      '',
      '1. Run the ladder.',
    ].join('\n')
    expect(proseGateOf(text, 1).mode).not.toBe('section')
  })
})

describe('proseGateOf: prose fallback (shipped recall)', () => {
  it('keeps the shipped single-question pass and quote', () => {
    const gate = proseGateOf(QUESTION_TEXT, 1)
    expect(gate.pass).toBe(true)
    expect(gate.mode).toBe('prose')
    expect(gate.asks).toHaveLength(1)
    expect(gate.asks[0]?.kind).toBe('question')
    expect(gate.asks[0]?.quote).toBe(QUESTION_QUOTE)
    expect(gate.asks[0]?.label).toBeUndefined()
    expect(gate.identitySeed).toMatch(/^[0-9a-f]{16}$/u)
  })

  it('keeps the shipped decision-marker pass with a semantic decision kind', () => {
    const gate = proseGateOf(DECISION_TEXT, 1)
    expect(gate.mode).toBe('prose')
    expect(gate.asks[0]?.kind).toBe('decision')
    expect(gate.asks[0]?.quote).toContain('Let me know whether the release note')
  })

  it('quotes the real turn-1 permission ask as a question ("Want me to implement (1) + (2)?")', () => {
    const text = 'Two cracks: the card calls reply with a dismiss, and the store allows a dismissal while awaiting. '
      + 'Want me to implement (1) + (2)? I\'d treat the card bug as the first fix since it is user-visible.'
    const gate = proseGateOf(text, 1)
    expect(gate.mode).toBe('prose')
    expect(gate.asks[0]?.kind).toBe('question')
    expect(gate.asks[0]?.quote).toBe('Want me to implement (1) + (2)?')
  })

  it('treats full-width `？` as a question mark', () => {
    const text = 'I checked the migration plan and the schema matches the diff exactly. '
      + 'この設計で進めてよいですか？'
    const gate = proseGateOf(text, 1)
    expect(gate.mode).toBe('prose')
    expect(gate.asks[0]?.kind).toBe('question')
  })

  it('does not fire for the "confirm guard" noun phrase (G12)', () => {
    const text = 'The migration is done and the schema matches the diff. '
      + 'Nothing is pending: the confirm guard and the approval check are already in place.'
    expect(proseGateOf(text, 1).pass).toBe(false)
  })

  it('still fires for an imperative confirm request', () => {
    const text = 'The migration is done and the schema matches the diff. '
      + 'Confirm the release plan before the deployment window closes.'
    const gate = proseGateOf(text, 1)
    expect(gate.pass).toBe(true)
    expect(gate.asks[0]?.quote).toBe('Confirm the release plan before the deployment window closes.')
  })

  it('keeps the shipped minimum length, tail window and fence exclusions', () => {
    expect(proseGateOf('Ship it?', 1).pass).toBe(false)
    expect(proseGateOf(`Do you want me to ship it? ${'a'.repeat(320)}`, 1).pass).toBe(false)
    expect(proseGateOf(`\`\`\`text\n${QUESTION_TEXT}\n\`\`\``, 1).pass).toBe(false)
    expect(proseGateOf(`I reviewed the patch. \`\`\`\n${QUESTION_TEXT}\n\`\`\``, 1).pass).toBe(false)
    expect(proseGateOf('   \n\t ', 1)).toEqual({ pass: false, mode: 'none', asks: [], truncated: 0, identitySeed: '' })
  })
})

describe('prose candidate lifecycle', () => {
  it('raises one candidate per ask at turn end', () => {
    const { state, drafts } = run(turn(0, 2, INCIDENT_TEXT))
    const raised = proseOpens(drafts)
    expect(raised).toHaveLength(5)
    expect(new Set(raised.map(draft => draft.artifactId)).size).toBe(5)
    for (const draft of raised) {
      expect(draft.tier).toBe('candidate')
      expect(draft.detectedBy).toEqual(PROSE_DETECTED_BY)
      expect(draft.kind).toBe('decision')
      expect(draft.severity).toBe(2)
      expect(draft.blocking).toBe(false)
      expect(draft.detectorCode).toBe(PROSE_DETECTOR_CODE)
      expect(draft.turn).toBe(2)
      expect(draft.seq).toBe(0)
      expect(draft.reply?.requiresConfirm).toBe(true)
      expect(draft.reply?.freeText).toBe(true)
    }
    // The body names the item's place in the turn.
    expect(raised.map(draft => draft.body)).toEqual([
      'Decision 1 of 5 from the turn that ended; confirm to turn it into an item.',
      'Decision 2 of 5 from the turn that ended; confirm to turn it into an item.',
      'Decision 3 of 5 from the turn that ended; confirm to turn it into an item.',
      'Decision 4 of 5 from the turn that ended; confirm to turn it into an item.',
      'Decision 5 of 5 from the turn that ended; confirm to turn it into an item.',
    ])
    // Only the item with real options gets option controls.
    const withOptions = raised.filter(draft => draft.reply?.controls?.includes('option') === true)
    expect(withOptions).toHaveLength(1)
    expect(withOptions[0]?.reply?.options).toHaveLength(2)
    expect(raised.filter(draft => draft.reply?.controls?.includes('option') !== true))
      .toHaveLength(4)
    expect(openProseIds(state)).toHaveLength(5)
  })

  it('closes every item of the turn when the user continues', () => {
    const { state, drafts } = run([...turn(0, 1, INCIDENT_TEXT), userPrompt(2, 'Option (a), and keep Undo on the page.')])
    expect(proseOpens(drafts)).toHaveLength(5)
    const closes = proseCloses(drafts)
    expect(closes).toHaveLength(5)
    expect(closes.every(draft => draft.closes?.kind === 'detected-closed')).toBe(true)
    expect(closes.every(draft => draft.closes?.code === PROSE_SUPERSEDED_CODE)).toBe(true)
    expect(closes.every(draft => draft.closes?.at === T0 + 2 * 1000)).toBe(true)
    expect(openProseIds(state)).toEqual([])
  })

  it('closes every item of the turn when a later turn starts', () => {
    const { state, drafts } = run([...turn(0, 1, INCIDENT_TEXT), turnStart(2, 2)])
    expect(proseCloses(drafts)).toHaveLength(5)
    expect(openProseIds(state)).toEqual([])
  })

  it('does not fire when the turn already raised a blocking structural item (rule 3)', () => {
    const { state, drafts } = run([
      turnStart(0, 1),
      approvalAsked(1, 'approval-1', 'bash', 'call-1', 'run the suite'),
      assistantMessage(2, 1, INCIDENT_TEXT),
      turnEnd(3, 1),
    ])
    expect(proseOpens(drafts)).toEqual([])
    expect(drafts.filter(draft => draft.closes === undefined).map(draft => draft.artifactId))
      .toEqual(['approval:call-1'])
    expect(openProseIds(state)).toEqual([])
  })

  it('keeps at most maxOpenProse open per session without ever dropping a batch member', () => {
    const { state, drafts } = run([
      ...turn(0, 1, INCIDENT_TEXT),
      ...turn(2, 2, INCIDENT_TEXT),
      ...turn(4, 3, INCIDENT_TEXT),
    ])
    const raised = proseOpens(drafts)
    expect(raised).toHaveLength(15)
    const caps = drafts.filter(draft => draft.closes?.code === PROSE_CAP_CODE)
    // 5 + 5 + 5 opened; the bound is 8, so 7 of the older candidates are closed.
    expect(caps).toHaveLength(7)
    const open = openProseIds(state)
    expect(open).toHaveLength(PROSE_LIMITS.maxOpenProse)
    // The newest batch survives wholesale: a batch never supersedes itself.
    const turn3 = raised.filter(draft => draft.turn === 3).map(draft => draft.artifactId)
    expect(turn3).toHaveLength(5)
    expect(open).toEqual(expect.arrayContaining(turn3))
    // No cap closure ever targets the batch that triggered it.
    expect(caps.map(draft => draft.closes?.artifactId)).not.toEqual(expect.arrayContaining(turn3))
    // The oldest item opened first is gone.
    expect(open).not.toContain(raised[0]?.artifactId)
  })

  it('does not re-raise the same turn on a fold replay', () => {
    const events = turn(0, 1, INCIDENT_TEXT)
    const first = run(events)
    expect(proseOpens(first.drafts)).toHaveLength(5)
    // Replay the identical events over the already-folded ledger: per-item ids
    // make the re-raise a no-op (the store must not bump version/history).
    let state = first.state
    const replay: DerivedItemDraft[] = []
    for (const event of events) {
      const step = foldOpenItemsEvent(state, event, SESSION, 'log-fold')
      state = step.state
      replay.push(...step.drafts)
    }
    expect(proseOpens(replay)).toEqual([])
    expect(openProseIds(state)).toEqual(openProseIds(first.state))
  })

  it('ignores malformed assistant messages without throwing', () => {
    const malformed: CaptureEvent = { seq: 0, type: 'assistant/message', time: T0, data: { message: null } }
    const { state, drafts } = run([malformed, turnEnd(1, 1)])
    expect(drafts).toEqual([])
    expect(state.prose.lastText).toBeNull()
  })

  it('keeps only the final visible text: reasoning and tool-only turns never fire', () => {
    const { drafts } = run(byToolCallOnly())
    expect(proseOpens(drafts)).toEqual([])
  })

  it('round-trips the raw newline tail and every item through a JSON checkpoint', () => {
    const { state } = run(turn(0, 2, INCIDENT_TEXT))
    // The projection cache stores plain JSON; a restart must restore both the
    // gate's structure (newlines) and the per-item identities.
    const restored = readLedgerState(JSON.parse(JSON.stringify(state)) as never)
    const text = restored.prose.lastText?.text ?? ''
    expect(text).toContain('\n')
    expect(text).toContain('## Decisions I need from you')
    expect(text.length).toBeLessThanOrEqual(PROSE_LIMITS.textChars)
    expect(Object.keys(restored.items).sort()).toEqual(Object.keys(state.items).sort())
    const artifact = Object.values(restored.items)[0]
    expect(artifact?.tier).toBe('candidate')
    expect(artifact?.detectedBy).toEqual(PROSE_DETECTED_BY)
    expect(artifact?.turn).toBe(2)
  })

  it('survives a cold baseline: every still-open ask is emitted with its evidence', () => {
    const folded = foldSession(turn(0, 2, INCIDENT_TEXT), {
      session: SESSION,
      source: 'log-fold',
      mode: 'baseline',
    })
    const raised = proseOpens(folded.drafts)
    expect(raised).toHaveLength(5)
    expect(raised.every(draft => draft.tier === 'candidate')).toBe(true)
    expect(raised.every(draft => draft.detectedBy?.[0] === 'regex-gate')).toBe(true)
    expect(raised.every(draft => draft.turn === 2)).toBe(true)
  })

  it('raises the asks of a log that ends inside a turn (finalizeProse)', () => {
    const state = [
      turnStart(0, 2),
      assistantMessage(1, 2, INCIDENT_TEXT),
    ].reduce((previous, event) => foldOpenItemsEvent(previous, event, SESSION, 'log-fold').state, initialLedgerState(0))
    expect(state.currentTurn).toBe(2)
    const finalized = finalizeOpenItems(state, SESSION, 'log-fold', T0 + 9000)
    const raised = proseOpens(finalized.drafts)
    expect(raised).toHaveLength(5)
    expect(raised.every(draft => draft.turn === 2)).toBe(true)
    expect(openProseIds(finalized.state)).toHaveLength(5)
    // A completed turn is never re-raised by the finalizer.
    const completed = run(turn(0, 1, INCIDENT_TEXT))
    const again = finalizeOpenItems(completed.state, SESSION, 'log-fold', T0 + 9000)
    expect(proseOpens(again.drafts)).toEqual([])
  })

  it('emits all five asks from a cold baseline of a log that ends mid-turn', () => {
    const folded = foldSession([
      turnStart(0, 2),
      assistantMessage(1, 2, INCIDENT_TEXT),
    ], { session: SESSION, source: 'log-fold', mode: 'baseline' })
    expect(proseOpens(folded.drafts)).toHaveLength(5)
  })
})

/** A turn whose final assistant message is a tool call only (with reasoning prose). */
function byToolCallOnly(): CaptureEvent[] {
  const question = 'Do you want me to run the full verification ladder now?'
  return [
    turnStart(0, 1),
    assistantMessage(1, 1, question),
    assistantMessage(2, 1, '', { toolCall: { id: 'call-1', name: 'bash' }, reasoning: question }),
    turnEnd(3, 1),
  ]
}

describe('prose settings gate', () => {
  it('emits five prose candidates from the driver by default', async () => {
    const sink = new FakeSink()
    const driver = createCaptureDriver({ sink, source: 'projection', now: () => T0 })
    const drafts = await driver.driveSession(sessionInfo('session-root', { updatedAt: T0 }), turn(0, 2, INCIDENT_TEXT))
    expect(proseOpens(drafts)).toHaveLength(5)
    expect(sink.opens.filter(draft => draft.artifactId.startsWith('prose:'))).toHaveLength(5)
  })

  it('suppresses raises when proseCandidates is off', async () => {
    const sink = new FakeSink()
    const driver = createCaptureDriver({
      sink,
      source: 'projection',
      now: () => T0,
      settings: () => ({ proseCandidates: false }),
    })
    const drafts = await driver.driveSession(sessionInfo('session-root', { updatedAt: T0 }), turn(0, 2, INCIDENT_TEXT))
    expect(drafts).toEqual([])
    expect(sink.drafts).toEqual([])
  })

  it('still emits closures when proseCandidates is off (the setting gates raises only)', async () => {
    const sink = new FakeSink()
    const session = sessionInfo('session-root', { updatedAt: T0 })
    let proseOn = true
    const driver = createCaptureDriver({
      sink,
      source: 'projection',
      now: () => T0,
      settings: () => ({ proseCandidates: proseOn }),
    })
    const raised = await driver.driveSession(session, turn(0, 2, INCIDENT_TEXT))
    expect(proseOpens(raised)).toHaveLength(5)
    proseOn = false
    const closed = await driver.driveSession(session, [userPrompt(2, 'Go ahead with (a).')])
    expect(proseOpens(closed)).toEqual([])
    expect(proseCloses(closed)).toHaveLength(5)
    expect(proseCloses(closed).every(draft => draft.closes?.code === PROSE_SUPERSEDED_CODE)).toBe(true)
  })

  it('treats a throwing settings reader as the default (on)', async () => {
    const driver = createCaptureDriver({
      sink: new FakeSink(),
      source: 'projection',
      now: () => T0,
      onError: () => undefined,
      settings: () => { throw new Error('settings unavailable') },
    })
    const drafts = await driver.driveSession(sessionInfo('session-root', { updatedAt: T0 }), turn(0, 2, INCIDENT_TEXT))
    expect(proseOpens(drafts)).toHaveLength(5)
  })
})

describe('proseAsk helpers', () => {
  it('proseArtifactId disambiguates identical items inside one turn', () => {
    const ask: ProseAsk = { kind: 'question', quote: 'Same ask?', title: 'Same ask?' }
    expect(proseArtifactId(2, ask, 0)).toMatch(/^prose:t2:[0-9a-f]{12}$/u)
    expect(proseArtifactId(2, ask, 1)).toBe(`${proseArtifactId(2, ask, 0)}~2`)
    expect(proseArtifactId(2, ask, 2)).toBe(`${proseArtifactId(2, ask, 0)}~3`)
    // The label is part of the item identity: A and B with the same body differ.
    expect(proseArtifactId(2, { ...ask, label: 'A' }, 0)).not.toBe(proseArtifactId(2, { ...ask, label: 'B' }, 0))
  })
})
