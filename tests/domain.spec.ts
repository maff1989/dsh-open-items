/**
 * The durable contract: domain declaration, record validators, identity keys
 * and defaults (PLAN M1 items 1/3; DESIGN §3.5, §7.1).
 */
import { describe, expect, it } from 'vitest'

import { INSTALL_META_KEY, OPEN_ITEMS_DOMAIN_NAME, OPEN_ITEMS_DOMAIN_VERSION, openItemsDomain } from '../src/host/domain'
import {
  InvalidRecordError,
  appendHistory,
  authoredDedupeKey,
  defaultReply,
  derivedDedupeKey,
  parseDetectionCursor,
  parseItemRecord,
} from '../src/shared/records'
import { makeItem } from './fixtures'

describe('domain declaration', () => {
  it('is the per-record, backup-and-skip v1 domain the design specifies', () => {
    expect(openItemsDomain.name).toBe(OPEN_ITEMS_DOMAIN_NAME)
    expect(openItemsDomain.name).toBe('open_items')
    expect(openItemsDomain.version).toBe(OPEN_ITEMS_DOMAIN_VERSION)
    expect(openItemsDomain.version).toBe(1)
    expect(openItemsDomain.layout).toBe('per-record')
    expect(openItemsDomain.invalidRecords).toBe('backup-and-skip')
    expect(Object.keys(openItemsDomain.tables).sort()).toEqual(['cursors', 'items', 'meta', 'suppressors'])
    expect(INSTALL_META_KEY).toBe('install')
  })

  it('declares record schemas that accept a valid record and reject a corrupt one', () => {
    const valid = makeItem({ id: 'item-a' })
    expect(openItemsDomain.tables.items!.valueSchema.parse(JSON.parse(JSON.stringify(valid)))).toMatchObject({
      id: 'item-a',
      state: 'open',
    })
    expect(() => openItemsDomain.tables.items!.valueSchema.parse({ id: 'broken' })).toThrow(InvalidRecordError)
  })

  it('validates detection cursors (the capture branch writes them)', () => {
    const cursor = parseDetectionCursor({
      sessionId: 'session-1',
      lastScannedSeq: 12,
      lastEventTime: 1_000,
      lastScanAt: 2_000,
      foldVersion: 1,
    })
    expect(cursor.lastScannedSeq).toBe(12)
    expect(() => parseDetectionCursor({ sessionId: 'x' })).toThrow(InvalidRecordError)
  })
})

describe('record semantics', () => {
  it('rejects status/resolution incoherence at the durable boundary', () => {
    expect(() => parseItemRecord(makeItem({ state: 'resolved' }))).toThrow(/resolution/u)
    expect(() => parseItemRecord(makeItem({ state: 'awaiting' }))).toThrow(/acknowledgement/u)
    expect(() => parseItemRecord(makeItem({ schemaVersion: 2 as unknown as 3 }))).toThrow(/schema version/u)
  })

  it('keeps the per-item history bounded', () => {
    let history = makeItem().history
    for (let index = 0; index < 80; index += 1) history = appendHistory(history, 1_000 + index, 're-raised')
    expect(history).toHaveLength(50)
    expect(history.at(-1)?.at).toBe(1_079)
    expect(history.at(0)?.at).toBe(1_030)
  })

  it('derives stable dedupe keys: authored by folded title, derived by artifact', () => {
    expect(authoredDedupeKey({ kind: 'decision', sessionId: 's1', title: 'Ship  Friday?' }))
      .toBe(authoredDedupeKey({ kind: 'decision', sessionId: 's1', title: 'ship friday?' }))
    expect(authoredDedupeKey({ kind: 'decision', sessionId: 's1', title: 'Ship Friday?' }))
      .not.toBe(authoredDedupeKey({ kind: 'decision', sessionId: 's2', title: 'Ship Friday?' }))
    expect(derivedDedupeKey({ kind: 'approval', sessionId: 's1', artifactId: 'call_9' }))
      .toBe('derived|approval|s1|call_9')
  })

  it('gives every kind a reply surface the inbox can render', () => {
    expect(defaultReply('approval').controls).toEqual(['approve', 'deny'])
    expect(defaultReply('question', ['yes', 'no']).options).toEqual(['yes', 'no'])
    expect(defaultReply('task').controls).toContain('task-action')
    expect(defaultReply('risk').freeText).toBe(true)
  })
})
