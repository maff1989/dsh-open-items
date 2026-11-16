// @vitest-environment jsdom
/**
 * Candidate rendering from the exact stored raw row shape.
 *
 * The fixture is the row the audit captured from a real store
 * (`research/prose-audit/scratch/client/stored-candidate.json`): the title and
 * quote are the same raw markdown sentence, the body is the detector's
 * boilerplate, and the record claims kind `question`. These tests pin the
 * client contract for that shape:
 * - projected title/quote (no `**`, no leading `- `) and no duplicated quote;
 * - the kind reads as inferred and correctable;
 * - a promoted prose item is a normal, answerable item that never shows the
 *   detector body;
 * - a five-decision turn renders five distinct rows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./primitives-mock'))
import { cleanup, render, screen } from '@testing-library/react'

import type { AnswerPlan } from '../../src/client/data/settle'
import { ItemDetail } from '../../src/client/ui/detail'
import { ItemRow, type RowHandlers } from '../../src/client/ui/row'
import type { OpenItemRecord } from '../../src/shared/schema'
import { makeItem, t } from './fixtures'

afterEach(cleanup)

/** The verbatim stored title/quote (raw markdown). */
const STORED_TEXT = '- **E** — Ship together as one PR/branch or two (host semantics vs card client)?'
/** The projected display line. */
const PROJECTED_TEXT = 'E — Ship together as one PR/branch or two (host semantics vs card client)?'
/** The detector's boilerplate body, verbatim from the stored row. */
const DETECTOR_BODY = 'This session ended a turn with a decision request; confirm to turn it into an item.'

/** The exact stored candidate row (ids and timestamps included). */
function storedCandidate(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return makeItem({
    id: '01a1dc97-031b-7b3f-8db0-8b762b5f1ed2',
    kind: 'question',
    tier: 'candidate',
    severity: 2,
    title: STORED_TEXT,
    body: DETECTOR_BODY,
    quote: STORED_TEXT,
    source: {
      sessionId: 'session-4de927ce-48c5-4a09-a91b-b39333ffb7e4',
      sessionTitle: 'Dismissed open items in flight?',
      turn: 2,
      seq: 368,
    },
    blocking: false,
    reply: { controls: ['text'], freeText: true, requiresConfirm: true },
    detectedBy: ['regex-gate'],
    dedupeKey: 'derived|question|session-4de927ce-48c5-4a09-a91b-b39333ffb7e4|prose:c04dafa9ac3e093d',
    history: [
      { at: 1_000, action: 'raised', detail: 'prose-gate:decision-request' },
      { at: 2_000, action: 're-raised', detail: 'prose-gate:decision-request' },
    ],
    ...overrides,
  })
}

/** A settle plan: the action answers in place and costs no turn. */
const settlePlan: AnswerPlan = { track: 'client-settle', settles: true, steers: false, requiresWakeConfirmation: false }

/** Render one row inside a list. */
function renderRow(item: OpenItemRecord, handlers: Partial<RowHandlers> = {}, extra: { readonly selectable?: boolean } = {}): void {
  render(
    <ul>
      <ItemRow
        item={item}
        t={t}
        now={5_000}
        selected={false}
        handlers={{ select: vi.fn(), ...handlers }}
        {...extra}
      />
    </ul>,
  )
}

/** Render the detail pane of one item. */
function renderDetail(item: OpenItemRecord, handlers: Partial<RowHandlers> = {}): void {
  render(
    <ItemDetail
      item={item}
      t={t}
      now={5_000}
      handlers={{ select: vi.fn(), ...handlers }}
      onBack={vi.fn()}
    />,
  )
}

describe('candidate row from the stored raw shape', () => {
  it('renders the projected title, never the markdown', () => {
    renderRow(storedCandidate())
    const title = screen.getByText(PROJECTED_TEXT)
    expect(title).toHaveProperty('title', PROJECTED_TEXT)
    expect(document.body.textContent ?? '').not.toContain('**')
    expect(document.body.textContent ?? '').not.toContain('- **E**')
  })

  it('does not repeat the quote when the normalized title equals it', () => {
    renderRow(storedCandidate())
    // The source sentence is the title, so the blockquote is suppressed and the
    // evidence line says where it came from.
    expect(screen.queryByText(PROJECTED_TEXT, { selector: 'blockquote' })).toBeNull()
    expect(document.querySelector('blockquote')).toBeNull()
    expect(screen.getByText(t('candidate.source.matched'))).toBeTruthy()
  })

  it('labels the kind as inferred, not as a fact', () => {
    renderRow(storedCandidate())
    expect(screen.getByText(t('candidate.kind.inferredLabel', { kind: 'Question' }))).toBeTruthy()
  })

  it('keeps the checkbox and selection announcements in plain text', () => {
    renderRow(storedCandidate(), {}, { selectable: true })
    expect(screen.getByRole('checkbox', { name: t('candidate.bulk.select', { title: PROJECTED_TEXT }) })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('a11y.selectItem', { title: PROJECTED_TEXT }) })).toBeTruthy()
  })

  it('renders a distinct quote once and keeps its inline shape', () => {
    renderRow(storedCandidate({
      title: 'Two ways to ship one change',
      quote: '- **E** — Ship together as one PR/branch or two?',
    }))
    const quote = document.querySelector('blockquote')
    expect(quote?.textContent).toBe('E — Ship together as one PR/branch or two?')
    expect(quote?.textContent).not.toContain('**')
  })

  it('annotates candidates from the same turn with their sibling count', () => {
    render(
      <ul>
        <ItemRow
          item={storedCandidate({ id: 'candidate-a' })}
          t={t}
          now={5_000}
          selected={false}
          handlers={{ select: vi.fn() }}
          sameTurnCount={5}
        />
      </ul>,
    )
    expect(screen.getByText(t('candidate.evidence.siblings', { count: 5, turn: 2 }))).toBeTruthy()
  })
})

