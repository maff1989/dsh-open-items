/**
 * Prose candidate gate: the turn-end detector for decisions and questions the
 * agent left in ordinary assistant text (PLAN-remediation §4, D1/D2; the
 * additive multi-item rework of research/prose-audit IMPLEMENTATION-CONTRACT §1).
 *
 * An artifact-only capture can never see "Want me to…?" / "Should I…?" in the
 * assistant's final message, which is the single largest class of real open
 * loops in this corpus. This fold reads the turn's final `assistant/message`
 * and at `turn/end` emits one **candidate** per ask it can prove is in that
 * message. A candidate is never "needs you": the user has to confirm it
 * (promote) or dismiss it (suppress), and the store already knows how to
 * suppress by fingerprint.
 *
 * Two additive detection modes:
 * 1. **Section** (precision-first, structure-aware): the message's last heading
 *    is an ask heading (`## Decisions I need from you`, `## Open questions`, …)
 *    and the top-level bullets under it are the items. Each item is projected
 *    to plain text, labelled (`A — …`), quoted verbatim and kinded by
 *    {@link classifyAsk}; explicit labelled alternatives become `options`.
 * 2. **Prose** (the shipped fallback, recall preserved): no trailing ask section,
 *    but the collapsed message is long enough and its final 300 characters end
 *    on `?`/`？` or carry one of the shipped decision markers. Exactly one ask is
 *    emitted from the marker sentence.
 *
 * Bounds: at most {@link PROSE_LIMITS.maxItemsPerTurn} asks per turn
 * ({@link ProseGateResult.truncated} counts the rest) and at most
 * {@link PROSE_LIMITS.maxOpenProse} open prose candidates per session. A batch
 * never supersedes itself: only candidates outside the current turn's batch are
 * closed with {@link PROSE_CAP_CODE}.
 *
 * Lifecycle: opened at `turn/end` (or, for a log that ends mid-turn, by
 * {@link finalizeProse}); closed when the user continues — a later
 * `user/message` (the contract's canonical code) or a later `turn/start`, both
 * `prose-gate` neutralised by {@link PROSE_SUPERSEDED_CODE}.
 *
 * Identity is per item: `prose:t<turn>:<sha256(quote + '\0' + label)[0..12]>`.
 * It is stable across fold replay, restarts and cold baselines, insensitive to
 * the message head and to unrelated item edits, and never depends on `kind`
 * (so a corrected kind does not fork the row).
 *
 * The artifact is **not** `liveOnly`: a cold baseline is exactly how the
 * historical silent decisions surface (§4 "Backfill: no special casing").
 *
 * @module dsh-open-items/host/folds/prose
 */

import { createHash } from 'node:crypto'

import type { CaptureEvent, CaptureRuntimeSettings, CaptureSessionInfo, DerivedItemDraft } from '../capture-contract'
import type { DetectionSource, ReplyDescriptor } from '../../shared/schema'
import { type FoldStep, closeDraft, openDraft } from './drafts'
import {
  OPEN_ITEMS_LIMITS,
  contentText,
  numberOf,
  recordOf,
  singleLine,
  tailBoundLines,
} from './limits'
import { turnOfEvent } from './interrupted'
import {
  classifyAsk,
  endsWithQuestion,
  extractOptions,
  findTrailingAskSection,
  firstSentence,
  isAskLike,
  listBlocks,
  markdownToText,
  sentencesOf,
  splitLabel,
  stripFencedBlocks,
  truncateWords,
  type ProseAskSection,
} from './prose-text'
import { type LedgerState, type OpenArtifact, putArtifact, removeArtifact } from './state'

/** Detector code stamped on every prose candidate. */
export const PROSE_DETECTOR_CODE = 'prose-gate:decision-request'

/** Closing detector: the user continued the conversation in a later turn. */
export const PROSE_SUPERSEDED_CODE = 'user/message:superseded'

/** Closing detector: the per-session open-candidate bound dropped the oldest request. */
export const PROSE_CAP_CODE = 'prose-gate:superseded-by-cap'

