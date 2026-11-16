/**
 * The browser wrapper: it must hand the generator's chunks to one Blob, click a
 * single anchor, release the object URL, and report failure as a value. The
 * environment is injected, so no browser is needed and the "no host call, no
 * network" property is structural (the environment has no such member).
 */
import { describe, expect, it } from 'vitest'

import {
  downloadExport,
  resolveBrowserEnvironment,
  type AnchorLike,
  type BlobLike,
  type DownloadEnvironment,
} from '../../src/client/export/download'
import {
  exportChunks,
  generateExport,
} from '../../src/shared/export'
import type { OpenItemRecord } from '../../src/shared/schema'
import { fixedOptions, fixtureRecords } from './fixtures'
import { sha256 } from './helpers'

/** Recorded interactions with the fake browser. */
interface FakeCalls {
  parts: (readonly string[])[]
  types: string[]
  urls: string[]
  revoked: string[]
  mounted: number
  unmounted: number
  clicks: number
  deferred: (() => void)[]
}

/** A recording browser environment. */
function fakeEnvironment(options: { readonly failBlob?: Error; readonly failUrl?: boolean; readonly failClick?: Error } = {}): {
  environment: DownloadEnvironment
  calls: FakeCalls
} {
  const calls: FakeCalls = { parts: [], types: [], urls: [], revoked: [], mounted: 0, unmounted: 0, clicks: 0, deferred: [] }
  let blobCount = 0
  const environment: DownloadEnvironment = {
    createBlob(parts, type): BlobLike {
      calls.parts.push(parts)
      calls.types.push(type)
      if (options.failBlob !== undefined) throw options.failBlob
      blobCount += 1
      let size = 0
      for (const part of parts) size += Buffer.byteLength(part, 'utf8')
      return { type, size }
    },
    createObjectUrl(blob): string {
      if (options.failUrl === true) return ''
      const url = `blob:fake/${String(blobCount)}/${String(blob.type)}`
      calls.urls.push(url)
      return url
    },
    revokeObjectUrl(url): void {
      calls.revoked.push(url)
    },
    createAnchor(): AnchorLike {
      const anchor: AnchorLike & { clicks: number } = {
        href: '',
        download: '',
        rel: '',
        clicks: 0,
        click(): void {
          if (options.failClick !== undefined) throw options.failClick
          anchor.clicks += 1
          calls.clicks += 1
        },
      }
      return anchor
    },
    mountAnchor(): void {
      calls.mounted += 1
    },
    unmountAnchor(): void {
      calls.unmounted += 1
    },
    defer(callback): void {
      calls.deferred.push(callback)
    },
  }
  return { environment, calls }
}

