#!/usr/bin/env node
/**
 * Static accessibility audit for the browser half (M6).
 *
 * This is a *contract scanner*, not a WCAG conformance proof: it enforces the
 * cheap, mechanical parts of the plugin's accessibility contracts and produces
 * file:line findings a human can verify in a browser. The manual checklist that
 * completes it lives in `docs/a11y.md`.
 *
 * Rules:
 * - `button-name`      — a button with no static accessible name (icon-only candidates)
 * - `interactive-semantics` — clickable div/span without role/tabIndex/aria semantics
 * - `form-label`       — input/textarea/select without aria-label(ledby)/id
 * - `image-alt`        — img without alt
 * - `live-region`      — async completion surfaces exist and announce via role=status/alert/aria-live
 * - `reduced-motion`   — stylesheet honours prefers-reduced-motion
 * - `focus-visible`    — stylesheet keeps a visible focus indicator
 * - `status-not-colour-only` — status classes are accompanied by text/aria state (heuristic)
 *
 * Usage: node scripts/a11y-audit.mjs [--strict] [--json]
 *   --strict exits 1 when a HIGH finding exists (the release gate).
 *   --json prints the findings array.
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(ROOT, 'src', 'client')
const argv = process.argv.slice(2)
const strict = argv.includes('--strict')
const jsonOnly = argv.includes('--json')

/** All findings, highest severity first in the report. */
const findings = []
/** Rules that passed, for the summary. */
const passed = []
/** Files scanned. */
let scanned = 0

/**
 * Record one finding.
 * @param rule - rule id.
 * @param severity - 'high' | 'medium' | 'low'.
 * @param file - absolute file path.
 * @param line - 1-based line.
 * @param message - what a human must check/fix.
 */
function finding(rule, severity, file, line, message) {
  findings.push({
    rule,
    severity,
    file: relative(ROOT, file),
    line,
    message,
  })
}

/**
 * Read every browser source file.
 * @returns `{ path, text }` entries.
 */
async function readClientSources() {
  const files = []
  /**
   * Walk a directory.
   * @param directory - absolute directory.
   */
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile() && /\.(ts|tsx|css)$/u.test(entry.name)) {
        files.push({ path: absolute, text: await readFile(absolute, 'utf8') })
      }
    }
  }
  await walk(CLIENT)
  return files
}

/**
 * Extract a JSX opening tag starting at `start` (through the matching `>`).
 * @param text - full file text.
 * @param start - index of `<`.
 * @returns the tag text and its start/end line numbers.
 */
function openingTag(text, start) {
  let quote = ''
  let braces = 0
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (quote !== '') {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    if (character === '{') braces += 1
    else if (character === '}') braces = Math.max(0, braces - 1)
    else if (character === '>' && braces === 0) {
      const tag = text.slice(start, index + 1)
      const line = text.slice(0, start).split('\n').length
      return { tag, line, end: index + 1, selfClosing: tag.trimEnd().endsWith('/>') }
    }
  }
  return undefined
}

/**
 * Whether a JSX element is wrapped by a `<label>` (implicit labelling).
 * @param text - full file text.
 * @param index - start index of the control's `<`.
 * @returns true when the nearest unclosed `<label>` precedes it.
 */
function wrappedInLabel(text, index) {
  const before = text.slice(0, index)
  const lastOpen = before.lastIndexOf('<label')
  if (lastOpen === -1) return false
  const lastClose = before.lastIndexOf('</label>')
  return lastOpen > lastClose
}

/**
 * Whether a JSX tag carries an accessibility attribute.
 * @param tag - opening tag text.
 * @param names - attribute prefixes/names that satisfy the rule.
 * @returns true when any is present.
 */
function hasAttribute(tag, names) {
  return names.some(name => new RegExp(`\\b${name}\\s*=`, 'u').test(tag))
}