describe('a five-decision turn', () => {
  it('renders five distinct rows with distinct projected titles', () => {
    const labels = ['A', 'B', 'C', 'D', 'E']
    const items = labels.map((label, index) => storedCandidate({
      id: `candidate-${label}`,
      title: `- **${label}** — Decision ${String(index + 1)}`,
      quote: `- **${label}** — Decision ${String(index + 1)}`,
    }))
    render(
      <ul>
        {items.map(item => (
          <ItemRow key={item.id} item={item} t={t} now={5_000} selected={false} handlers={{ select: vi.fn() }} sameTurnCount={5} />
        ))}
      </ul>,
    )
    for (const label of labels) {
      expect(screen.getByText(`${label} — Decision ${String(labels.indexOf(label) + 1)}`)).toBeTruthy()
    }
    expect(screen.getAllByText(t('candidate.evidence.siblings', { count: 5, turn: 2 }))).toHaveLength(5)
  })
})

describe('a promoted prose item', () => {
  /** The same record after the confirm write: structural, chosen kind/title. */
  function promoted(): OpenItemRecord {
    return storedCandidate({
      tier: 'structural',
      severity: 2,
      kind: 'decision',
      title: PROJECTED_TEXT,
      quote: PROJECTED_TEXT,
      options: ['(a) One PR/branch', '(b) Two PRs'],
      reply: {
        controls: ['option', 'text'],
        options: ['(a) One PR/branch', '(b) Two PRs'],
        freeText: true,
        requiresConfirm: false,
      },
    })
  }

  it('never renders the detector body or the candidate section', () => {
    renderDetail(promoted(), {
      answer: vi.fn(),
      canAnswer: () => true,
      planFor: () => settlePlan,
    })
    expect(document.body.textContent ?? '').not.toContain(DETECTOR_BODY)
    expect(screen.queryByText(t('candidate.heading'))).toBeNull()
    expect(screen.queryByText(t('candidate.suppress.title'))).toBeNull()
  })

  it('keeps the source quote as context and is answerable with its options', () => {
    renderDetail(promoted(), {
      answer: vi.fn(),
      canAnswer: () => true,
      planFor: () => settlePlan,
    })
    expect(screen.getByText(t('candidate.promoted.source'))).toBeTruthy()
    expect(document.querySelector('blockquote')?.textContent).toBe(PROJECTED_TEXT)
    const group = screen.getByRole('radiogroup', { name: t('answer.options.aria') })
    expect(group).toBeTruthy()
    expect(screen.getByRole('radio', { name: '(a) One PR/branch' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: '(b) Two PRs' })).toBeTruthy()
  })
})

describe('other candidate detectors', () => {
  it('keeps the unfinished-plan aggregate body and does not attribute it to the prose check', () => {
    const todoCandidate = storedCandidate({
      id: 'todo-candidate',
      kind: 'follow-up',
      tier: 'candidate',
      severity: 3,
      title: 'Plan left unfinished (2 items)',
      quote: 'first plan item',
      body: '• first plan item\n• second plan item\nThe session ended with plan items not completed.',
      detectedBy: ['projection'],
      history: [{ at: 1_000, action: 'raised', detail: 'todo-gate:unfinished-plan' }],
    })
    renderDetail(todoCandidate)
    // The body carries the real content for this detector: it must stay visible.
    expect(document.body.textContent ?? '').toContain('first plan item')
    expect(document.body.textContent ?? '').toContain('second plan item')
    // Only the end-of-turn prose check is labelled as an inferred guess, and
    // only it claims the prose gate as its evidence.
    expect(screen.queryByText(t('candidate.kind.inferredLabel', { kind: 'Follow-up' }))).toBeNull()
    expect(screen.queryByText(t('candidate.evidence.detail'))).toBeNull()
  })
})
