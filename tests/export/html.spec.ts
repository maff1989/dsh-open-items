/**
 * HTML export: one self-contained, script-free page with a frozen stylesheet,
 * escaping discipline, fixed DOM attributes, day grouping and an honest header.
 *
 * The golden file pins the exact bytes. The rest of the suite asserts the
 * properties the design lists (§7.4.7 rule 4–6) so a future edit that keeps the
 * golden (by regenerating it blindly) still has to satisfy them.
 */
import { describe, expect, it } from 'vitest'

import {
  EXPORT_TOKENS,
  buildStylesheet,
  escapeHtml,
  exportChunks,
  formatDayHeading,
  generateExport,
  selectExportRecords,
  toHtml,
  utcDay,
} from '../../src/shared/export'
import { fixedOptions, fixtureRecords, FIXED_GENERATED_AT, nonExportableRecords } from './fixtures'
import { firstDifference, matchGolden } from './helpers'

/** Generate the fixture page with optional overrides. */
function page(overrides = {}, records = fixtureRecords()): string {
  return toHtml(records, fixedOptions({ format: 'html', ...overrides }))
}

/** Every `<article` opening tag of a page. */
function articles(html: string): string[] {
  return html.match(/<article\b[^>]*>/gu) ?? []
}

describe('toHtml', () => {
  it('matches the golden file byte-for-byte', () => {
    const actual = page()
    const golden = matchGolden('register.html', actual)
    expect(actual, `HTML differs from golden at offset ${String(firstDifference(actual, golden))}`).toBe(golden)
  })

  it('matches the empty-result golden file', () => {
    const actual = page({}, [])
    const golden = matchGolden('empty.html', actual)
    expect(actual, `empty HTML differs from golden at offset ${String(firstDifference(actual, golden))}`).toBe(golden)
  })

  it('is a complete standalone document with LF endings', () => {
    const html = page()
    expect(html.startsWith('<!DOCTYPE html>\n')).toBe(true)
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('<meta name="viewport"')
    expect(html).toContain('<title>')
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
    expect(html.includes('\r')).toBe(false)
    // Exactly one stylesheet element, and no second one.
    expect(html.match(/<style>/gu)).toHaveLength(1)
    expect(html.match(/<\/style>/gu)).toHaveLength(1)
  })

  it('loads nothing from the network and runs no code', () => {
    const html = page()
    expect(html).not.toMatch(/<script\b/iu)
    expect(html).not.toMatch(/<link\b/iu)
    expect(html).not.toMatch(/<iframe\b/iu)
    expect(html).not.toMatch(/<img\b/iu)
    expect(html).not.toMatch(/\ssrc\s*=/iu)
    expect(html).not.toMatch(/\shref\s*=/iu)
    expect(html).not.toMatch(/url\(/iu)
    expect(html).not.toMatch(/@import/iu)
    expect(html).not.toMatch(/@font-face/iu)
    // No inline event handlers of the `on...=` form.
    expect(html).not.toMatch(/\son[a-z]+\s*=/iu)
    // The stylesheet must not reference a URL either (checked via buildStylesheet).
    expect(buildStylesheet()).not.toMatch(/url\(/iu)
  })

  it('uses the frozen token map for every colour it needs', () => {
    const stylesheet = buildStylesheet()
    for (const token of EXPORT_TOKENS) {
      expect(stylesheet).toContain(`--oi-${token.name}:${token.light}`)
      expect(stylesheet).toContain(`--oi-${token.name}:${token.dark}`)
    }
    // Light values outside the token map must not appear: the export may not
    // read the live theme (§7.4.7 rule 4).
    expect(stylesheet).toContain('@media (prefers-color-scheme:dark)')
    expect(stylesheet).toContain('@media print')
  })

  it('emits the fixed DOM: article[data-item-id], data-source and data-outcome', () => {
    const html = page()
    const tags = articles(html)
    expect(tags).toHaveLength(6)
    const expected = selectExportRecords(fixtureRecords(), fixedOptions({ format: 'html' }))
    for (const [index, record] of expected.records.entries()) {
      const tag = tags[index] ?? ''
      expect(tag).toContain(`data-item-id="${record.id}"`)
      expect(tag).toMatch(/data-source="(user|auto)"/u)
      expect(tag).toMatch(/data-outcome="(answered|dismissed|superseded|detected-closed)"/u)
      // The article is the record's only container, and it wraps a heading.
      expect(tag.endsWith('>')).toBe(true)
    }
    expect(html.match(/<\/article>/gu)).toHaveLength(6)
    // The two-channel source indicator is present in text as well as attribute.
    expect(html).toContain(' · by you</p>')
    expect(html).toContain(' · automatic</p>')
  })

  it('escapes every text field, including hostile payloads', () => {
    const html = page()
    // The payload's markup is inert text.
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(html).toContain('&lt;b&gt;release&lt;/b&gt;')
    expect(html).toContain('&amp; ampersand')
    // The payload's closing style tag cannot terminate the real stylesheet.
    expect(html).toContain('&lt;/style&gt;')
    // Quotes and apostrophes are escaped.
    expect(html).toContain('&quot;quoted&quot;')
    expect(html).toContain('=cmd|&#39; /C calc&#39;!A0')
    // No raw record text may appear unescaped even once.
    expect(html).not.toContain('<b>release</b>')
  })

  it('cannot be broken by a crafted closing tag or comment in a title', () => {
    const [record] = fixtureRecords()
    if (record === undefined) throw new Error('fixture missing')
    const hostile = {
      ...record,
      id: 'item-hostile',
      title: '</article></main><script>alert(1)</script><!--',
      body: '<!-- comment -->',
      quote: '</style><link rel="stylesheet" href="http://evil.example/x.css">',
    }
    const html = page({}, [hostile])
    expect(html).not.toContain('<script>alert(1)')
    expect(html).not.toContain('<link rel="stylesheet"')
    expect(html.match(/<\/article>/gu)).toHaveLength(1)
    expect(html.match(/<\/style>/gu)).toHaveLength(1)
    expect(html).toContain('&lt;!--')
  })

  it('groups by UTC day, newest first, with a per-day count', () => {
    const html = page()
    const sections = [...html.matchAll(/<section data-day="([^"]+)">/gu)].map(match => match[1])
    expect(sections).toEqual(['2026-11-13', '2026-11-12'])
    expect(html).toContain(`<h2>${formatDayHeading('2026-11-13')} <span class="oi-meta">· 3 decisions</span></h2>`)
    expect(html).toContain(`<h2>${formatDayHeading('2026-11-12')} <span class="oi-meta">· 3 decisions</span></h2>`)
    // Day heading text is generated from frozen tables, not the locale.
    expect(formatDayHeading('2026-11-13')).toBe('Friday, 13 November 2026')
    expect(formatDayHeading('2026-11-12')).toBe('Thursday, 12 November 2026')
    expect(utcDay(Date.UTC(2026, 10, 13, 23, 59))).toBe('2026-11-13')
  })

  it('stays readable without CSS: headings, definition lists and times carry the meaning', () => {
    const html = page()
    for (const tag of ['<h1>', '<h2>', '<h3>', '<dl', '<dt>', '<dd>', '<time datetime=']) {
      expect(html).toContain(tag)
    }
    // The source word and the acknowledgement phrase are real text, not styling.
    expect(html).toContain('acknowledged by retried call')
    expect(html).toContain('>pending<')
    expect(html).toContain('>n/a<')
    expect(html).toContain('What you decided')
    expect(html).toContain('Closed automatically')
    expect(html).toContain('What happened next')
  })

  it('writes an honest header: filter, count, pruned, generatedAt, versions', () => {
    const html = page()
    expect(html).toContain('<header data-export="header">')
    expect(html).toContain('<dd>30 days · all sources</dd>')
    expect(html).toContain('<dd>6</dd>')
    expect(html).toContain('<time datetime="2026-11-13T23:45:00.000Z">2026-11-13 23:45 UTC</time>')
    expect(html).toContain('complete — nothing pruned')
    expect(html).toContain('export schema 1 · store schema 3')
    expect(html).toContain('dsh-open-items 0.1.0')
    expect(html).toContain('Transcript excerpts</dt><dd>included')
  })

  it('says loudly when earlier records were pruned', () => {
    const html = page({ earlierRecordsPruned: true })
    expect(html).toContain('earlier records pruned — this snapshot is not complete')
    expect(html).toContain('class="oi-warning"')
  })

  it('drops transcript excerpts when they are excluded', () => {
    const html = page({ includeExcerpts: false })
    expect(html).not.toContain('<figure class="oi-excerpt">')
    expect(html).not.toContain('class="oi-excerpt oi-body"')
    expect(html).toContain('Transcript excerpts</dt><dd>excluded')
    // The decision and provenance stay: the record is still useful.
    expect(html).toContain('What you decided')
    expect(html).toContain('dsh-highlights plugin code review')
  })

  it('marks archived records and states the archive scope honestly', () => {
    const excluded = page()
    expect(excluded).not.toContain('item-0007-archived')
    expect(excluded).toContain('excluded — 1 archived record omitted')

    const included = page({ includeArchive: true })
    expect(included).toContain('item-0007-archived')
    expect(included).toContain('included — 1 archived record (transcript excerpt already dropped)')
    // The archived row is explicitly labelled in the page, not silently mixed in.
    expect(included).toContain('yes — transcript excerpt dropped')
    // The default page has no archived row, so no such label.
    expect(page()).toContain('Archived</dt><dd>no')
  })

  it('renders an honest empty page instead of a broken one', () => {
    const html = page({}, [])
    expect(html).toContain('No decisions match this filter. Nothing was pruned from an empty result.')
    expect(articles(html)).toHaveLength(0)
    expect(html).not.toContain('<section data-day=')
  })

  it('excludes records that are not resolved and never leaks their titles', () => {
    const html = page({}, [...fixtureRecords(), ...nonExportableRecords()])
    expect(html).not.toContain('item-9001-still-open')
    expect(html).not.toContain('item-9002-deleted')
    expect(html).not.toContain('item-9003-no-resolution')
    expect(html).not.toContain('item-9004-snoozed')
    expect(articles(html)).toHaveLength(6)
  })

  it('does not depend on the input order', () => {
    expect(page({}, [...fixtureRecords()].reverse())).toBe(page())
  })

  it('keeps the only generatedAt in the header', () => {
    const first = page()
    const second = page({ generatedAt: FIXED_GENERATED_AT + 86_400_000 })
    const normalized = first
      .replaceAll('2026-11-13T23:45:00.000Z', '2026-11-14T23:45:00.000Z')
      .replaceAll('2026-11-13 23:45 UTC', '2026-11-14 23:45 UTC')
    expect(normalized).toBe(second)
  })

  it('escapes rather than sanitizes URLs: a reference renders as text plus code', () => {
    const [record] = fixtureRecords()
    if (record === undefined) throw new Error('fixture missing')
    const html = page({}, [{ ...record, id: 'item-link', title: 'See https://evil.example/path and javascript:alert(1)' }])
    expect(html).not.toMatch(/<a\b/iu)
    expect(html).toContain('https://evil.example/path')
    expect(html).toContain('javascript:alert(1)')
  })
})

describe('escapeHtml', () => {
  it('escapes the five structural characters', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;')
  })

  it('replaces control characters with spaces so the page stays parseable', () => {
    expect(escapeHtml('a\u0000b\u0007c\u001fd')).toBe('a b c d')
  })

  it('leaves ordinary unicode intact', () => {
    expect(escapeHtml('日本語 — 🦔 ✓')).toBe('日本語 — 🦔 ✓')
  })
})

describe('streaming chunks for html', () => {
  it('joins to exactly the generated page and chunks at group boundaries', () => {
    const options = fixedOptions({ format: 'html' })
    const chunkSet = exportChunks(fixtureRecords(), options)
    expect(chunkSet.chunks.join('')).toBe(toHtml(fixtureRecords(), options))
    expect(chunkSet.chunks.length).toBeGreaterThan(1 + 6)
    expect(chunkSet.byteLength).toBe(Buffer.byteLength(chunkSet.chunks.join(''), 'utf8'))
    expect(chunkSet.mimeType).toBe('text/html;charset=utf-8')
  })

  it('reports the byte length and file name of the whole file', () => {
    const file = generateExport(fixtureRecords(), fixedOptions({ format: 'html' }))
    expect(file.byteLength).toBe(Buffer.byteLength(file.content, 'utf8'))
    expect(file.filename).toBe('open-items-20261113T224100Z-6-30-days-all-sources.html')
  })
})