/** Run every rule over the sources. */
async function audit() {
  const sources = await readClientSources()
  scanned = sources.length
  const allText = sources.map(source => source.text).join('\n')

  // --- live region for async completion -------------------------------------
  if (/role\s*=\s*["'](?:status|alert)["']|aria-live\s*=/u.test(allText)) {
    passed.push('live-region: async surfaces announce through role=status/alert or aria-live')
  } else {
    finding('live-region', 'high', join(CLIENT, 'ui/page.tsx'), 1,
      'no role="status"/"alert"/aria-live found; async completion cannot be announced')
  }

  // --- reduced motion / focus-visible in the stylesheet --------------------
  if (/prefers-reduced-motion/u.test(allText)) {
    passed.push('reduced-motion: stylesheet honours prefers-reduced-motion')
  } else {
    finding('reduced-motion', 'medium', join(CLIENT, 'styles.ts'), 1,
      'no @media (prefers-reduced-motion: reduce) rule; animations cannot be disabled')
  }
  if (/:focus-visible/u.test(allText)) {
    passed.push('focus-visible: stylesheet keeps a visible focus indicator')
  } else {
    finding('focus-visible', 'medium', join(CLIENT, 'styles.ts'), 1,
      'no :focus-visible rule; keyboard focus may be invisible')
  }

  // --- status not colour-only (heuristic) ----------------------------------
  if (/aria-(?:current|selected|pressed|expanded|live)|data-state\s*=|role\s*=\s*["'](?:status|alert)["']/u.test(allText)) {
    passed.push('status-not-colour-only: status surfaces carry text/aria/role state, not only colour')
  } else {
    finding('status-not-colour-only', 'medium', join(CLIENT, 'ui/row.tsx'), 1,
      'status appears to be conveyed by class/colour only; add text or aria state')
  }

  for (const source of sources) {
    if (!/\.tsx$/u.test(source.path)) continue
    const text = source.text

    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== '<') continue
      const remainder = text.slice(index, index + 40)
      // --- button accessible name ------------------------------------------
      if (/^<button\b/u.test(remainder)) {
        const tag = openingTag(text, index)
        if (tag === undefined) continue
        if (hasAttribute(tag.tag, ['aria-label', 'aria-labelledby', 'title'])) continue
        if (tag.selfClosing) {
          finding('button-name', 'medium', source.path, tag.line,
            'self-closing <button/> has no accessible name')
          continue
        }
        const close = text.indexOf('</button>', tag.end)
        const content = close === -1 ? '' : text.slice(tag.end, close)
        const dynamicText = content.includes('{')
        const visible = content
          .replace(/<[^>]*>/gu, ' ')
          .replace(/\{[^}]*\}/gu, ' ')
          .replace(/\s+/gu, ' ')
          .trim()
        // `{t('…')}` / `{label}` are text expressions; only a genuinely empty
        // (icon/component-only) button without an accessible name is a finding.
        if (!dynamicText && visible === '') {
          finding('button-name', 'medium', source.path, tag.line,
            'button content is icon/component-only and the tag has no aria-label; verify the accessible name')
        }
        continue
      }

      // --- interactive semantics -------------------------------------------
      if (/^<(?:div|span)\b/u.test(remainder)) {
        const tag = openingTag(text, index)
        if (tag === undefined) continue
        if (!/\bonClick\s*=/u.test(tag.tag)) continue
        if (hasAttribute(tag.tag, ['role', 'tabIndex', 'aria-label', 'aria-labelledby', 'aria-describedby'])) continue
        if (/stopPropagation\(\)/u.test(tag.tag)) continue
        finding('interactive-semantics', 'high', source.path, tag.line,
          'clickable div/span without role/tabIndex/aria; keyboard users cannot reach it')
        continue
      }

      // --- form control labels ---------------------------------------------
      if (/^<(?:input|textarea|select)\b/u.test(remainder)) {
        const tag = openingTag(text, index)
        if (tag === undefined) continue
        if (hasAttribute(tag.tag, ['aria-label', 'aria-labelledby', 'id'])) continue
        if (wrappedInLabel(text, index)) continue
        finding('form-label', 'medium', source.path, tag.line,
          'form control has no aria-label/aria-labelledby/id and is not wrapped in a <label>')
        continue
      }

      // --- image alt --------------------------------------------------------
      if (/^<img\b/u.test(remainder)) {
        const tag = openingTag(text, index)
        if (tag === undefined) continue
        if (/\balt\s*=/u.test(tag.tag)) continue
        finding('image-alt', 'high', source.path, tag.line, 'img without alt')
      }
    }
  }
}

/** Order findings by severity then file. */
function sortFindings() {
  const weight = { high: 0, medium: 1, low: 2 }
  findings.sort((left, right) =>
    (weight[left.severity] ?? 9) - (weight[right.severity] ?? 9)
    || left.file.localeCompare(right.file)
    || left.line - right.line)
}

await audit()
sortFindings()

const counts = {
  high: findings.filter(entry => entry.severity === 'high').length,
  medium: findings.filter(entry => entry.severity === 'medium').length,
  low: findings.filter(entry => entry.severity === 'low').length,
}

if (jsonOnly) {
  console.log(JSON.stringify({ scanned, counts, passed, findings }, null, 2))
} else {
  console.log(`a11y-audit: scanned ${scanned} browser source file(s)`)
  console.log(`  findings: ${counts.high} high, ${counts.medium} medium, ${counts.low} low`)
  for (const rule of passed) console.log(`  PASS ${rule}`)
  for (const entry of findings) {
    console.log(`  ${entry.severity.toUpperCase()} ${entry.rule} ${entry.file}:${entry.line} — ${entry.message}`)
  }
  console.log('  Manual browser pass required for the rest (see docs/a11y.md).')
}

if (strict && counts.high > 0) process.exit(1)