/** Detection provenance of the gate: this is a regex gate, not a log fold. */
export const PROSE_DETECTED_BY: readonly DetectionSource[] = ['regex-gate']

/** Prose gate bounds (contract §1.3: per-turn and per-session, not a global cap). */
export const PROSE_LIMITS = {
  /** Minimum collapsed message length for the fallback candidate. */
  minChars: 40,
  /** Marker window: only the final tail of the collapsed message is judged. */
  tailChars: 300,
  /** Bound of the raw newline-preserving text kept in fold state (line-bound). */
  textChars: 4000,
  /** Bound of the evidence quote and the item title source. */
  quoteChars: 300,
  /** Candidates raised from one turn; the rest are counted in `truncated`. */
  maxItemsPerTurn: 5,
  /** Open prose candidates allowed per session before the oldest is superseded. */
  maxOpenProse: 8,
} as const

/**
 * Decision phrases that mark a turn as ending on a request for the user.
 *
 * Kept verbatim from the shipped gate (contract §1.2 — the fallback must not
 * lose its recall): word-bounded, case-insensitive, and the bare `confirm`/
 * `approve` nouns are tightened in {@link fallbackPass} only, exactly where the
 * shipped gate produced a false positive ("the confirm guard is in place").
 */
const DECISION_MARKER = /\b(?:want me to|should i|shall i|would you like|do you want me to|let me know|your call|which (?:one|option|approach|of)|confirm|approve)\b/iu

/** A bare `confirm`/`approve` only counts as a request when it is imperative. */
const CONFIRM_IMPERATIVE = /^(?:please\s+)?(?:confirm|approve)\b/iu

/** `matchAll` needs its own global copy of the (non-global) shipped marker list. */
const DECISION_MARKER_GLOBAL = new RegExp(DECISION_MARKER.source, 'giu')

/** One ask the gate proved is in the final assistant message. */
export interface ProseAsk {
  /** Author's label (`A`, `1`, …) when the item carried one. */
  readonly label?: string
  /** Phase-1 kind: choose among presented alternatives, or needs an answer. */
  readonly kind: 'decision' | 'question'
  /** Markdown-clean verbatim item text (label stripped), ≤300 chars, word-bound. */
  readonly quote: string
  /** `"A — <first sentence>"` when labelled, first sentence otherwise; ≤120. */
  readonly title: string
  /** Verbatim alternatives the author presented, never fabricated `Yes`/`No`. */
  readonly options?: readonly string[]
}

/** The result of the pure prose gate. */
export interface ProseGateResult {
  /** Whether at least one ask was found. */
  readonly pass: boolean
  /** How the asks were found: an ask section, the prose fallback, or neither. */
  readonly mode: 'section' | 'prose' | 'none'
  /** The asks to raise (0..{@link PROSE_LIMITS.maxItemsPerTurn}). */
  readonly asks: readonly ProseAsk[]
  /** Asks found beyond the per-turn bound (counted, never invented). */
  readonly truncated: number
  /** Stable 16-hex seed of the canonical section/prose text (diagnostic identity). */
  readonly identitySeed: string
}

/** The gate's answer for text that does not qualify. */
const NO_GATE: ProseGateResult = { pass: false, mode: 'none', asks: [], truncated: 0, identitySeed: '' }

/** Whether one draft belongs to the prose gate (the capture wiring's settings gate). */
export function isProseDraft(draft: { readonly artifactId: string }): boolean {
  return draft.artifactId.startsWith('prose:')
}

/** Whether one draft raises (rather than closes) a prose candidate. */
export function isProseRaise(draft: { readonly artifactId: string; readonly closes?: unknown }): boolean {
  return isProseDraft(draft) && draft.closes === undefined
}

/** Whether one ledger artifact belongs to the prose gate. */
function isProseArtifact(artifact: OpenArtifact): boolean {
  return artifact.artifactId.startsWith('prose:')
}

/**
 * Read the prose-candidate setting, containing a throwing provider.
 *
 * The default is **on** (D1/D2): a profile that never wires the getter still
 * captures candidates, and a settings read failure must never suppress the
 * founding detector.
 * @param settings - optional Host-provided settings reader.
 * @returns true when prose candidates may be raised.
 */
