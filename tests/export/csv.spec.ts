/**
 * CSV export: fixed column order, RFC 4180-ish quoting, formula neutralization,
 * LF endings, honest header comment, stable ordering and the archive/excerpt
 * options.
 *
 * The golden comparison is the determinism lock; the rest of the file explains
 * and defends the contract a reader of the file relies on.
 */
import { describe, expect, it } from 'vitest'

import {
  CSV_COLUMNS,
  csvCell,
  csvHeaderComment,
  exportFileName,
  generateExport,
  selectExportRecords,
  toCsv,
  csvRows,
} from '../../src/shared/export'
import {
  fixedOptions,
  fixtureRecords,
  FIXED_FILTER_LABEL,
  FIXED_GENERATED_AT,
  nonExportableRecords,
} from './fixtures'
import { firstDifference, lineCount, matchGolden, parseCsv } from './helpers'

/** Data rows of a CSV export, without the comment and column rows. */
function dataRows(records = fixtureRecords(), overrides = {}) {
  const text = toCsv(records, fixedOptions({ format: 'csv', ...overrides }))
  return parseCsv(text).slice(2)
}

describe('toCsv', () => {
  it('matches the golden file byte-for-byte', () => {
    const actual = toCsv(fixtureRecords(), fixedOptions({ format: 'csv' }))
    const golden = matchGolden('register.csv', actual)
    expect(actual, `CSV differs from golden at offset ${String(firstDifference(actual, golden))}`).toBe(golden)
  })

  it('puts one comment row, one column row and one row per resolution', () => {
    const text = toCsv(fixtureRecords(), fixedOptions({ format: 'csv' }))
    const rows = parseCsv(text)
    expect(rows[0]?.[0]).toMatch(/^# dsh-open-items register export/)
    expect(rows[1]).toEqual([...CSV_COLUMNS])
    expect(rows).toHaveLength(2 + 6)
    // LF-only, trailing LF, and a physical line count above the row count is
    // expected: embedded newlines stay inside quoted cells.
    expect(text.endsWith('\n')).toBe(true)
    expect(text.includes('\r')).toBe(false)
    expect(lineCount(text)).toBeGreaterThan(2 + 6)
  })

  it('documents itself in the header comment', () => {
    const text = toCsv(fixtureRecords(), fixedOptions({ format: 'csv' }))
    const header = parseCsv(text)[0]?.[0] ?? ''
    expect(header).toContain('exportSchema=1')
    expect(header).toContain('storeSchema=3')
    expect(header).toContain('plugin=0.1.0')
    expect(header).toContain('generatedAt=2026-11-13T23:45:00.000Z')
    expect(header).toContain(`filter='${FIXED_FILTER_LABEL}'`)
    // The comment row must not contain a double quote a CSV reader could treat
    // as an opening quote.
    expect(header.includes('"')).toBe(false)
    expect(header).toContain('records=6')
    expect(header).toContain('excerpts-included')
    expect(header).toContain('nothing-pruned')
    expect(header).toContain(`columns=${CSV_COLUMNS.join('|')}`)
    // The comment row is exactly one cell even for a reader that parses it.
    expect(parseCsv(text)[0]).toHaveLength(1)
    // The comment must survive a reader that strips `#` lines.
    expect(header.startsWith('#')).toBe(true)
  })

  it('writes ISO-8601 UTC timestamps in the resolvedAt column', () => {
    for (const row of dataRows()) {
      expect(row[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
    expect(parseCsv(toCsv(fixtureRecords(), fixedOptions({ format: 'csv' })))[2]?.[0])
      .toBe('2026-11-13T22:41:00.000Z')
  })

  it('orders by resolvedAt descending then item id ascending', () => {
    const ids = dataRows().map(row => row[3])
    expect(ids).toEqual([
      'item-0001-approval',
      'item-0002-question',
      'item-0003-candidate',
      'item-0004-auto',
      // Same resolvedAt: the lower id sorts first.
      'item-0005-superseded',
      'item-0006-tie',
    ])
  })

  it('is independent of the input order', () => {
    const forward = toCsv(fixtureRecords(), fixedOptions({ format: 'csv' }))
    const reversed = toCsv([...fixtureRecords()].reverse(), fixedOptions({ format: 'csv' }))
    expect(reversed).toBe(forward)
  })

  it('quotes only when needed and doubles embedded quotes', () => {
    const text = toCsv(fixtureRecords(), fixedOptions({ format: 'csv' }))
    // A comma inside a cell is quoted.
    expect(text).toContain('"dismissed — not an item, docs follow-up"')
    // An embedded quote is doubled, and the whole cell is quoted.
    expect(text).toContain('"bash — ""install the corporate registry"""')
    // A plain cell is not quoted.
    expect(text).toContain(',approval,1,answered,')
  })

  it('preserves embedded newlines inside quoted cells', () => {
    const rows = dataRows()
    const questionRow = rows.find(row => row[3] === 'item-0002-question')
    expect(questionRow).toBeDefined()
    expect(questionRow?.[8]).toBe(
      'Yes, before Friday.\nThen verify with =HYPERLINK("http://evil.example","click").',
    )
    expect(questionRow?.[12]).toContain('Line two starts with =cmd|\' /C calc\'!A0')
  })

  it('neutralizes spreadsheet formula injection at the start of a cell', () => {
    const cell = dataRows().find(row => row[3] === 'item-0006-tie')?.[8]
    // The payload began with `=`, so the exported cell is text, not a formula.
    expect(cell).toBe("'=1+1 leave it scroll-only for now.")
    expect(cell?.startsWith('=')).toBe(false)
    // The title keeps its mid-string formula marker (harmless: not cell-leading).
    const title = dataRows().find(row => row[3] === 'item-0002-question')?.[4]
    expect(title).toContain('=HYPERLINK(')
  })

  it('escapes every formula leader a spreadsheet recognizes', () => {
    for (const leader of ['=1+1', '+1+1', '-1+1', '@SUM(A1)', '\tlead']) {
      const escaped = csvCell(leader)
      expect(escaped.startsWith("'"), `leader ${JSON.stringify(leader)} was not neutralized`).toBe(true)
    }
    expect(csvCell('plain text')).toBe('plain text')
    expect(csvCell('')).toBe('')
  })

  it('normalizes CRLF inside a cell to LF so the file stays LF-only', () => {
    const text = csvCell('line one\r\nline two\ronly')
    expect(text).not.toContain('\r')
    expect(text).toBe('"line one\nline two\nonly"')
  })

  it('excludes records that are not resolved, are deleted, or lack a resolution', () => {
    const text = toCsv([...fixtureRecords(), ...nonExportableRecords()], fixedOptions({ format: 'csv' }))
    expect(text).not.toContain('item-9001-still-open')
    expect(text).not.toContain('item-9002-deleted')
    expect(text).not.toContain('item-9003-no-resolution')
    expect(text).not.toContain('item-9004-snoozed')
    expect(dataRows([...fixtureRecords(), ...nonExportableRecords()])).toHaveLength(6)
  })

  it('omits archived records by default and includes them on request', () => {
    const excluded = toCsv(fixtureRecords(), fixedOptions({ format: 'csv' }))
    expect(excluded).not.toContain('item-0007-archived')
    expect(excluded).toContain('archive-excluded(1-omitted)')

    const included = toCsv(fixtureRecords(), fixedOptions({ format: 'csv', includeArchive: true }))
    expect(included).toContain('item-0007-archived')
    expect(included).toContain('archive-included(1-compacted)')
    expect(dataRows(fixtureRecords(), { includeArchive: true })).toHaveLength(7)
  })

  it('leaves the excerpt columns empty when excerpts are excluded', () => {
    const rows = dataRows(fixtureRecords(), { includeExcerpts: false })
    for (const row of rows) {
      expect(row[12]).toBe('')
      expect(row[13]).toBe('')
    }
    const header = parseCsv(toCsv(fixtureRecords(), fixedOptions({ format: 'csv', includeExcerpts: false })))[0]?.[0]
    expect(header).toContain('excerpts-excluded')
  })

  it('publishes a valid empty file for an empty result set', () => {
    const text = toCsv([], fixedOptions({ format: 'csv' }))
    const rows = parseCsv(text)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.[0]).toContain('records=0')
    expect(rows[1]).toEqual([...CSV_COLUMNS])
    expect(text.endsWith('\n')).toBe(true)
  })

  it('says when earlier records were pruned', () => {
    const header = parseCsv(toCsv(fixtureRecords(), fixedOptions({ format: 'csv', earlierRecordsPruned: true })))[0]?.[0]
    expect(header).toContain('earlier-records-pruned')
    expect(header).not.toContain('nothing-pruned')
  })

  it('has a header comment builder and row builder usable on their own', () => {
    const options = fixedOptions({ format: 'csv' })
    const selection = selectExportRecords(fixtureRecords(), options)
    expect(csvHeaderComment(selection, options)).toBe(parseCsv(toCsv(fixtureRecords(), options))[0]?.[0])
    expect(csvHeaderComment(selection, options)).not.toContain('\n')
    expect(csvRows(selection, options)).toHaveLength(selection.records.length)
  })

  it('names the file from the newest resolution, the count and the filter', () => {
    const options = fixedOptions({ format: 'csv' })
    const selection = selectExportRecords(fixtureRecords(), options)
    expect(exportFileName(selection, options)).toBe('open-items-20261113T224100Z-6-30-days-all-sources.csv')
    expect(generateExport(fixtureRecords(), options).filename).toBe(exportFileName(selection, options))
  })

  it('keeps generatedAt out of the record columns', () => {
    const later = fixedOptions({ format: 'csv', generatedAt: FIXED_GENERATED_AT + 86_400_000 })
    const first = toCsv(fixtureRecords(), fixedOptions({ format: 'csv' }))
    const second = toCsv(fixtureRecords(), later)
    // The only difference between two exports of the same filter is the
    // header's generatedAt, which is by design.
    expect(first.replace('2026-11-13T23:45:00.000Z', '2026-11-14T23:45:00.000Z')).toBe(second)
  })
})
