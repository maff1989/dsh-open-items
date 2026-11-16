/**
 * One-time P0 document migration (PLAN M1 item 2).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { OpenItemsStore } from '../src/host/store'
import { createFakeDomain, fakeContext, type FakeDomain } from './fake-domain'

const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '.tmp-migration')
let caseDirectory: string
let legacyPath: string
let clockNow: number

beforeEach(async () => {
  await mkdir(TEST_ROOT, { recursive: true })
  caseDirectory = await mkdtemp(join(TEST_ROOT, 'migration-'))
  legacyPath = join(caseDirectory, 'store.json')
  clockNow = 5_000
})

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true })
})

/** A valid P0 v2 document with one open, one answered, one dismissed item. */
function p0Document(): unknown {
  return {
    schemaVersion: 2,
    revision: 7,
    updatedAt: 4_000,
    items: [
      {
        id: '018f0a3e-7b1c-7c2d-8a9b-0c1d2e3f4a01',
        fingerprint: 'aaaaaaaaaaaaaaaa',
        kind: 'decision',
        status: 'open',
        title: 'Ship the migration before Friday?',
        detail: 'The user has not picked a rollout window.',
        sessionId: 'session-1',
        createdAt: 1_000,
        updatedAt: 1_000,
        reopenCount: 0,
        history: [{ at: 1_000, action: 'raised' }],
      },
      {
        id: '018f0a3e-7b1c-7c2d-8a9b-0c1d2e3f4a02',
        fingerprint: 'bbbbbbbbbbbbbbbb',
        kind: 'question',
        status: 'answered',
        title: 'Which environment?',
        sessionId: 'session-1',
        answer: 'staging',
        createdAt: 1_000,
        updatedAt: 2_000,
        answeredAt: 2_000,
        reopenCount: 0,
        history: [
          { at: 1_000, action: 'raised' },
          { at: 2_000, action: 'answered', detail: 'staging' },
        ],
      },
      {
        id: '018f0a3e-7b1c-7c2d-8a9b-0c1d2e3f4a03',
        fingerprint: 'cccccccccccccccc',
        kind: 'uncertainty',
        status: 'dismissed',
        title: 'Is the cache warm?',
        sessionId: 'session-2',
        dismissReason: 'irrelevant now',
        createdAt: 1_000,
        updatedAt: 3_000,
        dismissedAt: 3_000,
        reopenCount: 1,
        history: [
          { at: 1_000, action: 'raised' },
          { at: 2_500, action: 'reopened' },
          { at: 3_000, action: 'dismissed', detail: 'irrelevant now' },
        ],
      },
    ],
  }
}

/** Open a store over the legacy document. */
async function openWithMigration(): Promise<{ store: OpenItemsStore; domain: FakeDomain }> {
  const domain = createFakeDomain()
  const store = await OpenItemsStore.open(fakeContext(domain), {
    now: () => clockNow,
    legacyStorePath: legacyPath,
  })
  return { store, domain }
}

describe('P0 document migration', () => {
  it('imports every item with v3 semantics and renames the document aside', async () => {
    await writeFile(legacyPath, JSON.stringify(p0Document()), 'utf8')
    const { store } = await openWithMigration()

    expect(store.migration).toMatchObject({ found: true, imported: 3, skipped: 0 })
    expect(store.migration?.migratedPath).toBe(`${legacyPath}.migrated`)
    expect(store.all()).toHaveLength(3)

    const open = store.get('018f0a3e-7b1c-7c2d-8a9b-0c1d2e3f4a01')!
    expect(open).toMatchObject({ schemaVersion: 3, kind: 'decision', state: 'open', severity: 2, tier: 'structural' })
    expect(open.body).toBe('The user has not picked a rollout window.')
    expect(open.source.sessionId).toBe('session-1')
    expect(open.detectedBy).toEqual(['tool'])
    expect(open.history.map(entry => entry.action)).toEqual(['raised'])

    const answered = store.get('018f0a3e-7b1c-7c2d-8a9b-0c1d2e3f4a02')!
    expect(answered.state).toBe('resolved')
    expect(answered.resolution).toMatchObject({
      kind: 'answered',
      actor: 'user',
      payload: { type: 'text', text: 'staging' },
    })
    expect(answered.acknowledgement).toEqual({ state: 'none' })

    const dismissed = store.get('018f0a3e-7b1c-7c2d-8a9b-0c1d2e3f4a03')!
    expect(dismissed.kind).toBe('risk')
    expect(dismissed.state).toBe('resolved')
    expect(dismissed.reopenCount).toBe(1)
    expect(dismissed.resolution).toMatchObject({
      kind: 'dismissed',
      payload: { type: 'dismiss', reason: 'irrelevant now' },
    })

    expect(await readFile(`${legacyPath}.migrated`, 'utf8')).toContain('Ship the migration before Friday?')
    await expect(readFile(legacyPath, 'utf8')).rejects.toThrow()
  })

  it('is idempotent: re-importing the same document stores nothing twice', async () => {
    await writeFile(legacyPath, JSON.stringify(p0Document()), 'utf8')
    const domain = createFakeDomain()
    const first = await OpenItemsStore.open(fakeContext(domain), { now: () => clockNow, legacyStorePath: legacyPath })
    expect(first.migration?.imported).toBe(3)
    await first.close()

    // Simulate a recovered/restored document: same ids, fresh file.
    await writeFile(legacyPath, JSON.stringify(p0Document()), 'utf8')
    const second = await OpenItemsStore.open(fakeContext(domain), { now: () => clockNow, legacyStorePath: legacyPath })
    expect(second.migration).toMatchObject({ found: true, imported: 0, skipped: 3 })
    expect(second.all()).toHaveLength(3)
  })

  it('quarantines an unreadable document instead of failing activation', async () => {
    await writeFile(legacyPath, '{ not json', 'utf8')
    const { store } = await openWithMigration()
    expect(store.all()).toHaveLength(0)
    expect(store.migration?.quarantinedPath).toContain('.corrupt-')
    expect(await readFile(store.migration!.quarantinedPath!, 'utf8')).toBe('{ not json')
    // The domain still works after the failed import.
    await store.create({ kind: 'decision', title: 'Fresh start?', sessionId: 's' })
    expect(store.countLive()).toBe(1)
  })

  it('does nothing when there is no legacy document', async () => {
    const { store } = await openWithMigration()
    expect(store.migration).toEqual({ found: false, imported: 0, skipped: 0 })
    expect(store.all()).toHaveLength(0)
  })
})
