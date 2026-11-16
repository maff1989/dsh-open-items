/**
 * Pure prose-gate text helpers (prose-audit remediation §1.1).
 *
 * Every helper here is a pure `string → value` function, so the gate's
 * structure parsing and Markdown projection are pinned directly instead of only
 * through a whole-message fixture. The corpus shapes covered: bold-labelled ask
 * bullets, nested sub-bullets, ordered items, fenced code, links, inline code,
 * and the two false-positive heading families the tight anchor must reject.
 *
 * @module tests/capture/prose-text.spec
 */

import { describe, expect, it } from 'vitest'

import {
  classifyAsk,
  extractOptions,
  findTrailingAskSection,
  firstSentence,
  isAskLike,
  listBlocks,
  markdownToText,
  sentencesOf,
  splitLabel,
  stripFencedBlocks,
  truncateWords,
} from '../../src/host/folds/prose-text'

describe('stripFencedBlocks', () => {
  it('removes a closed fence and an unterminated trailing fence', () => {
    expect(stripFencedBlocks('before\n```ts\nconst x = 1\n```\nafter')).toBe('before\n \nafter')
    expect(stripFencedBlocks('before\n~~~\ncode\n~~~')).toBe('before\n ')
    expect(stripFencedBlocks('before\n```ts\nnever closed')).toBe('before\n ')
  })
})

describe('markdownToText', () => {
  it('projects headings, list markers, emphasis, code and links to one line', () => {
    const text = [
      '## Decisions I need from you',
      '',
      '- **A** — reuse `settled:true`, see [the design](https://example.test/x).',
      '1) _italic_ and *emphasis* and <b>html</b>.',
    ].join('\n')
    expect(markdownToText(text)).toBe(
      'Decisions I need from you A — reuse settled:true, see the design. italic and emphasis and html.',
    )
  })

  it('keeps underscores that are part of an identifier', () => {
    expect(markdownToText('keep `derived_key` and snake_case_intact')).toBe('keep derived_key and snake_case_intact')
  })

  it('collapses whitespace and trims', () => {
    expect(markdownToText('  a \n\n  b\t c  ')).toBe('a b c')
  })
})

describe('splitLabel', () => {
  const cases: readonly { readonly name: string; readonly text: string; readonly label?: string; readonly body: string }[] = [
    { name: 'bold label', text: 'A — Ship it as one PR.', label: 'A', body: 'Ship it as one PR.' },
    { name: 'raw bullet marker', text: '- A — Ship it as one PR.', label: 'A', body: 'Ship it as one PR.' },
    { name: 'plain letter em dash', text: 'E — Ship together or split.', label: 'E', body: 'Ship together or split.' },
    { name: 'letter colon', text: 'C: Should this be refused?', label: 'C', body: 'Should this be refused?' },
    { name: 'parenthesised label', text: '(b) introduce the variant', label: 'b', body: 'introduce the variant' },
    { name: 'ordered label', text: '1) Run the ladder.', label: '1', body: 'Run the ladder.' },
    { name: 'ordered dot label', text: '2. Wire the route.', label: '2', body: 'Wire the route.' },
    { name: 'bare word is not a label', text: 'Card dismiss receipt: reuse it.', body: 'Card dismiss receipt: reuse it.' },
    { name: 'A followed by a word is not a label', text: 'A decision framework for cadence', body: 'A decision framework for cadence' },
    { name: 'empty body keeps the whole text', text: 'A —', body: 'A —' },
  ]
  for (const entry of cases) {
    it(entry.name, () => {
      const result = splitLabel(entry.text)
      expect(result.label).toBe(entry.label)
      expect(result.body).toBe(entry.body)
    })
  }
})