export function proseCandidatesEnabled(settings?: () => CaptureRuntimeSettings): boolean {
  if (settings === undefined) return true
  try {
    return settings().proseCandidates !== false
  } catch {
    return true
  }
}

/**
 * Whether an emission should keep this draft under the current setting.
 *
 * The setting suppresses **raises only**: a closure always passes, or an open
 * candidate could never close once the user turns the check off (contract §1.4).
 * @param draft - draft the fold produced.
 * @param proseOn - current `proseCandidates` value.
 * @returns true when the draft may be emitted.
 */
export function proseEmittedUnderSetting(
  draft: { readonly artifactId: string; readonly closes?: unknown },
  proseOn: boolean,
): boolean {
  return proseOn || !isProseDraft(draft) || draft.closes !== undefined
}

/** Deterministic 16-hex identity of one canonical text. */
function hash16(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** Deterministic 12-hex per-item identity of one ask. */
function itemHash(ask: ProseAsk): string {
  return createHash('sha256').update(`${ask.quote}\u0000${ask.label ?? ''}`, 'utf8').digest('hex').slice(0, 12)
}

/**
 * Artifact identity for one ask of one turn.
 *
 * Includes the turn (a re-ask in a later turn is a new item) and the item text
 * plus its label (an unrelated item edit never re-ids its siblings); the `~2`,
 * `~3` suffix disambiguates identical items inside one turn.
 * @param turn - the turn that asked.
 * @param ask - the ask.
 * @param duplicateIndex - zero-based index among identical asks in this turn.
 * @returns `prose:t<turn>:<hash12>[~n]`.
 */
export function proseArtifactId(turn: number, ask: ProseAsk, duplicateIndex = 0): string {
  const suffix = duplicateIndex > 0 ? `~${duplicateIndex + 1}` : ''
  return `prose:t${Math.trunc(turn)}:${itemHash(ask)}${suffix}`
}

/** Title for one ask: the author's label kept, then the first sentence. */
function titleOf(label: string | undefined, text: string): string {
  const sentence = firstSentence(text)
  const base = label === undefined ? sentence : `${label} — ${sentence}`
  return truncateWords(base === '' ? 'Open item' : base, OPEN_ITEMS_LIMITS.titleChars)
}

/** The asks the top-level items of one ask section prove. */
function asksFromSection(section: ProseAskSection): readonly ProseAsk[] {
  const asks: ProseAsk[] = []
  for (const block of listBlocks(section.lines)) {
    const { label, body } = splitLabel(block.text)
    const cleaned = markdownToText(body)
    if (!isAskLike(cleaned, label !== undefined)) continue
    const quote = truncateWords(cleaned, PROSE_LIMITS.quoteChars)
    if (quote === '') continue
    const options = extractOptions(block.text)
    asks.push({
      ...label === undefined ? {} : { label },
      kind: classifyAsk(cleaned, section.heading),
      quote,
      title: titleOf(label, cleaned),
      ...options === undefined ? {} : { options },
    })
  }
  return asks
}

/** Whether one sentence carries a decision marker or a question mark. */
function isMarkerSentence(sentence: string): boolean {
  return sentence.includes('?') || sentence.includes('？') || DECISION_MARKER.test(sentence)
}

/** The marker-bearing sentence nearest the end of the collapsed message. */
function markerSentenceOf(normalized: string, fallback: string): string {
  const sentences = sentencesOf(normalized)
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const sentence = sentences[index]
    if (sentence !== undefined && isMarkerSentence(sentence)) return sentence
  }
  return singleLine(fallback)
}

/** The sentence of `text` that contains `index` (for the confirm/approve guard). */
function sentenceAt(text: string, index: number): string {
  const sentences = sentencesOf(text)
  let offset = 0
  for (const sentence of sentences) {
    const at = text.indexOf(sentence, offset)
    if (at === -1) continue
    if (index >= at && index <= at + sentence.length) return sentence
    offset = at + sentence.length
  }
  return ''
}

