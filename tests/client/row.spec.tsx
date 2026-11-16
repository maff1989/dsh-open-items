// @vitest-environment jsdom
/**
 * Item row variants: every record shape the inbox must render, with its quick
 * actions in the state the write path supports — shipped Pill options, the
 * shared approval confirmation, a route-derived label, the honest candidate/task
 * hand-off and the in-place attempt notice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./primitives-mock'))
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import type { AnswerPlan } from '../../src/client/data/settle'
import { attemptOf } from '../../src/client/ui/answer/feedback'
import { ItemRow, rowVariantOf, type RowHandlers } from '../../src/client/ui/row'
import type { OpenItemRecord } from '../../src/shared/schema'
import type { ReplyValue } from '../../src/shared/protocol'
import { makeItem, t } from './fixtures'

afterEach(cleanup)

/** A settle plan: the action answers in place and costs no turn. */
const settlePlan: AnswerPlan = { track: 'client-settle', settles: true, steers: false, requiresWakeConfirmation: false }

/** A message plan: the action sends and would spend a turn. */
const messagePlan: AnswerPlan = { track: 'message', settles: false, steers: false, requiresWakeConfirmation: true }

/** Route reply stub for attempt fixtures. */
const reply = {} as ReplyValue

/** Render one row with the given handlers. */
function renderRow(item: OpenItemRecord, handlers: Partial<RowHandlers> = {}, now = 5_000): void {
  const select = vi.fn()
  render(
    <ul>
      <ItemRow
        item={item}
        t={t}
        now={now}
        selected={false}
        handlers={{ select, ...handlers }}
      />
    </ul>,
  )
}

/** An authored sign-off: raised through the tool, with no live request behind it. */
function authoredApproval(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    kind: 'approval',
    title: 'Registry access',
    source: { sessionId: 'session-1' },
    dedupeKey: 'authored|approval|session-1|raise-1',
    detectedBy: ['tool'],
    ...overrides,
  })
}

/** Functions every answerable row takes. */
function answerHandlers(overrides: Partial<RowHandlers> = {}): Partial<RowHandlers> {
  return {
    answer: vi.fn(),
    canAnswer: () => true,
    planFor: () => settlePlan,
    ...overrides,
  }
}

