/**
 * App-wide Toast host for answer notices (S-04).
 *
 * Registered in the root `shell.overlay` seat, so a transient success/failure
 * survives leaving the page or switching sessions. The shipped Toast portals
 * itself, keys its animation by the notice id, and fades before calling
 * `onDone`; the store then clears the notice. Nothing is toasted while a
 * request is pending.
 *
 * @module dsh-open-items/client/ui/answer/ToastHost
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'

import { answerNotices, type AnswerNotice } from './notices'

/** Hold of a one-line success before it fades. */
const HOLD_OK_MS = 3_000

/** A failure names what broke, so it stays longer. */
const HOLD_FAILURE_MS = 6_000

/**
 * Render the newest answer notice, or nothing.
 * @returns the floating banner.
 */
export function AnswerToastHost(): ReactNode {
  const notice: AnswerNotice | undefined = useSyncExternalStore(answerNotices.subscribe, answerNotices.getSnapshot)
  if (notice === undefined) return null
  const actions = notice.action === undefined
    ? undefined
    : [{
      label: notice.action.label,
      onClick: () => {
        answerNotices.dismiss(notice.id)
        notice.action?.run()
      },
    }]
  return (
    <Toast
      key={notice.id}
      text={notice.text}
      holdMs={notice.tone === 'error' ? HOLD_FAILURE_MS : HOLD_OK_MS}
      {...(notice.tone === 'ok' ? { tone: 'success' as const } : {})}
      {...(notice.tone === 'error' ? { icon: <IconWarningOutlineRegular size={16} /> } : {})}
      {...(actions === undefined ? {} : { actions })}
      onDone={() => {
        answerNotices.dismiss(notice.id)
      }}
    />
  )
}