/**
 * The shipped fallback pass test, tightened for bare `confirm`/`approve` nouns.
 *
 * The marker list and the tail window are unchanged (contract §1.2: preserve
 * shipped recall). The one class the shipped gate wrongly accepted is a bare
 * `confirm`/`approve` noun in a declarative sentence ("the confirm guard and the
 * approval check are already in place"); it only counts when its own sentence is
 * a question or starts with the imperative verb.
 * @param tail - the last {@link PROSE_LIMITS.tailChars} characters.
 * @returns true when the tail is a request for the user.
 */
function fallbackPass(tail: string): boolean {
  const trimmed = tail.trimEnd()
  const last = trimmed.slice(-1)
  if (last === '?' || last === '？') return true
  for (const match of tail.matchAll(DECISION_MARKER_GLOBAL)) {
    const word = (match[0] ?? '').toLowerCase()
    if (word !== 'confirm' && word !== 'approve') return true
    const sentence = sentenceAt(tail, match.index ?? 0)
    if (endsWithQuestion(sentence) || CONFIRM_IMPERATIVE.test(sentence.trim())) return true
  }
  return false
}

/** The single fallback ask (the shipped behaviour, with a semantic kind). */
function asksFromProseTail(lines: readonly string[]): readonly ProseAsk[] {
  const normalized = singleLine(stripFencedBlocks(lines.join('\n')))
  if (normalized.length < PROSE_LIMITS.minChars) return []
  const tail = normalized.slice(-PROSE_LIMITS.tailChars)
  if (!fallbackPass(tail)) return []
  // Project the marker sentence to plain text: the stored quote/title must never
  // keep the raw block marker or emphasis the fallback matched inside.
  const sentence = markdownToText(markerSentenceOf(normalized, tail))
  const quote = truncateWords(sentence, PROSE_LIMITS.quoteChars)
  if (quote === '') return []
  const kind = classifyAsk(sentence, '')
  return [{ kind, quote, title: titleOf(undefined, sentence) }]
}

/** Canonical text of one ask section, used for the diagnostic identity seed. */
function canonicalSection(section: ProseAskSection): string {
  return `${section.heading}\n${section.lines.join('\n')}`.trim()
}

/**
 * Decide which asks the final assistant message carries.
 *
 * Pure and deterministic: the same text and turn always yield the same asks,
 * ids and quotes, which is what lets a candidate survive a fold replay and a
 * cold baseline without duplicating or re-raising.
 * @param rawText - the turn's final assistant `text` blocks, raw (newlines kept).
 * @param turn - the turn the message belongs to. The frozen gate signature keeps
 *   it so callers cannot forget which turn they are judging; the per-item
 *   identity takes it through {@link proseArtifactId}.
 * @returns the gate result; `mode:'none'` when nothing ask-like was found.
 */
export function proseGateOf(rawText: string, turn: number): ProseGateResult {
  const lines = stripFencedBlocks(rawText).replace(/\r\n?/gu, '\n').split('\n')
  const section = findTrailingAskSection(lines)
  if (section !== undefined) {
    const found = asksFromSection(section)
    if (found.length > 0) {
      const asks = found.slice(0, PROSE_LIMITS.maxItemsPerTurn)
      return {
        pass: true,
        mode: 'section',
        asks,
        truncated: Math.max(0, found.length - asks.length),
        identitySeed: hash16(canonicalSection(section)),
      }
    }
  }
  const asks = asksFromProseTail(lines)
  if (asks.length === 0) return NO_GATE
  return {
    pass: true,
    mode: 'prose',
    asks,
    truncated: 0,
    // The shipped single-ask identity: sha256 of the collapsed message.
    identitySeed: hash16(singleLine(lines.join('\n'))),
  }
}

/**
 * Record that a turn already raised a blocking structural item.
 *
 * Called by the aggregate fold after every handler ran; the prose handler of a
 * later `turn/end` reads it as gate rule 3.
 * @param state - ledger after the current event's handlers.
 * @param turn - the open turn whose fold raised the structural item.
 * @returns the state with the marker (same reference when already marked).
 */