describe('listBlocks', () => {
  it('keeps nested sub-bullets inside the parent item', () => {
    const blocks = listBlocks([
      '- **A** — first ask',
      '  - a nested detail asking (a) keep it or (b) drop it?',
      '  - second nested detail',
      '- **B** — second ask?',
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.text).toContain('a nested detail')
    expect(blocks[0]?.text).toContain('second nested detail')
    expect(blocks[1]?.text).toBe('B — second ask?')
  })

  it('attaches indented continuation lines and separates blocks on a blank line', () => {
    const blocks = listBlocks([
      '- **A** — first ask',
      '  continuation of A',
      '',
      '1. first ordered',
      '2. second ordered',
    ])
    expect(blocks).toHaveLength(3)
    expect(blocks[0]?.text).toBe('A — first ask continuation of A')
    expect(blocks[1]?.text).toBe('first ordered')
    expect(blocks[2]?.text).toBe('second ordered')
  })

  it('treats an item at a shallower indent as a new top-level block', () => {
    const blocks = listBlocks([
      '  - parent',
      '    - child stays nested',
      '- sibling at the top level',
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.text).toContain('child stays nested')
    expect(blocks[1]?.text).toBe('sibling at the top level')
  })

  it('ignores prose outside a list and bounds an item to 600 characters', () => {
    const blocks = listBlocks(['Intro line', '- ' + 'word '.repeat(300)])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.raw.length).toBeLessThanOrEqual(600)
  })
})

describe('findTrailingAskSection', () => {
  const askHeadings = [
    '## Decisions I need from you',
    '## Open questions',
    '### Questions to resolve',
    '## Your call',
    '## Sign-off',
    '## Confirmations',
    '## Asks',
    '## 2. Decisions',
  ]
  for (const heading of askHeadings) {
    it(`accepts ${JSON.stringify(heading)}`, () => {
      const lines = [heading, '', '- **A** — choose (a) keep or (b) drop?']
      const section = findTrailingAskSection(lines)
      expect(section).toBeDefined()
      expect(section?.lines).toEqual(['', '- **A** — choose (a) keep or (b) drop?'])
      expect(section?.heading.length).toBeGreaterThan(0)
    })
  }

  it('rejects a heading that merely contains "decision"', () => {
    expect(findTrailingAskSection(['### 10. A decision framework for choosing your cadence', '', '- keep PRs small']))
      .toBeUndefined()
  })

  it('rejects a heading that recounts an earlier decision', () => {
    expect(findTrailingAskSection(['### From the tag/version decision (2026-11-14)', '', '- promote the row']))
      .toBeUndefined()
  })

  it('uses the last heading among the final 80 non-empty lines', () => {
    const lines = [
      '## Decisions I need from you',
      '',
      '- **A** — ship it?',
      '',
      '## Next steps',
      '',
      '1. run the ladder',
    ]
    expect(findTrailingAskSection(lines)).toBeUndefined()
  })

  it('reports the heading level and returns no section without a heading', () => {
    const section = findTrailingAskSection(['## Decisions', '', '- A — x'])
    expect(section?.level).toBe(2)
    expect(findTrailingAskSection(['just prose', 'more prose'])).toBeUndefined()
  })
})

describe('classifyAsk', () => {
  it('prefers explicit labelled alternatives over everything else', () => {
    expect(classifyAsk('reuse settled:true, or introduce a variant?', 'Open questions')).toBe('decision')
    expect(classifyAsk('Choose between (a) reuse it or (b) rebuild it.', '')).toBe('decision')
    expect(classifyAsk('Ship as either one PR or two?', '')).toBe('decision')
  })

  it('does not treat cumulative "(1) + (2)" work as alternatives', () => {
    expect(classifyAsk('Want me to implement (1) + (2)?', '')).toBe('question')
  })

  it('uses a questions-like heading before the interrogative rule', () => {
    expect(classifyAsk('Ship the card fix now, or leave it?', 'Open questions')).toBe('decision')
    expect(classifyAsk('What should the title be?', 'Questions to resolve')).toBe('question')
    expect(classifyAsk('What should the title be?', '')).toBe('question')
  })

  it('uses a decisions-like heading before the interrogative rule', () => {
    expect(classifyAsk('Should dismiss also be refused for archived rows?', 'Decisions I need from you')).toBe('decision')
    expect(classifyAsk('Approve the plan as written?', 'Sign-off')).toBe('decision')
  })

  it('classifies an interrogative without alternatives as a question', () => {
    expect(classifyAsk('Do you want me to run the ladder now?', '')).toBe('question')
    expect(classifyAsk('Which window should the release use？', '')).toBe('question')
  })

  it('defaults a non-interrogative imperative to a decision', () => {
    expect(classifyAsk('Let me know whether the note should mention the settings page.', '')).toBe('decision')
    expect(classifyAsk('Pick the smaller scope.', '')).toBe('decision')
  })
})

describe('extractOptions', () => {
  it('extracts labelled alternatives with their labels, dropping the recommendation', () => {
    const item = "Card dismiss receipt: (a) reuse settled:{outcome:'applied'} (smallest diff), or "
      + "(b) introduce a kind:'dismissed' variant for precise typing. I recommend (a)."
    expect(extractOptions(item)).toEqual([
      "(a) reuse settled:{outcome:'applied'} (smallest diff)",
      "(b) introduce a kind:'dismissed' variant for precise typing.",
    ])
  })

  it('extracts a clean either-or split without labels', () => {
    expect(extractOptions('Ship it as either one PR or two separate PRs.')).toEqual(['one PR', 'two separate PRs'])
  })

  it('never fabricates options for a yes/no question', () => {
    expect(extractOptions('Should dismiss also be refused for archived rows?')).toBeUndefined()
    expect(extractOptions('Add an Undo action, or leave Undo to the page toast only?')).toBeUndefined()
  })

  it('caps labelled alternatives at four and each option at 200 characters', () => {
    const item = '(a) alpha, (b) beta, (c) gamma, (d) delta, (e) epsilon'
    const options = extractOptions(item) ?? []
    expect(options).toHaveLength(4)
    for (const option of options) expect(option.length).toBeLessThanOrEqual(200)
    const long = `(a) ${'word '.repeat(80)}, or (b) short`
    const longOptions = extractOptions(long) ?? []
    expect(longOptions.length).toBeGreaterThan(0)
    for (const option of longOptions) expect(option.length).toBeLessThanOrEqual(200)
  })
})

describe('isAskLike', () => {
  it('accepts questions, strong cues and explicit alternatives', () => {
    expect(isAskLike('Ship it as one PR or two?', true)).toBe(true)
    expect(isAskLike('Let me know which layout you prefer.', false)).toBe(true)
    expect(isAskLike('reuse A, or introduce B', true)).toBe(true)
  })

  it('accepts a labelled recommendation-only item and drops an unlabelled context row', () => {
    expect(isAskLike('reuse the settled state.', true)).toBe(true)
    expect(isAskLike('Deliberately not done: remove the card.', false)).toBe(false)
  })
})

describe('sentencesOf, firstSentence and truncateWords', () => {
  it('splits on ASCII and full-width sentence terminators', () => {
    expect(sentencesOf('One. Two? Three！ Four')).toEqual(['One.', 'Two?', 'Three！', 'Four'])
  })

  it('takes the first sentence without its trailing text', () => {
    expect(firstSentence('A — Card receipt: reuse (a), or (b)? I recommend (a).'))
      .toBe('A — Card receipt: reuse (a), or (b)?')
    expect(firstSentence('No terminator here')).toBe('No terminator here')
  })

  it('truncates on a word or clause boundary with an ellipsis', () => {
    expect(truncateWords('one two three four five', 12)).toBe('one two…')
    expect(truncateWords('short', 10)).toBe('short')
    expect(truncateWords('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`)
    for (const max of [10, 40, 120, 300]) {
      expect(truncateWords('word '.repeat(100), max).length).toBeLessThanOrEqual(max)
    }
  })
})
