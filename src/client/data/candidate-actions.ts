/**
 * The two candidate lifecycle actions (PLAN-remediation §7, G-07).
 *
 * A candidate is an inferred item, not a raised one: the user either confirms it
 * ("It's an item" → `promote`, which turns it into a structural Needs-you row) or
 * says it is not one ("Not an item" → `suppress`, which dismisses it and writes a
 * suppressor so the same fingerprint cannot be raised again). Both are CAS writes
 * on the candidate's own version, and every outcome is reported honestly through
 * the app-scoped notice host — a failed write changes nothing on screen but the
 * notice, and the list is re-read so the rows show Host truth.
 *
 * Confirming a prose candidate is also a correction: the client can send the
 * chosen kind and the edited title (contract §2.1's optional `patch`), so the
 * detector's guess never becomes permanent by default. A bulk confirm writes the
 * whole batch against one re-read — N promotes must not mean N inbox reads.
 *
 * Kept out of the composition root so the request shape and the failure copy are
 * testable without a full client context.
 *
 * @module dsh-open-items/client/data/candidate-actions
 */
import type { OpenItemRecord } from '../../shared/schema'
import type { PromotePatch, PromoteRequest } from '../../shared/protocol'
import { toPlainText } from '../ui/prose-text'
import { OpenItemsRpcError, type CandidateTransport } from './transport'

/** Copy keys of the candidate outcome notices. */
export type CandidateNoticeKey =
  | 'candidate.notice.promoted'
  | 'candidate.notice.suppressed'
  | 'candidate.notice.failed'
  | 'candidate.notice.conflict'
  | 'candidate.bulk.promoted.one'
  | 'candidate.bulk.promoted.other'

/**
 * The correction the user made before confirming a candidate (contract §2.1).
 * It is the wire's own `PromotePatch` (slice B), so the client cannot drift from
 * the validated request shape.
 */
export type CandidatePromotePatch = PromotePatch

/** One candidate to confirm, with its optional correction. */
export interface CandidateTarget {
  readonly item: OpenItemRecord
  readonly patch?: CandidatePromotePatch
}

/** Outcome of one candidate write: accepted, or the reason the row should keep. */
export type CandidateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

/** One refused write inside a bulk confirmation, kept beside its row. */
export interface CandidateBulkFailure {
  readonly itemId: string
  readonly message: string
}

/** Outcome of a bulk confirmation: one re-read, and honest counts. */
export interface CandidateBulkResult {
  /** Rows the Host accepted. */
  readonly confirmed: number
  /** Rows the Host refused (their rows stay visible, the page says how many). */
  readonly failed: number
  /** The per-row refusals, so the reason can stay beside each row. */
  readonly failures: readonly CandidateBulkFailure[]
}

/** The inline failure a candidate row/detail keeps after a refused write. */
export interface CandidateFailure {
  readonly message: string
  /** Which control failed, so its Retry re-runs the same write. */
  readonly retry: 'promote' | 'suppress'
}

/** One transient notice the notice host can render. */
export interface CandidateNotice {
  readonly tone: 'ok' | 'error'
  readonly text: string
}

/** Injection points of the candidate actions. */
export interface CandidateActionsDeps {
  /** Candidate face of the route transport. */
  readonly transport: CandidateTransport
  /** Re-read the inbox after a write so every surface shows Host truth. */
  readonly refresh: () => void
  /** Publish one outcome notice (the app-scoped Toast host). */
  readonly notify: (notice: CandidateNotice) => void
  /** Translate one of this module's copy keys with `{title}`/`{message}`/`{count}` params. */
  readonly translate: (key: CandidateNoticeKey, params?: Record<string, string>) => string
}

/** The actions the page's candidate controls call. */
export interface CandidateActions {
  /**
   * Confirm one candidate as a structural item, carrying the user's corrections.
   * @param item - the candidate row the user acted on (its version is the CAS token).
   * @param patch - the chosen kind / edited title, when the user corrected them.
   * @returns the outcome; a refusal carries the row/detail message.
   */
  promote(item: OpenItemRecord, patch?: CandidatePromotePatch): Promise<CandidateResult>
  /**
   * Confirm several candidates as structural items with one inbox re-read.
   * @param targets - the ticked candidates and their corrections, in list order.
   * @returns the honest counts of the batch.
   */
  promoteMany(targets: readonly CandidateTarget[]): Promise<CandidateBulkResult>
  /**
   * Dismiss one candidate and remember it is not an item.
   * @param item - the candidate row the user acted on.
   * @returns the outcome; a refusal carries the row/detail message.
   */
  suppress(item: OpenItemRecord): Promise<CandidateResult>
}

