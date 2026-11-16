/**
 * Structural guarantees that a golden file cannot give:
 *
 * - `src/shared/export.ts` is pure: no DOM, no Node built-in, no network, no
 *   clock, no randomness, no locale — the determinism rules of DESIGN §7.4.7;
 * - `src/client/export/download.ts` is a local download only: no host call, no
 *   network API, no import of the host half;
 * - the frozen stylesheet and token map are pinned by a golden file, so a theme
 *   edit cannot silently change an export;
 * - the schema constants (columns, JSONL key orders) are pinned here as well as
 *   in `determinism.spec.ts` so an accidental reorder is caught at the source.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  CSV_COLUMNS,
  EXPORT_EXTENSIONS,
  EXPORT_MIME_TYPES,
  EXPORT_SCHEMA_VERSION,
  EXPORT_TOKENS,
  JSONL_HEADER_KEYS,
  JSONL_RECORD_KEYS,
  buildStylesheet,
} from '../../src/shared/export'
import { matchGolden } from './helpers'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

/** Read one source file of the package. */
function source(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

/** Patterns that must not occur in the pure generator. */
const FORBIDDEN_IN_GENERATOR: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\bdocument\s*\./u, why: 'DOM access' },
  { pattern: /\bwindow\s*\./u, why: 'window access' },
  { pattern: /\bglobalThis\b/u, why: 'environment access' },
  { pattern: /\bMath\.random\b/u, why: 'randomness' },
  { pattern: /\bDate\.now\b/u, why: 'clock read' },
  { pattern: /\bperformance\.now\b/u, why: 'clock read' },
  { pattern: /\bnew Date\(\s*\)/u, why: 'current-time construction' },
  { pattern: /\bcrypto\s*\./u, why: 'randomness or hashing' },
  { pattern: /\brandomUUID\b/u, why: 'randomness' },
  { pattern: /\btoLocale[A-Za-z]*\s*\(/u, why: 'locale dependence' },
  { pattern: /\bIntl\s*\./u, why: 'locale dependence' },
  { pattern: /\blocaleCompare\s*\(/u, why: 'locale-dependent ordering' },
  { pattern: /\bfetch\s*\(/u, why: 'network' },
  { pattern: /\bXMLHttpRequest\b/u, why: 'network' },
  { pattern: /\bfrom\s+['"]node:/u, why: 'Node built-in import' },
  { pattern: /\brequire\s*\(/u, why: 'CommonJS require' },
  { pattern: /\bprocess\s*\./u, why: 'process access' },
  { pattern: /\blocalStorage\b/u, why: 'browser storage' },
  { pattern: /\bnavigator\b/u, why: 'browser API' },
]

/** Patterns that must not occur in the browser download wrapper. */
const FORBIDDEN_IN_DOWNLOAD: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\bfetch\s*\(/u, why: 'network' },
  { pattern: /\bXMLHttpRequest\b/u, why: 'network' },
  { pattern: /\bEventSource\b/u, why: 'network' },
  { pattern: /\bWebSocket\b/u, why: 'network' },
  { pattern: /\bsendBeacon\b/u, why: 'network' },
  { pattern: /\bremote\s*\./u, why: 'host Remote call' },
  { pattern: /\/api\//u, why: 'HTTP route' },
  { pattern: /@deepseek-ai\//u, why: 'host package import' },
  { pattern: /\bfrom\s+['"]node:/u, why: 'Node built-in import' },
]

describe('src/shared/export.ts is pure', () => {
  const generator = source('src/shared/export.ts')

  it('contains no DOM, network, clock, randomness or locale access', () => {
    for (const { pattern, why } of FORBIDDEN_IN_GENERATOR) {
      expect(pattern.test(generator), `export.ts violates purity: ${why} (${String(pattern)})`).toBe(false)
    }
  })

  it('does not import the schema at runtime (types only)', () => {
    // `import type` erases; a value import would pull the schema module into the
    // browser bundle and break the "type-only shared module" rule.
    expect(generator).toMatch(/^import type \{/mu)
    expect(generator).not.toMatch(/^import (?!type\b)[^;]*from '\.\/schema'/mu)
  })

  it('uses Date only with an explicit timestamp argument', () => {
    // Every `new Date(...)` in the generator must be given a value: the module
    // may never read the clock.
    const calls = [...generator.matchAll(/new Date\(([^)]*)\)/gu)]
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call[1]?.trim(), 'a `new Date()` without a timestamp is a clock read').not.toBe('')
    }
  })
})

describe('src/client/export/download.ts is a local download only', () => {
  const wrapper = source('src/client/export/download.ts')

  it('contains no network, host call or Node import', () => {
    for (const { pattern, why } of FORBIDDEN_IN_DOWNLOAD) {
      expect(pattern.test(wrapper), `download.ts violates the local-only rule: ${why} (${String(pattern)})`).toBe(false)
    }
  })

  it('imports only the shared generator and its types', () => {
    const imports = [...wrapper.matchAll(/from '([^']+)'/gu)].map(match => match[1])
    expect(imports.length).toBeGreaterThan(0)
    for (const specifier of imports) {
      expect(specifier?.startsWith('../../shared/'), `${String(specifier)} is not a shared module`).toBe(true)
    }
  })

  it('documents the DOM absence instead of importing DOM types', () => {
    // The package tsconfig has no DOM lib; the wrapper must declare its own slice.
    expect(wrapper).toContain('interface BlobLike')
    expect(wrapper).toContain('interface AnchorLike')
    expect(wrapper).not.toMatch(/\bHTMLElement\b/u)
  })
})

describe('frozen export artifacts', () => {
  it('pins the compiled stylesheet (a theme edit must change this file deliberately)', () => {
    const stylesheet = buildStylesheet()
    const golden = matchGolden('stylesheet.css', stylesheet)
    expect(stylesheet).toBe(golden)
    // Minified, single line, self-contained.
    expect(stylesheet.includes('\n')).toBe(false)
    expect(stylesheet.startsWith(':root{')).toBe(true)
    expect(stylesheet).toContain('@media (prefers-color-scheme:dark)')
    expect(stylesheet).toContain('@media print')
    expect(stylesheet.length).toBeLessThan(4_000)
  })

  it('pins the frozen token map itself', () => {
    expect(EXPORT_TOKENS).toEqual([
      { name: 'canvas', light: '#ffffff', dark: '#141618' },
      { name: 'surface', light: '#f6f7f9', dark: '#1c1f22' },
      { name: 'border', light: '#d9dce1', dark: '#33383e' },
      { name: 'text', light: '#1a1c1f', dark: '#e7eaee' },
      { name: 'text-secondary', light: '#5b6169', dark: '#a8aeb6' },
      { name: 'text-tertiary', light: '#7b828b', dark: '#8d949d' },
      { name: 'accent', light: '#2f6fd0', dark: '#7fa9ec' },
      { name: 'user', light: '#1d7a4b', dark: '#63c995' },
      { name: 'auto', light: '#715bb8', dark: '#b49be8' },
      { name: 'warning', light: '#8a6200', dark: '#dcb35e' },
    ])
    // Every token is a unique CSS variable, and every one has both a light and
    // a dark value (the rule is "light + prefers-color-scheme dark pairs").
    expect(new Set(EXPORT_TOKENS.map(token => token.name)).size).toBe(EXPORT_TOKENS.length)
    for (const token of EXPORT_TOKENS) {
      expect(token.light).toMatch(/^#[0-9a-f]{6}$/u)
      expect(token.dark).toMatch(/^#[0-9a-f]{6}$/u)
      expect(token.light).not.toBe(token.dark)
    }
  })

  it('pins the documented contract constants', () => {
    expect(EXPORT_SCHEMA_VERSION).toBe(1)
    expect(EXPORT_MIME_TYPES).toEqual({
      csv: 'text/csv;charset=utf-8',
      jsonl: 'application/x-ndjson;charset=utf-8',
      html: 'text/html;charset=utf-8',
    })
    expect(EXPORT_EXTENSIONS).toEqual({ csv: 'csv', jsonl: 'jsonl', html: 'html' })
    expect(CSV_COLUMNS).toHaveLength(14)
    expect(JSONL_RECORD_KEYS[0]).toBe('type')
    expect(JSONL_RECORD_KEYS[1]).toBe('exportSchemaVersion')
    expect(JSONL_RECORD_KEYS[2]).toBe('schemaVersion')
    expect(JSONL_HEADER_KEYS[0]).toBe('type')
  })
})
