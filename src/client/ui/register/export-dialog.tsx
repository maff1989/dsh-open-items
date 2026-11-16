/**
 * The export dialog of the Resolved tab (UI.md §4.5).
 *
 * One step, not a modal chain: format, the two inclusion options, the honest
 * summary of what will be in the file, and the deterministic note. The surface
 * is the shipped `Modal` (mask, focus trap, Escape, frame clearance) with the
 * shipped `SegmentedControl` for the exclusive format and `Checkbox` for the two
 * inclusion flags (S-03/S-09). It renders whatever the parent's download attempt
 * reported — success names the file and its size, failure says why — because the
 * generators are byte-deterministic and a partial file must never be presented
 * as complete.
 *
 * @module dsh-open-items/client/ui/register/export-dialog
 */
import { useState, type ReactNode } from 'react'
import { Button, Checkbox, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ExportFormat } from '../../../shared/export'
import type { RegisterDownloadResult } from '../../data/register-store'
import type { PageTranslate } from '../../format'

/** The options the dialog collects; the parent adds the frozen header fields. */
export interface ExportDialogSelection {
  readonly format: ExportFormat
  readonly includeExcerpts: boolean
  readonly includeArchive: boolean
}

/** Props of the export dialog. */
export interface ExportDialogProps {
  readonly t: PageTranslate
  /** Records the export will contain (as the header will state it). */
  readonly recordCount: number
  /** Human description of the active filter. */
  readonly filterLabel: string
  /** Answers waiting on a session: they cannot be exported until acknowledged. */
  readonly inFlight: number
  /** A retention cap pruned older rows; the file will say so. */
  readonly earlierRecordsPruned: boolean
  /** Default of the "include archived records" box (true in the Archive period). */
  readonly defaultIncludeArchive: boolean
  /** Default of the "include transcript excerpts" box. */
  readonly defaultIncludeExcerpts?: boolean
  readonly busy: boolean
  readonly result?: RegisterDownloadResult
  readonly onCancel: () => void
  readonly onSubmit: (selection: ExportDialogSelection) => void
}

/** Format options in the dialog's order; labels come from the dictionary. */
const FORMATS: readonly ExportFormat[] = ['csv', 'jsonl', 'html']

/** Label key of one export format. */
function formatKey(format: ExportFormat): 'export.format.csv' | 'export.format.jsonl' | 'export.format.html' {
  return format === 'csv' ? 'export.format.csv' : format === 'jsonl' ? 'export.format.jsonl' : 'export.format.html'
}

/** Human size of a byte count, in KB with one decimal below 10 KB. */
function sizeLabel(byteLength: number): string {
  const kilobytes = byteLength / 1024
  return kilobytes < 10 ? kilobytes.toFixed(1) : String(Math.round(kilobytes))
}

/**
 * Render the export dialog.
 * @param props - copy, counts and the submit/cancel seams.
 * @returns the dialog element.
 */
export function ExportDialog(props: ExportDialogProps): ReactNode {
  const { t, busy, result } = props
  const [format, setFormat] = useState<ExportFormat>('html')
  const [includeExcerpts, setIncludeExcerpts] = useState(props.defaultIncludeExcerpts ?? true)
  const [includeArchive, setIncludeArchive] = useState(props.defaultIncludeArchive)

  const submit = (): void => {
    props.onSubmit({ format, includeExcerpts, includeArchive })
  }
  const formatOptions = FORMATS.map(candidate => ({ value: candidate, label: t(formatKey(candidate)) }))

  return (
    <Modal
      open
      onClose={props.onCancel}
      title={t('export.title')}
      closeLabel={t('export.cancel')}
      description={t('export.summary', { count: props.recordCount, filter: props.filterLabel })}
      footer={(
        <>
          <Button size="sm" variant="outline" onClick={props.onCancel}>
            {result?.ok === true ? t('export.close') : t('export.cancel')}
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={submit}>
            {busy ? t('export.busy') : t('export.submit', { format })}
          </Button>
        </>
      )}
    >
      <p className="dsh-oi-dialogLegend">{t('export.format')}</p>
      <SegmentedControl
        id="dsh-oi-export-format"
        value={format}
        options={formatOptions}
        onChange={setFormat}
        label={t('export.format')}
      />
      <Checkbox
        checked={includeExcerpts}
        onChange={setIncludeExcerpts}
        label={t('export.includeExcerpts')}
        className="dsh-oi-dialogCheck"
      />
      <Checkbox
        checked={includeArchive}
        onChange={setIncludeArchive}
        label={t('export.includeArchive')}
        className="dsh-oi-dialogCheck"
      />
      {props.inFlight > 0 && <p className="dsh-oi-dialogNote">{t('export.inFlightNote', { count: props.inFlight })}</p>}
      {props.earlierRecordsPruned && <p className="dsh-oi-dialogNote">{t('export.prunedNote')}</p>}
      <p className="dsh-oi-dialogNote dsh-oi-dialogNote--deterministic">{t('export.deterministic')}</p>
      {result !== undefined && (result.ok
        ? (
          <p className="dsh-oi-dialogResult dsh-oi-dialogResult--ok" role="status">
            {t('export.ok', { filename: result.filename, size: sizeLabel(result.byteLength) })}
          </p>
        )
        : (
          <p className="dsh-oi-dialogResult dsh-oi-dialogResult--error" role="alert">
            {t('export.error', { message: result.error })}
          </p>
        ))}
    </Modal>
  )
}
