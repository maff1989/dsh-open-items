#!/usr/bin/env node
/**
 * Integrity check for the Open Items intent corpus.
 *
 * Usage:
 *   node docs/tools/check-docs.mjs            # check dsh-open-items/docs
 *   node docs/tools/check-docs.mjs <docsRoot> # check another location
 *
 * Checks, per document kind:
 * - required sections (CONTEXT / SPEC / ADR templates) and required headers;
 * - relative links resolve on disk;
 * - forbidden status and retired vocabulary (the corpus states intent, and
 *   retired words are defined only in the glossary);
 * - specs carry Given/When/Then acceptance criteria;
 * - no placeholders and no stubs (minimum substance).
 *
 * Exits non-zero on problems. Warnings (short documents) do not fail.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..')

/** Required markdown headings per document kind. */
const REQUIRED = {
  context: [
    '## Purpose',
    '## Position in the map',
    '## What this context owns',
    '## What this context does not own',
    '## Invariants',
    '## Inbound contracts',
    '## Outbound contracts',
    '## Key concepts',
    '## Design decisions in force',
    '## Deferred and open',
    '## Reading',
  ],
  spec: [
    '## Definitions',
    '## Constraints',
    '## Problem',
    '## Solution',
    '## User Stories',
    '## Acceptance Criteria',
    '## Design Decisions',
    '### Deferred Decisions',
    '## Testing Strategy',
    '## Out of Scope',
    '## Open Questions',
  ],
  adr: ['## Context', '## Decision', '## Why', '## Alternatives considered', '## Consequences'],
  root: [],
}

/** Vocabulary the corpus must not use (except in the glossary's retired table). */
const BANNED = [
  [/\bshipped\b/iu, 'status word "shipped"'],
  [/\bunreleased\b/iu, 'status word "unreleased"'],
  [/\brc[.-]?[12]\b/iu, 'release-candidate marker'],
  [/\bremediation\b/iu, 'delivery-history word "remediation"'],
  [/\bin this build\b/iu, 'status phrase "in this build"'],
  [/\bnot exercised\b/iu, 'status phrase "not exercised"'],
  [/\bfingerprint\b/iu, 'retired term "fingerprint" (use dedupe key)'],
  [/\bpending item\b/iu, 'retired term "pending item"'],
  [/\bauto-?closed\b/iu, 'retired term "auto-closed" (use detector-closed)'],
  [/\bNeeds You\b/u, 'wrong capitalisation "Needs You"'],
  [/\bTODO\b/u, 'placeholder TODO'],
  [/\bTBD\b/u, 'placeholder TBD'],
  [/\bYYYY-MM-DD\b/u, 'placeholder date'],
]

/** Files whose own text may legitimately quote a banned word (the glossary's retired list, and
 * the README, which explains the rule and points at the packet's file names). */
const ALLOW_BANNED = new Set(['UBIQUITOUS_LANGUAGE.md', 'README.md'])

/** Operator documentation in this folder: it is packet-style by design and not part of the
 * intent corpus, so it is excluded from the checks. */
const OPERATOR_FILES = new Set([
  'a11y.md',
  'client-foundation.md',
  'install.md',
  'perf.md',
  'release.md',
  'session-log-policy.md',
])

/** Directories that are not documents. */
const SKIP_DIRS = new Set(['templates', 'tools', 'node_modules'])

/** Minimum line counts, and minimum Given/When/Then lines per spec. */
const MIN_LINES = { context: 100, spec: 150, adr: 25, root: 40 }
const MIN_GIVEN_WHEN_THEN = 6

const problems = []
const warnings = []

/** Walk every markdown document under the corpus. */
async function* walk(dir) {
  for (const child of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, child.name)
    if (child.isDirectory()) {
      if (!SKIP_DIRS.has(child.name)) yield* walk(abs)
    } else if (child.name.endsWith('.md')) {
      yield abs
    }
  }
}

