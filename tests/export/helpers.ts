/**
 * Golden-file and hashing helpers for the export suites.
 *
 * Comparison is byte-for-byte by default. Set `UPDATE_GOLDENS=1` to rewrite a
 * golden instead of failing — that is the only supported way to accept an
 * intentional change:
 *
 *     UPDATE_GOLDENS=1 ./node_modules/.bin/vitest run tests/export
 *
 * Every rewrite must be reviewed as a diff: the golden files are the contract.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of `tests/export/golden`. */
export const GOLDEN_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'golden')

/**
 * Read one golden file as UTF-8 text.
 * @param name - file name inside the golden directory.
 * @returns the exact bytes decoded as text.
 */
export function readGolden(name: string): string {
  return readFileSync(join(GOLDEN_DIRECTORY, name), 'utf8')
}

/**
 * Compare text against a golden file byte-for-byte (or rewrite it under
 * `UPDATE_GOLDENS=1`).
 * @param name - file name inside the golden directory.
 * @param actual - generated text.
 * @returns the golden text that was compared.
 */
export function matchGolden(name: string, actual: string): string {
  if (process.env['UPDATE_GOLDENS'] === '1') {
    writeFileSync(join(GOLDEN_DIRECTORY, name), actual)
    return actual
  }
  return readGolden(name)
}

/**
 * SHA-256 of one string, used to report the determinism proof in test names.
 * @param text - text to hash.
 * @returns lowercase hex digest.
 */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Compare two generated strings and report the first differing offset, so a
 * failure is actionable instead of "strings differ".
 * @param left - first text.
 * @param right - second text.
 * @returns the first offset where they differ, or `-1` when equal.
 */
export function firstDifference(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index
  }
  return left.length === right.length ? -1 : length
}

/** Count the lines of a text (LF-terminated files include a trailing empty segment). */
export function lineCount(text: string): number {
  return text.split('\n').length - 1
}

/**
 * A minimal RFC 4180 reader used to prove the generated CSV is parseable.
 * Supports quoted fields, doubled quotes and embedded newlines; comment rows
 * (`#`-prefixed) become their own single-cell rows.
 * @param text - CSV text.
 * @returns rows of cell values.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let pending = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        cell += character
      }
      continue
    }
    if (character === '"') {
      quoted = true
      pending = true
      continue
    }
    if (character === ',') {
      row.push(cell)
      cell = ''
      pending = true
      continue
    }
    if (character === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      pending = false
      continue
    }
    if (character !== '\r') {
      cell += character
      pending = true
    }
  }
  if (pending || cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}