export function markStructuralTurn(state: LedgerState, turn: number): LedgerState {
  if (state.prose.structuralTurn === turn) return state
  return { ...state, prose: { ...state.prose, structuralTurn: turn } }
}

/** Every still-open prose candidate, oldest first. */
function openProseArtifacts(state: LedgerState): readonly OpenArtifact[] {
  return Object.values(state.items)
    .filter(artifact => isProseArtifact(artifact))
    .sort((left, right) => left.seq - right.seq || left.artifactId.localeCompare(right.artifactId))
}

/** The reply descriptor of one candidate: option controls only with real options. */
function replyOf(ask: ProseAsk): ReplyDescriptor {
  const options = ask.options
  if (options === undefined) return { controls: ['text'], freeText: true, requiresConfirm: true }
  return { controls: ['option', 'text'], options, freeText: true, requiresConfirm: true }
}

/**
 * Raise one artifact per ask of the turn that just ended.
 *
 * Idempotent per item (an already-open artifact is skipped), bounded per turn
 * (the gate already sliced) and bounded per session (only candidates outside
 * this batch can be closed, oldest first, so a batch never supersedes itself).
 * @param state - ledger state.
 * @param text - the turn's raw final assistant text.
 * @param turn - the turn number.
 * @param seq - evidence seq of the final assistant message.
 * @param at - event time to stamp on the candidates.
 * @param session - owning session metadata.
 * @param source - detector source to stamp on closures.
 * @returns the next state and drafts, or undefined when nothing was raised.
 */
function raiseAsks(
  state: LedgerState,
  text: string,
  turn: number,
  seq: number,
  at: number,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  const gate = proseGateOf(text, turn)
  if (!gate.pass || gate.asks.length === 0) return undefined
  const total = gate.asks.length
  const duplicates = new Map<string, number>()
  const batch: OpenArtifact[] = []
  for (let position = 0; position < gate.asks.length; position += 1) {
    const ask = gate.asks[position]
    if (ask === undefined) continue
    const baseId = proseArtifactId(turn, ask, 0)
    const duplicateIndex = duplicates.get(baseId) ?? 0
    duplicates.set(baseId, duplicateIndex + 1)
    const artifactId = proseArtifactId(turn, ask, duplicateIndex)
    // Replay idempotence: an artifact already open must not re-raise (the store
    // would bump version/history for the same request).
    if (state.items[artifactId] !== undefined) continue
    const kindWord = ask.kind === 'decision' ? 'Decision' : 'Question'
    const artifact: OpenArtifact = {
      artifactId,
      kind: ask.kind,
      tier: 'candidate',
      severity: 2,
      seq,
      turn,
      title: ask.title,
      body: `${kindWord} ${position + 1} of ${total} from the turn that ended; confirm to turn it into an item.`,
      detectorCode: PROSE_DETECTOR_CODE,
      detectedBy: PROSE_DETECTED_BY,
      blocking: false,
      raisedAt: at,
      quote: ask.quote,
      reply: replyOf(ask),
    }
    batch.push(artifact)
  }
  if (batch.length === 0) return undefined
  let next = state
  const drafts: DerivedItemDraft[] = []
  for (const artifact of batch) {
    next = putArtifact(next, artifact)
    drafts.push(openDraft(artifact, { session, source }))
  }
  // Batch-aware session bound: close the oldest candidates *outside* this batch
  // until the session holds at most `maxOpenProse` open prose candidates.
  const batchIds = new Set(batch.map(artifact => artifact.artifactId))
  let overflow = openProseArtifacts(next).length - PROSE_LIMITS.maxOpenProse
  for (const artifact of openProseArtifacts(next)) {
    if (overflow <= 0) break
    if (batchIds.has(artifact.artifactId)) continue
    drafts.push(closeDraft(artifact, { session, source }, at, PROSE_CAP_CODE))
    next = removeArtifact(next, artifact.artifactId)
    overflow -= 1
  }
  return { state: next, drafts }
}