describe('row variants', () => {
  it('classifies every record shape', () => {
    expect(rowVariantOf(makeItem({ kind: 'approval' }))).toBe('approval')
    expect(rowVariantOf(makeItem({ kind: 'question', reply: { controls: ['option'], options: ['Yes'], freeText: false, requiresConfirm: false } }))).toBe('options')
    expect(rowVariantOf(makeItem({ kind: 'question', reply: { controls: ['text'], freeText: true, requiresConfirm: false } }))).toBe('text')
    expect(rowVariantOf(makeItem({ tier: 'candidate' }))).toBe('candidate')
    expect(rowVariantOf(makeItem({ kind: 'task' }))).toBe('task')
    expect(rowVariantOf(makeItem({ state: 'awaiting' }))).toBe('awaiting')
    expect(rowVariantOf(makeItem({
      state: 'open',
      deliveries: [{ deliveryId: 'd1', at: 1, track: 'session-message', payload: { type: 'text', text: 'x' }, state: 'failed', failure: { code: 'session-archived', message: 'archived' } }],
    }))).toBe('failed')
    expect(rowVariantOf(makeItem({ state: 'resolved' }))).toBe('resolved')
    expect(rowVariantOf(makeItem({ kind: 'decision', reply: { controls: [], freeText: false, requiresConfirm: false } }))).toBe('plain')
  })

  it('renders an approval with Allow/Deny enabled only when a live card can decide it', () => {
    renderRow(makeItem({ kind: 'approval', title: 'Registry access' }))
    expect(screen.getByText('Approval')).toBeTruthy()
    expect(screen.getByText('Registry access')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow once' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveProperty('disabled', true)
  })

  it('opens the shipped confirmation instead of deciding on the first click', () => {
    const answer = vi.fn()
    renderRow(makeItem({ kind: 'approval', title: 'Registry access' }), {
      answer,
      canAnswer: () => true,
      canAnswerApproval: () => true,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(answer).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'Allow once' })
    expect(dialog).toBeTruthy()
    const confirm = within(dialog).getByRole('button', { name: 'Allow once' })
    expect(confirm).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(confirm)
    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'approval' }),
      { type: 'approval', outcome: 'allow-once' },
    )
  })

  it('collects the denial reason before denying', () => {
    const answer = vi.fn()
    renderRow(makeItem({ kind: 'approval', title: 'Registry access' }), {
      answer,
      canAnswer: () => true,
      canAnswerApproval: () => true,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    const dialog = screen.getByRole('dialog', { name: 'Deny this approval' })
    const reason = within(dialog).getByRole('textbox', { name: 'Reason (optional)' })
    fireEvent.change(reason, { target: { value: 'dry run first' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deny' }))
    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'approval' }),
      { type: 'approval', outcome: 'deny', note: 'dry run first' },
    )
  })

  it('renders an option question as a scan row with no inline answer controls', () => {
    renderRow(
      makeItem({
        kind: 'question',
        title: 'Ship before Friday?',
        source: { sessionId: 's1', sessionTitle: 'Hookshot review', turn: 3 },
        reply: { controls: ['option'], options: ['Yes', 'No'], freeText: false, requiresConfirm: false },
      }),
      answerHandlers(),
    )
    // Answering belongs to the detail pane; the row offers selection only.
    expect(screen.queryByRole('group', { name: 'Answer choices' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Yes' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send to session' })).toBeNull()
    expect(screen.getByText('Question')).toBeTruthy()
    expect(screen.getByText('turn 3')).toBeTruthy()
  })

  it('selects the item when the row body is clicked', () => {
    const select = vi.fn()
    renderRow(makeItem({ title: 'Pick me' }), { select })
    fireEvent.click(screen.getByText('Pick me'))
    expect(select).toHaveBeenCalledWith('item-1')
  })

  it('titles the truncated row name with the full title', () => {
    renderRow(makeItem({ title: 'A very long decision title that will not fit a 400px column' }))
    expect(screen.getByText('A very long decision title that will not fit a 400px column')).toHaveProperty(
      'title',
      'A very long decision title that will not fit a 400px column',
    )
  })

  it('keeps Allow/Deny disabled when no live card can decide the approval', () => {
    const answer = vi.fn()
    renderRow(makeItem({ kind: 'approval', title: 'Registry access' }), {
      answer,
      canAnswer: () => true,
      canAnswerApproval: () => false,
    })
    const allow = screen.getByRole('button', { name: 'Allow once' })
    expect(allow).toHaveProperty('disabled', true)
    expect(allow).toHaveProperty('title', 'Open the session to decide this approval')
    fireEvent.click(allow)
    expect(answer).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('enables Allow/Deny for an authored approval and confirms a session send', () => {
    const answer = vi.fn()
    renderRow(authoredApproval(), {
      answer,
      canAnswer: () => true,
      canAnswerApproval: () => true,
      sessionTitle: () => 'Plugin implementation and docs review',
    })
    const allow = screen.getByRole('button', { name: 'Allow once' })
    expect(allow).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveProperty('disabled', false)
    // The injected catalogue title names the session in the confirmation; the
    // row no longer repeats provenance the group header already carries.
    expect(screen.queryByText(t('detail.untitledSession'))).toBeNull()
    fireEvent.click(allow)
    const dialog = screen.getByRole('dialog', { name: 'Allow once' })
    expect(dialog.textContent ?? '').toContain('Plugin implementation and docs review')
    expect(dialog.textContent ?? '').toContain(t('answer.approval.allowBodyToSession'))
    expect(dialog.textContent ?? '').toContain(t('answer.approval.acknowledgeToSession'))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow once' }))
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-1' }), { type: 'approval', outcome: 'allow-once' })
  })

  it('does not point a disabled authored approval at a session approval card', () => {
    renderRow(authoredApproval(), { answer: vi.fn(), canAnswer: () => true, canAnswerApproval: () => false })
    const allow = screen.getByRole('button', { name: 'Allow once' })
    expect(allow).toHaveProperty('disabled', true)
    expect(allow).toHaveProperty('title', t('row.action.pending'))
    expect(screen.queryByText(t('row.action.approvalNeedsSession'))).toBeNull()
  })

  it('renders a candidate with its evidence and one-click confirm controls', () => {
    const promote = vi.fn()
    const suppress = vi.fn()
    renderRow(
      makeItem({
        id: 'candidate-1',
        tier: 'candidate',
        severity: 3,
        title: 'Also update the docs?',
        quote: 'Want me to also update the docs?',
        source: { sessionId: 'session-1', sessionTitle: 'Docs review', turn: 4 },
      }),
      { promote, suppress },
    )
    expect(screen.getByText('Also update the docs?')).toBeTruthy()
    expect(screen.getByText('Want me to also update the docs?')).toBeTruthy()
    expect(screen.getByText(t('candidate.evidence.gateTurn', { turn: 4 }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('candidate.action.promote') }))
    expect(promote).toHaveBeenCalledWith(expect.objectContaining({ id: 'candidate-1', version: 1 }))
    // Suppression is permanent: it goes through the shipped confirmation.
    fireEvent.click(screen.getByRole('button', { name: t('candidate.action.suppress') }))
    const dialog = screen.getByRole('dialog', { name: t('candidate.suppress.title') })
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: t('candidate.action.suppress') }))
    expect(suppress).toHaveBeenCalledWith(expect.objectContaining({ id: 'candidate-1' }))
  })

  it('disables a candidate\'s controls while its write is in flight', () => {
    renderRow(
      makeItem({ tier: 'candidate', severity: 3, title: 'Also update the docs?' }),
      { promote: vi.fn(), suppress: vi.fn(), candidatePending: () => true },
    )
    expect(screen.getByRole('button', { name: t('candidate.action.promote') })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: t('candidate.action.suppress') })).toHaveProperty('disabled', true)
  })

  it('explains that candidates are not answerable like items, even with the answer seam', () => {
    renderRow(
      makeItem({ tier: 'candidate', severity: 3, title: 'Also update the docs?' }),
      answerHandlers(),
    )
    expect(rowVariantOf(makeItem({ tier: 'candidate' }))).toBe('candidate')
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send to session' })).toBeNull()
    expect(screen.getByText(t('candidate.unavailable'))).toBeTruthy()
  })

  it('renders a task as a session hand-off, with no disabled placeholders (OD-03)', () => {
    const openSession = vi.fn()
    renderRow(makeItem({ kind: 'task', title: 'Write the migration guide' }), { openSession })
    expect(screen.queryByText('Complete')).toBeNull()
    expect(screen.queryByText('Reassign')).toBeNull()
    expect(screen.getByText('Task')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }))
    expect(openSession).toHaveBeenCalledWith('session-1')
  })

  it('renders an awaiting row with its sent state exactly once and no actions', () => {
    renderRow(makeItem({ state: 'awaiting', title: 'Keep the 5-colour palette' }))
    expect(screen.getAllByText('Sent to session')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()
  })

  it('renders a failed delivery with the reason, a Retry and the session escape hatch', () => {
    const openSession = vi.fn()
    const retry = vi.fn()
    renderRow(
      makeItem({
        deliveries: [{ deliveryId: 'd1', at: 1, track: 'session-message', payload: { type: 'text', text: 'x' }, state: 'failed', failure: { code: 'session-archived', message: 'archived' } }],
      }),
      { openSession, retry },
    )
    expect(screen.getByText('Not applied — session archived')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }))
    expect(openSession).toHaveBeenCalledWith('session-1')
  })

  it('renders a resolved row read-only with its settled state', () => {
    renderRow(makeItem({
      state: 'resolved',
      title: 'Install the corporate registry',
      deliveries: [{ deliveryId: 'd1', at: 1, track: 'client-settle', payload: { type: 'approval', outcome: 'allow-once' }, state: 'settled' }],
    }))
    expect(screen.getByText('Applied')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull()
  })

  it('selects the item when the row title button is activated', () => {
    const select = vi.fn()
    renderRow(makeItem({ title: 'Pick me' }), { select })
    fireEvent.click(screen.getByRole('button', { name: 'Select Pick me' }))
    expect(select).toHaveBeenCalledWith('item-1')
  })

  it('marks a new item with the leading dot and explains it for screen readers', () => {
    render(
      <ul>
        <ItemRow item={makeItem({ title: 'Fresh item' })} t={t} now={5_000} selected={false} handlers={{ select: vi.fn() }} isNew />
      </ul>,
    )
    expect(screen.getByText(t('row.newAria'))).toBeTruthy()
    expect(document.querySelector('[data-state="warning"]')).toBeTruthy()
  })

  it('does not render a leading dot for an item seen before the last visit', () => {
    renderRow(makeItem({ title: 'Older item' }))
    expect(screen.queryByText(t('row.newAria'))).toBeNull()
    expect(document.querySelector('.dsh-oi-grade')?.getAttribute('data-new')).toBe('false')
  })

  it('turns urgent severity into a plain-language tag instead of the dot', () => {
    renderRow(makeItem({ severity: 1, title: 'Do this first' }))
    expect(screen.getByText('Urgent')).toBeTruthy()
  })

  it('labels the wait by meaning and keeps turn provenance only', () => {
    renderRow(
      makeItem({ firstSeenAt: 1_000, source: { sessionId: 's1', sessionTitle: 'Hookshot review', turn: 4 } }),
      {},
      181_000,
    )
    expect(screen.getByText('waiting 3m ago')).toBeTruthy()
    // The sticky group header already names the session; the row does not repeat it.
    expect(screen.queryByText(/Hookshot review/)).toBeNull()
    expect(screen.getByText('turn 4')).toBeTruthy()
  })
})

