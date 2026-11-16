/**
 * How an item came to exist: authored by a caller, or derived from a harness
 * artifact the capture folds observed.
 *
 * The distinction matters exactly where an `approval` kind is answered. Both
 * halves can hold one, and they take different tracks (DESIGN §6.1/§6.4/§6.8):
 *
 * - **derived** (a mirror of a shipped `approval/request`) — decided only
 *   through the live card the browser already holds, `allowed-once`, never by a
 *   message and never retroactively (D9). There is a real request to settle.
 * - **authored** (the agent or a human declared what it needs from the user) —
 *   no harness request exists, so the decision is delivered to the session on
 *   the ordinary track-3 matrix and recorded like any other answer.
 *
 * The discriminator is structural rather than a new schema field, so records
 * already on disk classify correctly: the store mints authored dedupe keys
 * (`authored|…`) and stamps the `tool`/`user` detection sources, while every
 * captured mirror carries an `approvalId` and a `projection`/`log-fold`/`llm`
 * source. Both the Host delivery engine and the browser settle controller read
 * this one predicate, so the two halves cannot disagree.
 *
 * @module dsh-open-items/shared/item-origin
 */
import type { OpenItemRecord } from './schema'

/** The fields needed to tell authored from derived. */
type OriginSlice = Pick<OpenItemRecord, 'dedupeKey' | 'detectedBy'>

/** The fields needed to classify one approval item. */
type ApprovalSlice = OriginSlice & Pick<OpenItemRecord, 'kind' | 'source'>

/**
 * Whether a record was authored (declared by the tool or a human) rather than
 * detected structurally.
 * @param record - stored record (only its dedupe key and detectors are read).
 * @returns true for authored records.
 */
export function isAuthoredItem(record: OriginSlice): boolean {
  return record.dedupeKey.startsWith('authored|')
    || record.detectedBy.includes('tool')
    || record.detectedBy.includes('user')
}

/**
 * Whether an approval item is an authored sign-off with no live request.
 *
 * An item that names an `approvalId` is always treated as a mirror even when a
 * detector merged into it: granting it must stay bound to the shipped card
 * (D9). The authored branch is therefore the strict subset.
 * @param record - stored approval record.
 * @returns true when the decision travels as a session message.
 */
export function isAuthoredApproval(record: ApprovalSlice): boolean {
  return record.kind === 'approval'
    && record.source.approvalId === undefined
    && isAuthoredItem(record)
}