/** Classify one document by its location. */
function kindOf(abs) {
  const rel = relative(ROOT, abs)
  const parts = rel.split('/')
  if (parts.at(-1) === 'CONTEXT.md' && parts[0] === 'contexts') return 'context'
  if (parts.includes('specs')) return 'spec'
  if (parts.includes('adrs') || parts[0] === 'adrs') return 'adr'
  return 'root'
}

/** Whether a path exists. */
async function exists(abs) {
  try {
    await stat(abs)
    return true
  } catch {
    return false
  }
}

const files = []
for await (const abs of walk(ROOT)) files.push(abs)
files.sort()

for (const abs of files) {
  const rel = relative(ROOT, abs)
  if (OPERATOR_FILES.has(rel)) continue
  const text = await readFile(abs, 'utf8')
  const lines = text.split('\n')
  const kind = kindOf(abs)
  const allowBanned = ALLOW_BANNED.has(rel)

  if (!/\*\*Date:\*\*\s*\d{4}-\d{2}-\d{2}/u.test(text)) problems.push(`${rel}: missing "**Date:** YYYY-MM-DD" header`)
  if (kind === 'spec' && !/\*\*Context\(s\):\*\*/u.test(text)) problems.push(`${rel}: missing "**Context(s):**" header`)
  if (kind === 'context' && !/\*\*Kind:\*\*/u.test(text)) problems.push(`${rel}: missing "**Kind:**" header`)

  for (const heading of REQUIRED[kind]) {
    if (!text.includes(heading)) problems.push(`${rel}: missing section "${heading}"`)
  }

  if (lines.length < MIN_LINES[kind]) warnings.push(`${rel}: only ${lines.length} lines (expected ≥ ${MIN_LINES[kind]})`)
  if (kind === 'spec') {
    const gwt = (text.match(/^\s*(Given|When|Then)\b/gmu) ?? []).length
    if (gwt < MIN_GIVEN_WHEN_THEN) problems.push(`${rel}: only ${gwt} Given/When/Then lines (expected ≥ ${MIN_GIVEN_WHEN_THEN})`)
    if (!/```/u.test(text)) problems.push(`${rel}: no fenced acceptance-criteria blocks`)
  }

  if (!allowBanned) {
    for (const [pattern, label] of BANNED) {
      const match = pattern.exec(text)
      if (match !== null) {
        const line = text.slice(0, match.index).split('\n').length
        problems.push(`${rel}:${line}: ${label} ("${match[0]}")`)
      }
    }
  }

  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1].trim()
    if (/^(https?:|mailto:|#)/u.test(target)) continue
    const path = target.split('#')[0]
    if (path === '') continue
    if (!(await exists(join(dirname(abs), path)))) problems.push(`${rel}: broken link -> ${target}`)
  }
}

for (const name of ['README.md', 'ARCHITECTURE.md', 'CONTEXT_MAP.md', 'UBIQUITOUS_LANGUAGE.md']) {
  if (!(await exists(join(ROOT, name)))) problems.push(`${name}: missing`)
}
for (const context of ['attention-register', 'capture', 'answering', 'surfaces', 'durability', 'model-contract']) {
  if (!(await exists(join(ROOT, 'contexts', context, 'CONTEXT.md')))) problems.push(`contexts/${context}/CONTEXT.md: missing`)
  try {
    const specs = (await readdir(join(ROOT, 'contexts', context, 'specs'))).filter(name => name.endsWith('.md'))
    if (specs.length === 0) problems.push(`contexts/${context}/specs/: no specs`)
  } catch {
    problems.push(`contexts/${context}/specs/: missing directory`)
  }
}

console.log(`checked ${files.length} documents in ${ROOT}`)
if (warnings.length > 0) {
  console.log(`\nWARNINGS (${warnings.length}):`)
  for (const warning of warnings) console.log(`  - ${warning}`)
}
if (problems.length > 0) {
  console.log(`\nPROBLEMS (${problems.length}):`)
  for (const problem of problems) console.log(`  - ${problem}`)
  process.exit(1)
}
console.log('\nOK: sections, headers, links, vocabulary and acceptance criteria all present')
