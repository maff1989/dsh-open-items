/**
 * JSONL export: header line + one full record per line with a fixed key order,
 * LF endings, `schemaVersion` per line, and an architecture-independent body
 * (the record is re-importable).
 */
import { describe, expect, it } from 'vitest'

import {
  JSONL_HEADER_KEYS,
  JSONL_RECORD_KEYS,
  exportChunks,
  generateExport,
  jsonlHeaderLine,
  jsonlRecordLine,
  selectExportRecords,
  toJsonl,
} from '../../src/shared/export'
import { fixedOptions, fixtureRecords, FIXED_FILTER_LABEL, nonExportableRecords } from './fixtures'
import { firstDifference, lineCount, matchGolden } from './helpers'

/** Split a JSONL file into parsed values (one per non-empty line). */
function linesOf(records = fixtureRecords(), overrides = {}): unknown[] {
  const text = toJsonl(records, fixedOptions({ format: 'jsonl', ...overrides }))
  return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as unknown)
}

/** Parse the record lines only (skips the header line). */
function recordLines(records = fixtureRecords(), overrides = {}): Record<string, unknown>[] {
  return linesOf(records, overrides).slice(1) as Record<string, unknown>[]
}

describe('toJsonl', () => {
  it('matches the golden file byte-for-byte', () => {
    const actual = toJsonl(fixtureRecords(), fixedOptions({ format: 'jsonl' }))
    const golden = matchGolden('register.jsonl', actual)
    expect(actual, `JSONL differs from golden at offset ${String(firstDifference(actual, golden))}`).toBe(golden)
  })

  it('writes one header line and one line per resolution, LF-terminated', () => {
    const text = toJsonl(fixtureRecords(), fixedOptions({ format: 'jsonl' }))
    expect(text.endsWith('\n')).toBe(true)
    expect(text.includes('\r')).toBe(false)
    expect(lineCount(text)).toBe(1 + 6)
    // Every line parses on its own.
    for (const line of text.split('\n').slice(0, -1)) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('starts with a self-describing header line in fixed key order', () => {
    const [header] = linesOf() as [Record<string, unknown>]
    expect(Object.keys(header)).toEqual([...JSONL_HEADER_KEYS])
    expect(header['type']).toBe('export-header')
    expect(header['exportSchemaVersion']).toBe(1)
    expect(header['schemaVersion']).toBe(3)
    expect(header['pluginVersion']).toBe('0.1.0')
    expect(header['generatedAt']).toBe('2026-11-13T23:45:00.000Z')
    expect(header['filterLabel']).toBe(FIXED_FILTER_LABEL)
    expect(header['recordCount']).toBe(6)
    expect(header['earlierRecordsPruned']).toBe(false)
    expect(header['includeArchive']).toBe(false)
    expect(header['includeExcerpts']).toBe(true)
    expect(header['archivedIncluded']).toBe(0)
    expect(header['archivedExcluded']).toBe(1)
  })

  it('keeps the fixed record key order and schemaVersion on every line', () => {
    const lines = recordLines()
    expect(lines).toHaveLength(6)
    const first = lines[0]
    expect(first).toBeDefined()
    expect(Object.keys(first ?? {})).toEqual([
      'type', 'exportSchemaVersion', 'schemaVersion', 'id', 'origin', 'kind', 'state', 'tier',
      'severity', 'title', 'body', 'quote', 'source', 'blocking', 'reply', 'deliveries',
      'occurrences', 'dedupeKey', 'detectedBy', 'firstSeenAt', 'lastSeenAt', 'updatedAt',
      'version', 'resolution', 'acknowledgement', 'resolvedAt', 'reopenCount', 'retention', 'history',
    ])
    for (const line of lines) {
      expect(Object.keys(line)).toEqual(JSONL_RECORD_KEYS.filter(key => Object.hasOwn(line, key)))
      expect(line['exportSchemaVersion']).toBe(1)
      expect(line['schemaVersion']).toBe(3)
      expect(line['type']).toBe('register-entry')
    }
  })

  it('round-trips a line without changing it', () => {
    for (const line of toJsonl(fixtureRecords(), fixedOptions({ format: 'jsonl' })).split('\n').slice(0, -1)) {
      expect(JSON.stringify(JSON.parse(line))).toBe(line)
    }
  })

  it('carries the full record, including replays and evidence', () => {
    const lines = recordLines()
    const reopened = lines.find(line => line['id'] === 'item-0004-auto')
    expect(reopened).toBeDefined()
    expect(reopened?.['reopenCount']).toBe(1)
    expect(reopened?.['resolutionLog']).toHaveLength(2)
    expect(reopened?.['resolution']).toMatchObject({ kind: 'detected-closed', actor: 'detector' })
    expect(reopened?.['acknowledgement']).toEqual({ state: 'observed' })
    const delivered = lines.find(line => line['id'] === 'item-0001-approval')
    expect(delivered?.['deliveries']).toHaveLength(1)
    expect(delivered?.['resolution']).toMatchObject({ deliveryId: '0199a0c3-4b2e-7c11-8f01-2b3c4d5e6f70' })
  })

  it('omits body and quote when excerpts are excluded, and says so in the header', () => {
    const excluded = toJsonl(fixtureRecords(), fixedOptions({ format: 'jsonl', includeExcerpts: false }))
    const [header, ...records] = linesOf(fixtureRecords(), { includeExcerpts: false }) as [
      Record<string, unknown>,
      ...Record<string, unknown>[],
    ]
    expect(header['includeExcerpts']).toBe(false)
    for (const record of records) {
      expect(Object.hasOwn(record, 'body')).toBe(false)
      expect(Object.hasOwn(record, 'quote')).toBe(false)
    }
    expect(excluded).not.toContain('The agent asked for one sandbox escalation')
    // Excluding text must not change the facts that identify the record.
    expect(records[0]?.['id']).toBe('item-0001-approval')
    expect(records[0]?.['resolution']).toBeDefined()
  })

  it('orders by resolvedAt descending then item id ascending', () => {
    const ids = recordLines().map(line => line['id'])
    expect(ids).toEqual([
      'item-0001-approval',
      'item-0002-question',
      'item-0003-candidate',
      'item-0004-auto',
      'item-0005-superseded',
      'item-0006-tie',
    ])
  })

  it('is independent of the input order', () => {
    const forward = toJsonl(fixtureRecords(), fixedOptions({ format: 'jsonl' }))
    const reversed = toJsonl([...fixtureRecords()].reverse(), fixedOptions({ format: 'jsonl' }))
    expect(reversed).toBe(forward)
  })

  it('includes archived records only on request, and updates the header counts', () => {
    const [header, ...records] = linesOf(fixtureRecords(), { includeArchive: true }) as [
      Record<string, unknown>,
      ...Record<string, unknown>[],
    ]
    expect(header['includeArchive']).toBe(true)
    expect(header['recordCount']).toBe(7)
    expect(header['archivedIncluded']).toBe(1)
    expect(records.map(record => record['id'])).toContain('item-0007-archived')
  })

  it('excludes records that are not resolved or were deleted forever', () => {
    const ids = recordLines([...fixtureRecords(), ...nonExportableRecords()]).map(line => line['id'])
    expect(ids).toHaveLength(6)
    expect(ids).not.toContain('item-9001-still-open')
    expect(ids).not.toContain('item-9002-deleted')
    expect(ids).not.toContain('item-9003-no-resolution')
    expect(ids).not.toContain('item-9004-snoozed')
  })

  it('writes only a header line for an empty result set', () => {
    const text = toJsonl([], fixedOptions({ format: 'jsonl' }))
    expect(lineCount(text)).toBe(1)
    const [header] = linesOf([]) as [Record<string, unknown>]
    expect(header['recordCount']).toBe(0)
  })

  it('records the pruned flag honestly', () => {
    const [header] = linesOf(fixtureRecords(), { earlierRecordsPruned: true }) as [Record<string, unknown>]
    expect(header['earlierRecordsPruned']).toBe(true)
  })

  it('exposes the line builders used by the streaming path', () => {
    const options = fixedOptions({ format: 'jsonl' })
    const selection = selectExportRecords(fixtureRecords(), options)
    const chunks = exportChunks(fixtureRecords(), options).chunks
    expect(chunks).toHaveLength(1 + selection.records.length)
    expect(chunks[0]).toBe(`${jsonlHeaderLine(selection, options)}\n`)
    for (const [index, record] of selection.records.entries()) {
      expect(chunks[index + 1]).toBe(`${jsonlRecordLine(record, options)}\n`)
    }
  })
})

describe('generateExport for jsonl', () => {
  it('reports the byte length of the content it returns', () => {
    const file = generateExport(fixtureRecords(), fixedOptions({ format: 'jsonl' }))
    expect(file.byteLength).toBe(Buffer.byteLength(file.content, 'utf8'))
    expect(file.mimeType).toBe('application/x-ndjson;charset=utf-8')
    expect(file.filename).toBe('open-items-20261113T224100Z-6-30-days-all-sources.jsonl')
  })
})