/**
 * Build the `promote` request, including the correction patch when one exists.
 * @param item - the candidate row.
 * @param patch - the user's corrections, when any.
 * @returns the request to send.
 */
function promoteRequestOf(item: OpenItemRecord, patch: CandidatePromotePatch | undefined): PromoteRequest {
  return {
    itemId: item.id,
    expectedVersion: item.version,
    ...(patch === undefined ? {} : { patch }),
  }
}

/** The title a notice names: the user's correction wins over the stored raw title. */
function noticeTitleOf(item: OpenItemRecord, patch: CandidatePromotePatch | undefined): string {
  const edited = patch?.title === undefined ? '' : toPlainText(patch.title)
  return edited === '' ? toPlainText(item.title) : edited
}

/**
 * Create the candidate lifecycle actions.
 * @param deps - route transport, inbox refresh, notice publisher and translate.
 * @returns the actions.
 */
export function createCandidateActions(deps: CandidateActionsDeps): CandidateActions {
  const { transport, refresh, notify, translate } = deps

  /**
   * The message one refused write keeps beside its row. A lost race is the one
   * failure with a plain-language explanation; every other failure carries the
   * route's own message.
   */
  function failureMessageOf(item: OpenItemRecord, error: unknown, patch?: CandidatePromotePatch): string {
    const title = noticeTitleOf(item, patch)
    return error instanceof OpenItemsRpcError && error.code === 'conflict'
      ? translate('candidate.notice.conflict', { title })
      : translate('candidate.notice.failed', {
        title,
        message: error instanceof Error ? error.message : String(error),
      })
  }

  /**
   * One failed action: resync and return the message the row/detail keeps. The
   * inline notice, not a transient toast, is where a candidate failure is read
   * (the same honesty rule the answer path follows).
   */
  function reportFailure(item: OpenItemRecord, error: unknown, patch?: CandidatePromotePatch): CandidateResult {
    // Resync either way: a conflict means another surface wrote first, and a
    // carrier failure may have hidden an outcome. The next click then acts on
    // the version the list actually shows.
    refresh()
    return { ok: false, message: failureMessageOf(item, error, patch) }
  }

  return {
    async promote(item, patch) {
      try {
        await transport.promote(promoteRequestOf(item, patch))
        refresh()
        notify({ tone: 'ok', text: translate('candidate.notice.promoted', { title: noticeTitleOf(item, patch) }) })
        return { ok: true }
      } catch (error) {
        return reportFailure(item, error, patch)
      }
    },
    async promoteMany(targets) {
      let confirmed = 0
      const failures: CandidateBulkFailure[] = []
      for (const target of targets) {
        try {
          await transport.promote(promoteRequestOf(target.item, target.patch))
          confirmed += 1
        } catch (error) {
          // The batch keeps going: one stale row must not block the others. Its
          // row keeps the reason; the caller reports the count.
          failures.push({ itemId: target.item.id, message: failureMessageOf(target.item, error, target.patch) })
        }
      }
      // Exactly one re-read for the whole batch (the old loop re-read per item).
      refresh()
      if (confirmed > 0) {
        notify({
          tone: 'ok',
          text: translate(confirmed === 1 ? 'candidate.bulk.promoted.one' : 'candidate.bulk.promoted.other', {
            count: String(confirmed),
          }),
        })
      }
      return { confirmed, failed: failures.length, failures }
    },
    async suppress(item) {
      try {
        await transport.suppress({ itemId: item.id, expectedVersion: item.version })
        refresh()
        notify({ tone: 'ok', text: translate('candidate.notice.suppressed', { title: toPlainText(item.title) }) })
        return { ok: true }
      } catch (error) {
        return reportFailure(item, error)
      }
    },
  }
}