describe('downloadExport', () => {
  it('downloads one file built from the generator chunks', () => {
    const { environment, calls } = fakeEnvironment()
    const options = fixedOptions({ format: 'csv' })
    const result = downloadExport(fixtureRecords(), options, environment)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const expected = generateExport(fixtureRecords(), options)
    expect(result.filename).toBe(expected.filename)
    expect(result.filename).toBe('open-items-20261113T224100Z-6-30-days-all-sources.csv')
    expect(result.mimeType).toBe('text/csv;charset=utf-8')
    expect(result.byteLength).toBe(Buffer.byteLength(expected.content, 'utf8'))
    expect(result.chunkCount).toBe(exportChunks(fixtureRecords(), options).chunks.length)

    // One Blob built from the chunk array itself — the streaming path, not a
    // joined mega-string.
    expect(calls.parts).toHaveLength(1)
    expect(calls.parts[0]).toEqual(exportChunks(fixtureRecords(), options).chunks)
    expect(calls.types[0]).toBe('text/csv;charset=utf-8')
    // One anchor, mounted, clicked, unmounted.
    expect(calls.mounted).toBe(1)
    expect(calls.unmounted).toBe(1)
    expect(calls.clicks).toBe(1)
    expect(calls.urls).toHaveLength(1)
    // The object URL is released only after the deferred callback runs.
    expect(calls.revoked).toEqual([])
    for (const callback of calls.deferred) callback()
    expect(calls.revoked).toEqual(calls.urls)
  })

  it('sets a deterministic download name and rel=noopener', () => {
    const { environment } = fakeEnvironment()
    const seen: AnchorLike[] = []
    const result = downloadExport(fixtureRecords(), fixedOptions({ format: 'html' }), {
      ...environment,
      mountAnchor(anchor) {
        seen.push(anchor)
      },
    })
    expect(result.ok).toBe(true)
    expect(seen[0]?.download).toBe('open-items-20261113T224100Z-6-30-days-all-sources.html')
    expect(seen[0]?.rel).toBe('noopener')
    expect(seen[0]?.href.startsWith('blob:fake/')).toBe(true)
  })

  it('streams a large selection as many chunks in one Blob', () => {
    const [sample] = fixtureRecords()
    if (sample === undefined) throw new Error('fixture missing')
    const many: OpenItemRecord[] = Array.from({ length: 300 }, (_, index) => ({
      ...sample,
      id: `item-bulk-${String(index).padStart(4, '0')}`,
      resolvedAt: Date.UTC(2026, 0, 1) + index * 60_000,
    }))
    const { environment, calls } = fakeEnvironment()
    const result = downloadExport(many, fixedOptions({ format: 'jsonl' }), environment)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.chunkCount).toBe(301)
    expect(calls.parts[0]).toHaveLength(301)
    expect(result.byteLength).toBe(Buffer.byteLength(calls.parts[0]?.join('') ?? '', 'utf8'))
  })

  it('is deterministic: the same request produces the same bytes and name', () => {
    const options = fixedOptions({ format: 'jsonl' })
    const first = fakeEnvironment()
    const second = fakeEnvironment()
    const a = downloadExport(fixtureRecords(), options, first.environment)
    const b = downloadExport(fixtureRecords(), options, second.environment)
    expect(a).toEqual(b)
    expect(sha256(first.calls.parts[0]?.join('') ?? '')).toBe(sha256(second.calls.parts[0]?.join('') ?? ''))
  })

  it('honours the archive and excerpt options it is given', () => {
    const withArchive = fakeEnvironment()
    const archived = downloadExport(fixtureRecords(), fixedOptions({ format: 'csv', includeArchive: true }), withArchive.environment)
    expect(archived.ok && archived.filename).toBe('open-items-20261113T224100Z-7-30-days-all-sources.csv')

    const withoutExcerpts = fakeEnvironment()
    const lean = downloadExport(
      fixtureRecords(),
      fixedOptions({ format: 'jsonl', includeExcerpts: false }),
      withoutExcerpts.environment,
    )
    expect(lean.ok).toBe(true)
    const bytes = withoutExcerpts.calls.parts[0]?.join('') ?? ''
    expect(bytes).not.toContain('The agent asked for one sandbox escalation')
    expect(bytes).toContain('item-0001-approval')
  })

  it('fails honestly when no browser environment exists', () => {
    const result = downloadExport(fixtureRecords(), fixedOptions({ format: 'csv' }), undefined)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('download-unavailable')
    // The message says what is missing rather than pretending success.
    expect(result.error).toContain('Blob')
  })

  it('reports a thrown Blob creation instead of losing the export', () => {
    const { environment } = fakeEnvironment({ failBlob: new Error('quota exceeded') })
    const result = downloadExport(fixtureRecords(), fixedOptions({ format: 'csv' }), environment)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('download-failed: quota exceeded')
  })

  it('fails when the browser returns no object URL', () => {
    const { environment, calls } = fakeEnvironment({ failUrl: true })
    const result = downloadExport(fixtureRecords(), fixedOptions({ format: 'csv' }), environment)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('no object URL')
    // Nothing was clicked, and nothing needs revoking.
    expect(calls.clicks).toBe(0)
    expect(calls.revoked).toEqual([])
  })

  it('cleans up the anchor and the object URL even when the click throws', () => {
    const { environment, calls } = fakeEnvironment({ failClick: new Error('blocked by the browser') })
    const result = downloadExport(fixtureRecords(), fixedOptions({ format: 'csv' }), environment)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('download-failed: blocked by the browser')
    expect(calls.mounted).toBe(1)
    expect(calls.unmounted).toBe(1)
    expect(calls.revoked).toEqual([])
    for (const callback of calls.deferred) callback()
    expect(calls.revoked).toEqual(calls.urls)
  })
})

describe('resolveBrowserEnvironment', () => {
  it('returns undefined under Node, where the DOM globals are absent', () => {
    expect(resolveBrowserEnvironment()).toBeUndefined()
  })
})
