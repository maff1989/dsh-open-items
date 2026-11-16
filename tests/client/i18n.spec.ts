/**
 * Locale baseline checks: the two dictionaries must stay key-for-key identical
 * (the typed registration already fails typecheck on drift, and this suite
 * catches empty values and placeholder mismatches at runtime).
 */
import { describe, expect, it } from 'vitest'

import { LOCALE_NAMESPACE, en, zh } from '../../src/client/locales'

/** Placeholder names of one template. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/gu)].map(match => match[1] ?? '').sort()
}

describe('locale dictionaries', () => {
  it('registers one namespace with both baseline locales', () => {
    expect(LOCALE_NAMESPACE).toBe('openItems')
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('has no empty copy and no untranslated duplicates', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), `en.${key}`).not.toBe('')
      expect(zh[key as keyof typeof zh]?.trim(), `zh.${key}`).not.toBe('')
    }
  })

  it('keeps placeholders identical between the two locales', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(placeholders(zh[key as keyof typeof zh] ?? ''), `zh.${key}`).toEqual(placeholders(value))
    }
  })

  it('uses sentence case for English labels (no Title Case or trailing period on labels)', () => {
    const labelKeys: readonly (keyof typeof en)[] = [
      'nav.label',
      'page.title',
      'tabs.needsYou',
      'tabs.candidates',
      'tabs.snoozed',
      'tabs.resolved',
      'controls.groupBy.session',
      'controls.groupBy.workspace',
      'controls.workspace.all',
    ]
    for (const key of labelKeys) {
      const value = en[key]
      expect(value, key).not.toMatch(/^[A-Z][a-z]+ [A-Z]/u)
      expect(value, key).not.toMatch(/\.$/u)
    }
  })

  it('covers every item kind with a chip label', () => {
    for (const kind of ['decision', 'approval', 'question', 'plan-review', 'blocker', 'risk', 'follow-up', 'task'] as const) {
      expect(en[`kind.${kind}` as keyof typeof en]).toBeTruthy()
      expect(zh[`kind.${kind}` as keyof typeof zh]).toBeTruthy()
    }
  })
})

describe('honest prose-candidate copy', () => {
  it('never promises a precise capture: no one-click, no complete inventory', () => {
    for (const [key, value] of Object.entries(en)) {
      // The end-of-turn check is a heuristic; the old "one-click confirmation"
      // copy overstated it (client audit D10).
      expect(value.toLowerCase(), key).not.toContain('one-click')
    }
    const settings = en['settings.proseCandidates.desc']
    expect(settings).toContain('can miss decisions')
    expect(settings).toContain('kind it guesses can be wrong')
    expect(en['settings.llmExtraction.desc']).toContain('refine its kind and title')
    expect(en['empty.candidates.body']).toContain('can miss some')
    expect(en['empty.candidates.body']).toContain('nested lists or tables')
    expect(en['candidates.caption']).toContain('Detected in the final message of a turn')
    expect(en['candidate.bulk.review.note']).toContain('cannot be reversed')
    expect(en['detail.candidate']).not.toContain('confirm before acting')
  })

  it('keeps the new candidate copy in both locales', () => {
    const keys = [
      'candidate.kind.inferred',
      'candidate.kind.hint',
      'candidate.title.label',
      'candidate.title.hint',
      'candidate.context.decision',
      'candidate.context.question',
      'candidate.source.title',
      'candidate.source.matched',
      'candidate.source.open',
      'candidate.options.title',
      'candidate.bulk.confirm.one',
      'candidate.bulk.confirm.other',
      'candidate.bulk.review.title',
      'candidate.bulk.review.note',
      'candidate.bulk.stale.one',
      'candidate.bulk.stale.other',
      'panel.inferred.row',
    ] as const
    for (const key of keys) {
      expect(en[key], key).toBeTruthy()
      expect(zh[key], key).toBeTruthy()
    }
  })
})
