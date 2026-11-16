// @vitest-environment jsdom
/**
 * The approval confirmation (OI-08): one decision, made explicitly.
 *
 * Allow must go through the shipped acknowledgement step (no one-click grant);
 * Deny must collect the optional reason and send it with the denial. The
 * primitives are the local stand-ins of `primitives-mock`, so the assertions are
 * about behaviour and roles, not about markup.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./primitives-mock'))
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ApprovalConfirm } from '../../src/client/ui/answer/ApprovalConfirm'
import type { OpenItemRecord } from '../../src/shared/schema'
import { makeItem, t } from './fixtures'

afterEach(cleanup)

/** One approval with a session and turn, so the copy can be asserted. */
function approval(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    kind: 'approval',
    title: 'Registry access for the pnpm add',
    source: { sessionId: 'session-1', sessionTitle: 'Hookshot review', turn: 4 },
    ...overrides,
  })
}

/** An authored sign-off: raised through the tool, with no live request behind it. */
function authoredApproval(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    kind: 'approval',
    title: 'Registry access for the pnpm add',
    source: { sessionId: 'session-1' },
    dedupeKey: 'authored|approval|session-1|raise-1',
    detectedBy: ['tool'],
    ...overrides,
  })
}

/** Render one direction of the confirmation. */
function renderConfirm(
  mode: 'allow' | 'deny',
  onConfirm = vi.fn(),
  onCancel = vi.fn(),
): { readonly onConfirm: ReturnType<typeof vi.fn>; readonly onCancel: ReturnType<typeof vi.fn> } {
  render(<ApprovalConfirm t={t} item={approval()} mode={mode} open onCancel={onCancel} onConfirm={onConfirm} />)
  return { onConfirm, onCancel }
}

describe('allow', () => {
  it('repeats the exact action and the session before the decision', () => {
    renderConfirm('allow')
    const dialog = screen.getByRole('dialog', { name: t('answer.approval.allowTitle') })
    expect(dialog).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Hookshot review')
    expect(text).toContain(t('answer.approval.acknowledge'))
    expect(text).toContain(t('answer.approval.allowBody'))
  })

  it('keeps Allow disabled until the acknowledge box is checked', () => {
    const { onConfirm } = renderConfirm('allow')
    const allow = screen.getByRole('button', { name: t('answer.approval.allowConfirm') })
    expect(allow).toHaveProperty('disabled', true)
    fireEvent.click(allow)
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(allow).toHaveProperty('disabled', false)
    fireEvent.click(allow)
    expect(onConfirm).toHaveBeenCalledWith({ type: 'approval', outcome: 'allow-once' })
  })

  it('cancels without deciding', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    renderConfirm('allow', onConfirm, onCancel)
    fireEvent.click(screen.getByRole('button', { name: t('answer.approval.cancel') }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('deny', () => {
  it('collects the optional reason and sends it with the denial', () => {
    const { onConfirm } = renderConfirm('deny')
    const reason = screen.getByRole('textbox', { name: t('answer.approval.denyReason') })
    fireEvent.change(reason, { target: { value: 'run a dry run first' } })
    fireEvent.click(screen.getByRole('button', { name: t('answer.approval.denyConfirm') }))
    expect(onConfirm).toHaveBeenCalledWith({ type: 'approval', outcome: 'deny', note: 'run a dry run first' })
  })

  it('sends a denial with no note when the field is left empty', () => {
    const { onConfirm } = renderConfirm('deny')
    fireEvent.click(screen.getByRole('button', { name: t('answer.approval.denyConfirm') }))
    expect(onConfirm).toHaveBeenCalledWith({ type: 'approval', outcome: 'deny' })
  })

  it('saves the reason on Enter in the draft field', () => {
    const { onConfirm } = renderConfirm('deny')
    const reason = screen.getByRole('textbox', { name: t('answer.approval.denyReason') })
    fireEvent.change(reason, { target: { value: 'not this week' } })
    fireEvent.keyDown(reason, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledWith({ type: 'approval', outcome: 'deny', note: 'not this week' })
  })

  it('closes without deciding', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    renderConfirm('deny', onConfirm, onCancel)
    fireEvent.click(screen.getByRole('button', { name: t('answer.approval.cancel') }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('authored approvals', () => {
  it('asks consent to send to the session instead of granting one run', () => {
    render(<ApprovalConfirm t={t} item={authoredApproval()} mode="allow" open onCancel={vi.fn()} onConfirm={vi.fn()} />)
    const text = document.body.textContent ?? ''
    // The consequence the user consents to is a session message, not a grant.
    expect(text).toContain(t('answer.approval.allowBodyToSession'))
    expect(text).toContain(t('answer.approval.acknowledgeToSession'))
    expect(text).not.toContain(t('answer.approval.allowBody'))
    // No stamped title proves nothing: the honest fallback never claims deletion.
    expect(text).toContain(t('detail.untitledSession'))
  })

  it('uses the resolved Session label the parent passes', () => {
    render(
      <ApprovalConfirm
        t={t}
        item={authoredApproval()}
        mode="allow"
        open
        sessionTitle="Plugin implementation and docs review"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )
    const text = document.body.textContent ?? ''
    expect(text).toContain('Plugin implementation and docs review')
    expect(text).not.toContain(t('detail.untitledSession'))
  })

  it('keeps the denial as a rejection, with the same copy as a mirrored approval', () => {
    const { onConfirm } = { onConfirm: vi.fn() }
    render(<ApprovalConfirm t={t} item={authoredApproval()} mode="deny" open onCancel={vi.fn()} onConfirm={onConfirm} />)
    expect(document.body.textContent ?? '').toContain(t('answer.approval.denyBody'))
    fireEvent.click(screen.getByRole('button', { name: t('answer.approval.denyConfirm') }))
    expect(onConfirm).toHaveBeenCalledWith({ type: 'approval', outcome: 'deny' })
  })
})

describe('closed', () => {
  it('renders nothing while closed', () => {
    render(<ApprovalConfirm t={t} item={approval()} mode="allow" open={false} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
