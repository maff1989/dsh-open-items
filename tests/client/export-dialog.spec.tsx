// @vitest-environment jsdom
/**
 * The export dialog (UI.md §4.5): the three formats, the two inclusion options,
 * the deterministic note, the honest in-flight/pruned notes and the
 * success/failure result — the dialog collects, the parent exports.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./primitives-mock'))
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { ExportDialog, type ExportDialogProps } from '../../src/client/ui/register/export-dialog'
import { t } from './fixtures'

afterEach(cleanup)

/** Render the dialog with spies. */
function renderDialog(overrides: Partial<ExportDialogProps> = {}): { onSubmit: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  const props: ExportDialogProps = {
    t,
    recordCount: 24,
    filterLabel: '30 days · By you',
    inFlight: 0,
    earlierRecordsPruned: false,
    defaultIncludeArchive: false,
    busy: false,
    onCancel,
    onSubmit,
    ...overrides,
  }
  render(<ExportDialog {...props} />)
  return { onSubmit, onCancel }
}

/** The dialog region. */
function dialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Export results' })
}

describe('export dialog: content', () => {
  it('states the record count and the current filter', () => {
    renderDialog()
    expect(within(dialog()).getByText('24 records · filtered to: 30 days · By you')).toBeTruthy()
  })

  it('offers exactly the three formats with the reader-facing descriptions', () => {
    renderDialog()
    expect(within(dialog()).getByRole('tablist', { name: 'Format' })).toBeTruthy()
    const tabs = within(dialog()).getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(within(dialog()).getByRole('tab', { name: /CSV — one row per decision/u })).toBeTruthy()
    expect(within(dialog()).getByRole('tab', { name: /JSONL — full records, re-importable/u })).toBeTruthy()
    expect(within(dialog()).getByRole('tab', { name: /HTML — self-contained page, shareable/u })).toBeTruthy()
    // HTML is the default: the human-readable snapshot is the common case.
    expect(within(dialog()).getByRole('tab', { name: /HTML/u }).getAttribute('aria-selected')).toBe('true')
  })

  it('defaults excerpts on, archive off unless the caller says otherwise', () => {
    renderDialog()
    expect((screen.getByRole('checkbox', { name: /Include transcript excerpts/u }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: /Include archived records/u }) as HTMLInputElement).checked).toBe(false)
    cleanup()
    renderDialog({ defaultIncludeArchive: true })
    expect((screen.getByRole('checkbox', { name: /Include archived records/u }) as HTMLInputElement).checked).toBe(true)
  })

  it('carries the deterministic promise', () => {
    renderDialog()
    expect(within(dialog()).getByText('Deterministic: the same filter exports the same file.')).toBeTruthy()
  })

  it('warns that in-flight answers cannot be exported yet', () => {
    renderDialog({ inFlight: 2 })
    expect(within(dialog()).getByText(/2 in flight: an answer is not exported until the session acknowledges it/u)).toBeTruthy()
  })

  it('warns when the retention cap pruned earlier records', () => {
    renderDialog({ earlierRecordsPruned: true })
    expect(within(dialog()).getByText(/Earlier records were pruned by the retention cap/u)).toBeTruthy()
  })
})

describe('export dialog: submit', () => {
  it('submits the chosen format and options', () => {
    const { onSubmit } = renderDialog()
    fireEvent.click(within(dialog()).getByRole('tab', { name: /JSONL/u }))
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: /Include transcript excerpts/u }))
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: /Include archived records/u }))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Export .jsonl' }))
    expect(onSubmit).toHaveBeenCalledWith({ format: 'jsonl', includeExcerpts: false, includeArchive: true })
  })

  it('names the button after the selected format', () => {
    renderDialog()
    expect(within(dialog()).getByRole('button', { name: 'Export .html' })).toBeTruthy()
    fireEvent.click(within(dialog()).getByRole('tab', { name: /CSV/u }))
    expect(within(dialog()).getByRole('button', { name: 'Export .csv' })).toBeTruthy()
  })

  it('disables the export while one is running', () => {
    renderDialog({ busy: true })
    const submit = within(dialog()).getByRole('button', { name: 'Exporting…' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
  })

  it('cancels and closes', () => {
    const { onCancel } = renderDialog()
    fireEvent.click(within(dialog()).getAllByRole('button', { name: 'Cancel' }).at(-1) as HTMLElement)
    expect(onCancel).toHaveBeenCalled()
    // Escape-to-close belongs to the shipped Modal, which the mock does not
    // emulate; the primitive's own suite owns that behaviour.
  })
})

describe('export dialog: result', () => {
  it('reports the saved file and its size, with Close as the exit', () => {
    const { onCancel } = renderDialog({ result: { ok: true, filename: 'open-items-abc.html', byteLength: 12_288 } })
    expect(within(dialog()).getByRole('status').textContent).toContain('Saved open-items-abc.html (12 KB)')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('reports a failure with its reason and keeps Export available for a retry', () => {
    renderDialog({ result: { ok: false, error: 'download-unavailable' } })
    expect(within(dialog()).getByRole('alert').textContent).toContain('Export failed: download-unavailable')
    expect(within(dialog()).getByRole('button', { name: 'Export .html' })).toBeTruthy()
  })
})