/**
 * Fold one event for the prose candidate family.
 * @param state - current ledger state.
 * @param event - next committed event.
 * @param session - owning session metadata.
 * @param source - detector source to stamp on drafts (the gate stamps its own).
 * @returns the next state and drafts, or undefined when the event is unrelated.
 */
export function foldProse(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  if (event.type === 'assistant/message') return onAssistantMessage(state, event)
  if (event.type === 'user/message') return closeSuperseded(state, event, session, source)
  if (event.type === 'turn/start') {
    // "or `turn/start` with a later turn": a valid turn number is the guard.
    return turnOfEvent(event.data) === undefined
      ? undefined
      : closeSuperseded(state, event, session, source)
  }
  if (event.type === 'turn/end') return onTurnEnd(state, event, session, source)
  return undefined
}

/** Keep the final assistant text of the open turn raw; drafts only at turn end. */
function onAssistantMessage(state: LedgerState, event: CaptureEvent): FoldStep | undefined {
  const record = recordOf(event.data)
  if (record === undefined) return undefined
  const turn = numberOf(record['turn'])
  if (turn === undefined) return undefined
  const message = recordOf(record['message'])
  // Store the raw text with its newlines: the gate needs block structure (the
  // heading/list shape) and strips fenced blocks itself. Only the tail is kept,
  // bounded on a line boundary so the parser never starts mid-item.
  const raw = contentText(message?.['content'])
  const lastText = raw.trim() === ''
    ? null
    : {
        turn: Math.trunc(turn),
        seq: event.seq,
        at: event.time,
        text: tailBoundLines(raw, PROSE_LIMITS.textChars),
      }
  return { state: { ...state, prose: { ...state.prose, lastText } }, drafts: [] }
}

/** Raise the candidates when the turn ends on an unresolved ask section. */
function onTurnEnd(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  const turn = numberOf(recordOf(event.data)?.['turn'])
  const last = state.prose.lastText
  if (turn === undefined || last === null || last.turn !== Math.trunc(turn)) return undefined
  // Gate rule 3: a blocking structural item already carries this turn.
  if (state.prose.structuralTurn === last.turn) return undefined
  return raiseAsks(state, last.text, last.turn, last.seq, event.time, session, source)
}

/**
 * Raise the asks of a turn the log never closed with `turn/end`.
 *
 * A log that stops mid-turn (the crash/interrupt case, and the acceptance
 * fixture that ends after the final message) never appends the `turn/end` that
 * normally raises the candidates. This runs from `finalizeOpenItems`; it is a
 * no-op when the ledger is between turns, so a log whose last transition was a
 * `turn/end` is never re-raised.
 * @param state - ledger after the last event.
 * @param session - owning session metadata.
 * @param source - detector source to stamp on drafts.
 * @param at - event time to stamp on the raised artifacts.
 * @returns the next state and the finalized drafts (possibly none).
 */
export function finalizeProse(
  state: LedgerState,
  session: CaptureSessionInfo,
  source: DetectionSource,
  at: number,
): FoldStep | undefined {
  const last = state.prose.lastText
  if (last === null) return undefined
  // Only a log that ended inside the turn is finalized; a completed turn already
  // got its raise (or its deliberate suppression) at its own `turn/end`.
  if (state.currentTurn === null || state.currentTurn !== last.turn) return undefined
  if (state.prose.structuralTurn === last.turn) return undefined
  return raiseAsks(state, last.text, last.turn, last.seq, at, session, source)
}

/** Close every open prose candidate the user has moved past. */
function closeSuperseded(
  state: LedgerState,
  event: CaptureEvent,
  session: CaptureSessionInfo,
  source: DetectionSource,
): FoldStep | undefined {
  const stale = openProseArtifacts(state).filter(artifact => artifact.seq < event.seq)
  if (stale.length === 0) return undefined
  let next = state
  const drafts: DerivedItemDraft[] = []
  for (const artifact of stale) {
    drafts.push(closeDraft(artifact, { session, source }, event.time, PROSE_SUPERSEDED_CODE))
    next = removeArtifact(next, artifact.artifactId)
  }
  return { state: next, drafts }
}
