/**
 * Reveal and hand-off seams of the session panel.
 *
 * Two different problems, deliberately kept apart:
 *
 * 1. **A tool-raised item has its own transcript card.** The panel focuses that
 *    row: rc.1's tool call tree marks every atomic call with both
 *    `data-chat-anchor-key="call:<callId>"` and `data-chat-call-id="<callId>"`
 *    (`@deepseek-ai/dsh-client-ui-tool` client bundle), and the conversation root
 *    carries `data-conversation-session="<sessionId>"`. The lookup is scoped to
 *    this session's conversation, so the panel can never scroll the wrong
 *    transcript. The scroll lands instantly — an animated scroll re-enters Chat's
 *    reading/paging machinery — and the row flashes briefly.
 *
 *    **Fallback, documented:** this build ships no `loadThrough` seam (the
 *    panel has no Session binding), so a row that is windowed out, folded away
 *    or absent resolves as `not-found` and the caller opens the inbox detail
 *    instead. The panel never guesses a scroll position.
 *
 * 2. **A live shipped ask belongs to the composer card** (DESIGN §5.9). The
 *    panel must not render a second Allow/Deny surface, so its row hands off:
 *    for a question it asks the shipped questions UI to reveal the card
 *    (`ctx.get('userQuestionPanels')?.reveal(sessionId, callId)`, the same seam
 *    the shipped tool row consumes); for an approval there is **no** reveal seam
 *    in rc.1 (approval cards are waterfall-owned), so the row degrades to the
 *    inbox detail and the copy says "Open in inbox". Both are best effort: a
 *    `false`/absent answer is a value, never a throw.
 *
 * @module dsh-open-items/client/ui/panel/reveal
 */
import type { OpenItemRecord } from '../../../shared/schema'

/** Result of focusing a tool row in the transcript. */
export type RevealResult = 'revealed' | 'not-found' | 'no-anchor'

/** Result of handing a live shipped ask back to its own surface. */
export type HandoffResult = 'revealed' | 'unavailable'

/** How long the panel's reveal flash stays on the transcript row, in ms. */
export const REVEAL_FLASH_MS = 1_200

/** Minimal structural view of a Cordis context's optional-service lookup. */
interface ServiceLookup {
  get?: (name: string) => unknown
}

/** The shipped questions UI's reveal face (provider: ui-user-questions). */
interface QuestionPanels {
  reveal(sessionId: string, callId: string): boolean
}

/**
 * Read an optional service without making it a hard dependency.
 * @param candidate - the context (or any object) that may expose `get`.
 * @param name - service key.
 * @returns the service, or undefined when this composition does not mount it.
 */
export function optionalService<T>(candidate: unknown, name: string): T | undefined {
  const get = (candidate as ServiceLookup | undefined)?.get
  if (typeof get !== 'function') return undefined
  try {
    return (get as (key: string) => unknown).call(candidate, name) as T | undefined
  } catch {
    return undefined
  }
}

/** Escape a value for an attribute selector without assuming `CSS.escape`. */
function attributeValue(value: string): string {
  return value.replace(/["\\]/gu, match => `\\${match}`)
}

/** Find the mounted conversation root for one session. */
function conversationOf(document: Document, sessionId: string): HTMLElement | undefined {
  for (const element of document.querySelectorAll<HTMLElement>('[data-conversation-session]')) {
    if (element.dataset.conversationSession === sessionId) return element
  }
  return undefined
}

/**
 * Focus and flash the transcript row of one tool call.
 * @param sessionId - session the panel belongs to.
 * @param callId - the raising tool call, when the record carries one.
 * @param document - document to search (tests inject their own).
 * @returns whether a row was revealed.
 */
export function revealToolRow(sessionId: string, callId: string | undefined, document?: Document): RevealResult {
  if (callId === undefined || callId === '') return 'no-anchor'
  const doc = document ?? (globalThis as { document?: Document }).document
  if (doc === undefined) return 'not-found'
  const conversation = conversationOf(doc, sessionId)
  if (conversation === undefined) return 'not-found'
  const row = conversation.querySelector<HTMLElement>(`[data-chat-call-id="${attributeValue(callId)}"]`)
  if (row === null) return 'not-found'
  try {
    row.scrollIntoView({ block: 'center', behavior: 'instant' })
  } catch {
    // A host without scrollIntoView (jsdom, an embedded frame) still flashes.
  }
  row.dataset['openItemsRevealed'] = ''
  const timer = (globalThis as { setTimeout?: typeof setTimeout }).setTimeout
  if (typeof timer === 'function') {
    timer(() => {
      delete row.dataset['openItemsRevealed']
    }, REVEAL_FLASH_MS)
  }
  return 'revealed'
}

/**
 * Whether this composition can reveal a shipped question card.
 * @param context - client context, or a fake exposing `get`.
 * @returns true when the questions UI is mounted.
 */
export function canRevealShippedAsk(context: unknown): boolean {
  return optionalService<QuestionPanels>(context, 'userQuestionPanels') !== undefined
}

/**
 * Hand a live shipped ask back to the surface that owns its answer.
 * @param context - client context, or a fake exposing `get`.
 * @param item - the durable record.
 * @returns `revealed` when the shipped card was focused, `unavailable` when this
 *   build has no seam for that kind (the caller opens the inbox detail instead).
 */
export function handoffShippedAsk(context: unknown, item: OpenItemRecord): HandoffResult {
  const callId = item.source.callId
  if (callId === undefined || callId === '') return 'unavailable'
  const panels = optionalService<QuestionPanels>(context, 'userQuestionPanels')
  if (panels === undefined) return 'unavailable'
  try {
    return panels.reveal(item.source.sessionId, callId) === true ? 'revealed' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}
