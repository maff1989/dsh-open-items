/**
 * App-scoped transient notices for answer outcomes (S-04).
 *
 * The page publishes here; one Toast host registered in the root `shell.overlay`
 * seat renders the newest notice, so a success or failure survives leaving the
 * page or switching sessions. Pending states are deliberately never published:
 * only a settled outcome produces a notice.
 *
 * @module dsh-open-items/client/ui/answer/notices
 */
import type { PageTranslate } from '../../format'
import type { AnswerAttempt } from './feedback'

/** Visual tone of one notice. */
export type NoticeTone = 'ok' | 'notice' | 'error'

/** One transient notice, already resolved to localized copy. */
export interface AnswerNotice {
  /** Per-show sequence; the host keys the Toast by it so re-shows restart. */
  readonly id: number
  readonly tone: NoticeTone
  readonly text: string
  /** Optional follow-up the user may take directly from the banner. */
  readonly action?: { readonly label: string; readonly run: () => void }
}

/** The one live notice plus its publishers. */
export interface AnswerNoticeStore {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => AnswerNotice | undefined
  /** Publish (and replace) the current notice; returns its sequence id. */
  show(notice: Omit<AnswerNotice, 'id'>): number
  /** Clear the notice with this id (a newer notice is untouched). */
  dismiss(id: number): void
}

/** Create one notice store. */
export function createAnswerNoticeStore(): AnswerNoticeStore {
  let current: AnswerNotice | undefined
  let sequence = 0
  const listeners = new Set<() => void>()
  const publish = (next: AnswerNotice | undefined): void => {
    current = next
    for (const listener of [...listeners]) listener()
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => current,
    show(notice) {
      sequence += 1
      publish({ ...notice, id: sequence })
      return sequence
    },
    dismiss(id) {
      if (current?.id === id) publish(undefined)
    },
  }
}

/** The app-wide store the page and the Toast host share. */
export const answerNotices = createAnswerNoticeStore()

/** The explicit follow-ups a transient notice may offer. */
export interface NoticeActions {
  /** Re-send the exact attempt with its deliveryId. */
  retry(): void
  /** Explicitly send and resume now (the warned wake). */
  wake(): void
}

/**
 * The transient notice one attempt deserves, or `undefined`.
 * Pending attempts never toast, and a failure always keeps its reason.
 */
export function noticeOf(
  t: PageTranslate,
  attempt: AnswerAttempt,
  actions: NoticeActions,
): Omit<AnswerNotice, 'id'> | undefined {
  if (attempt.status === 'sending') return undefined
  const action = attempt.retryable
    ? { label: t('answer.retry'), run: actions.retry }
    : attempt.offersWake
      ? { label: t('answer.wake.confirm'), run: actions.wake }
      : undefined
  const tone: NoticeTone = attempt.claim === 'failed' ? 'error' : attempt.claim === 'recorded' ? 'notice' : 'ok'
  return { tone, text: attempt.message, ...(action === undefined ? {} : { action }) }
}