describe('attempt feedback inside the row', () => {
  it('shows a failure with its reason and a Retry that reuses the attempt', () => {
    const retry = vi.fn()
    const item = makeItem({ title: 'Which registry?' })
    const attempt = attemptOf(t, {
      itemId: item.id,
      sessionTitle: 'Hookshot review',
      plan: messagePlan,
      payload: { type: 'text', text: 'npm' },
      confirmedWake: false,
      result: { kind: 'refused', code: 'conflict', message: 'stale', deliveryId: 'delivery-1' },
    })
    render(
      <ul>
        <ItemRow item={item} t={t} now={5_000} selected={false} handlers={{ select: vi.fn(), retry }} attempt={attempt} />
      </ul>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText(/Not applied/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalled()
  })

  it('offers the explicit Send & resume now for a recorded outcome', () => {
    const wake = vi.fn()
    const item = makeItem({ title: 'Keep 5 colours' })
    const attempt = attemptOf(t, {
      itemId: item.id,
      sessionTitle: 'Hookshot review',
      plan: messagePlan,
      payload: { type: 'text', text: 'keep five' },
      confirmedWake: false,
      result: { kind: 'recorded', reply, deliveryId: 'delivery-2' },
    })
    render(
      <ul>
        <ItemRow item={item} t={t} now={5_000} selected={false} handlers={{ select: vi.fn(), wake }} attempt={attempt} />
      </ul>,
    )
    expect(screen.getByText(/Saved, not sent/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send & resume now' }))
    expect(wake).toHaveBeenCalled()
  })
})
