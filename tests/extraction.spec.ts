/**
 * Opt-in model-assisted prose extraction (PLAN-remediation §12.3).
 *
 * Everything here runs against a fake structural `ctx.llm`: the extractor's
 * whole job is the bounded call and the fail-closed verdict, so the tests pin
 * the prompt, the prepared-call arguments, the budget/deadline and the
 * sanitising without any network or harness LLM runtime.
 */
import { describe, expect, it } from 'vitest'

import { Context } from '@deepseek-ai/cordis'

import { OpenItemsService } from '../src/host/service'
import { OpenItemsStore } from '../src/host/store'
import {
  EXTRACTION_MIN_CONFIDENCE,
  buildPrompt,
  createProseExtractor,
  parseVerdict,
  stripCodeFence,
  truncateToBytes,
  type ProseExtractor,
} from '../src/host/extraction'
import type { ProseExtractionInput } from '../src/host/capture-contract'
import { createFakeDomain } from './fake-domain'

const T0 = Date.UTC(2026, 10, 14, 3, 0, 0)
const DAY_MS = 24 * 60 * 60 * 1_000

/** One raw stream chunk (only `text-delta` carries text). */
interface Chunk {
  readonly type: string
  readonly text?: string
}

/** Recorded prepare/stream calls of the fake LLM. */
interface Recorded {
  readonly prepares: Record<string, unknown>[]
  readonly streams: Record<string, unknown>[]
}

/** Async generator of text-delta chunks from fixed strings. */
async function* textChunks(chunks: readonly string[]): AsyncGenerator<Chunk> {
  for (const text of chunks) yield { type: 'text-delta', text }
}

/**
 * A stream that never produces text until its signal is aborted (the deadline
 * path). Aborting rejects, exactly as a real provider stream does.
 */
async function* blockedStream(options: Record<string, unknown>): AsyncGenerator<Chunk> {
  const signal = options['signal'] as AbortSignal | undefined
  await new Promise<never>((_resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'))
      return
    }
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  yield { type: 'text-delta', text: 'never' }
}

/** Build the structural `ctx.llm` fake plus its call log. */
function fakeLlm(behaviour: {
  readonly chunks?: readonly string[]
  readonly stream?: (options: Record<string, unknown>) => AsyncIterable<Chunk>
  readonly failPrepare?: Error
} = {}): { readonly host: unknown; readonly recorded: Recorded } {
  const recorded: Recorded = { prepares: [], streams: [] }
  const host = {
    async prepareCall(config: Record<string, unknown>): Promise<{
      config: Record<string, unknown>
      stream(options: Record<string, unknown>): AsyncIterable<Chunk>
    }> {
      recorded.prepares.push(config)
      if (behaviour.failPrepare !== undefined) throw behaviour.failPrepare
      return {
        config,
        stream(options: Record<string, unknown>): AsyncIterable<Chunk> {
          recorded.streams.push(options)
          return behaviour.stream?.(options) ?? textChunks(behaviour.chunks ?? [])
        },
      }
    },
  }
  return { host, recorded }
}

/** Captured log lines (warn only; content must never appear). */
interface Harness {
  readonly ctx: Context
  readonly store: OpenItemsStore
  readonly service: OpenItemsService
  readonly logs: string[]
}

/** Mount the real store + service on a real context (LLM provided per test). */
async function mount(now: () => number = () => T0): Promise<Harness> {
  const domain = createFakeDomain()
  const ctx = new Context()
  ctx.provide('storageDomain', { open: async () => domain })
  const store = await OpenItemsStore.open(ctx, { now })
  const service = new OpenItemsService(ctx, store)
  const logs: string[] = []
  const log = {
    warn: (...args: unknown[]) => {
      logs.push(args.map(value => String(value)).join(' '))
    },
    info: () => undefined,
  }
  return { ctx, store, service, logs }
}

/** Build one extractor over the harness with sensible test config. */
function extractorFor(
  harness: Harness,
  overrides: Partial<{
    provider: string
    model: string
    dailyBudget: number
    timeoutMs: number
    maxInputBytes: number
    now: () => number
  }> = {},
): ProseExtractor | undefined {
  return createProseExtractor({
    ctx: harness.ctx,
    service: harness.service,
    config: {
      provider: overrides.provider ?? 'fake',
      model: overrides.model ?? 'fake-model',
      dailyBudget: overrides.dailyBudget ?? 20,
      timeoutMs: overrides.timeoutMs ?? 1_000,
      maxInputBytes: overrides.maxInputBytes ?? 8_192,
    },
    log: { warn: (message: string, ...args: unknown[]) => harness.logs.push([message, ...args].map(String).join(' ')) } as never,
    now: overrides.now ?? (() => T0),
  })
}

/** One candidate extraction input. */
function input(overrides: Partial<ProseExtractionInput> = {}): ProseExtractionInput {
  return {
    sessionId: 'session-1',
    title: 'Which rollout window?',
    quote: 'Which rollout window do you want?',
    text: 'The migration is ready. Which rollout window do you want?',
    ...overrides,
  }
}

/** Enable extraction through the real settings write path. */
async function enableExtraction(harness: Harness): Promise<void> {
  await harness.service.setSettings(0, { llmExtraction: true })
}

describe('construction and enablement', () => {
  it('is not installed when the deployment configures no provider/model (no egress)', async () => {
    const harness = await mount()
    expect(extractorFor(harness, { provider: '' })).toBeUndefined()
    expect(extractorFor(harness, { model: '' })).toBeUndefined()
    expect(extractorFor(harness, { provider: '', model: '' })).toBeUndefined()
  })

  it('is enabled only with the settings toggle on and provider+model configured', async () => {
    const harness = await mount()
    const { host } = fakeLlm()
    harness.ctx.provide('llm', host)
    const extractor = extractorFor(harness)!

    expect(extractor.enabled()).toBe(false)
    await enableExtraction(harness)
    expect(extractor.enabled()).toBe(true)
    await harness.service.setSettings(1, { llmExtraction: false })
    expect(extractor.enabled()).toBe(false)
    extractor.dispose()
    await harness.service.close()
  })

  it('resolves ctx.llm lazily, so a late-mounted LLM runtime still works', async () => {
    const harness = await mount()
    const extractor = extractorFor(harness)!
    await enableExtraction(harness)
    // No `llm` service yet: fail closed, no throw.
    expect(await extractor.extract(input())).toBeUndefined()

    const { host, recorded } = fakeLlm({ chunks: ['{"keep":true,"confidence":0.9}'] })
    harness.ctx.provide('llm', host)
    expect(await extractor.extract(input())).toEqual({ keep: true })
    expect(recorded.prepares).toHaveLength(1)
    extractor.dispose()
    await harness.service.close()
  })
})

describe('happy path', () => {
  it('makes one bounded one-shot call and returns the sanitized verdict', async () => {
    const harness = await mount()
    const { host, recorded } = fakeLlm({
      chunks: ['{"keep":true,"kind":"question","title":"  Which   rollout',' window?  ","confidence":0.9}'],
    })
    harness.ctx.provide('llm', host)
    const extractor = extractorFor(harness)!
    await enableExtraction(harness)

    const verdict = await extractor.extract(input())
    expect(verdict).toEqual({ keep: true, kind: 'question', title: 'Which rollout window?' })

    // Prepared config: the deployment route, deterministic sampling, small cap.
    expect(recorded.prepares).toEqual([{ provider: 'fake', model: 'fake-model', temperature: 0, maxTokens: 200 }])
    // One identity-free user message, a system instruction, no tool schemas.
    const options = recorded.streams[0]!
    expect(options).toMatchObject({
      provider: 'fake',
      model: 'fake-model',
      temperature: 0,
      maxTokens: 200,
      system: expect.stringContaining('JSON'),
    })
    expect('tools' in options).toBe(false)
    const messages = options['messages'] as { role: string; content: { type: string; text: string }[] }[]
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content[0]).toMatchObject({ type: 'text' })
    expect(messages[0]?.content[0]?.text).toContain('Which rollout window do you want?')
    extractor.dispose()
    await harness.service.close()
  })

  it('caps the assistant text at maxInputBytes in the prompt', async () => {
    const harness = await mount()
    const { host, recorded } = fakeLlm({ chunks: ['{"keep":true,"confidence":0.9}'] })
    harness.ctx.provide('llm', host)
    const extractor = extractorFor(harness, { maxInputBytes: 64 })!
    await enableExtraction(harness)

    await extractor.extract(input({ text: 'y'.repeat(500) }))
    const options = recorded.streams[0]!
    const messages = options['messages'] as { content: { text: string }[] }[]
    const prompt = messages[0]?.content[0]?.text ?? ''
    expect(prompt).toContain('y'.repeat(64))
    expect(prompt).not.toContain('y'.repeat(65))
    // The prefix is the only extra content beyond the capped tail.
    expect(prompt.length).toBeLessThan(64 + 200)
    extractor.dispose()
    await harness.service.close()
  })

  it('returns keep:false without refining fields when the model drops the candidate', async () => {
    const harness = await mount()
    const { host } = fakeLlm({ chunks: ['```json\n{"keep":false,"kind":"decision","title":"ignored","confidence":0.8}\n```'] })
    harness.ctx.provide('llm', host)
    const extractor = extractorFor(harness)!
    await enableExtraction(harness)
    // Fenced JSON is accepted, and a dropped candidate carries no refinement.
    expect(await extractor.extract(input())).toEqual({ keep: false })
    extractor.dispose()
    await harness.service.close()
  })
})

describe('failure paths fail closed (undefined keeps the gate candidate)', () => {
  it('returns undefined when the settings toggle is off and never calls the model', async () => {
    const harness = await mount()
    const { host, recorded } = fakeLlm({ chunks: ['{"keep":false,"confidence":0.99}'] })
    harness.ctx.provide('llm', host)
    const extractor = extractorFor(harness)!
    expect(await extractor.extract(input())).toBeUndefined()
    expect(recorded.prepares).toHaveLength(0)
    extractor.dispose()
    await harness.service.close()
  })

  it('returns undefined for malformed JSON, a missing/invalid shape and low confidence', async () => {
    const cases = [
      'not json at all',
      '{"keep":"yes","confidence":0.9}',
      '{"keep":true}',
      '{"keep":true,"confidence":"high"}',
      `{"keep":true,"confidence":${EXTRACTION_MIN_CONFIDENCE - 0.1}}`,
      '[]',
      'null',
      '',
    ]
    for (const raw of cases) {
      // A fresh context per case: the fake `llm` service is registered once.
      const harness = await mount()
      await enableExtraction(harness)
      const { host, recorded } = fakeLlm({ chunks: [raw] })
      harness.ctx.provide('llm', host)
      const extractor = extractorFor(harness)!
      expect(await extractor.extract(input()), raw).toBeUndefined()
      expect(recorded.prepares).toHaveLength(1)
      extractor.dispose()
      await harness.service.close()
    }
  })

  it('keeps the verdict at the confidence boundary', async () => {
    const harness = await mount()
    const { host } = fakeLlm({ chunks: [`{"keep":true,"confidence":${EXTRACTION_MIN_CONFIDENCE}}`] })
    harness.ctx.provide('llm', host)
    const extractor = extractorFor(harness)!
    await enableExtraction(harness)
    expect(await extractor.extract(input())).toEqual({ keep: true })
    extractor.dispose()
    await harness.service.close()
  })

  it('returns undefined (no throw) when preparation or the stream fails, and never logs content', async () => {
    const secret = 'SECRET-ASSISTANT-TEXT-DO-NOT-LOG'

    const prepareHarness = await mount()
    await enableExtraction(prepareHarness)
    const prepareFailure = fakeLlm({ failPrepare: new Error(`route missing: ${secret}`) })
    prepareHarness.ctx.provide('llm', prepareFailure.host)
    const first = extractorFor(prepareHarness)!
    await expect(first.extract(input({ text: secret }))).resolves.toBeUndefined()
    first.dispose()
    expect(prepareHarness.logs.length).toBeGreaterThan(0)
    expect(prepareHarness.logs.join('\n')).not.toContain(secret)
    await prepareHarness.service.close()

    const streamHarness = await mount()
    await enableExtraction(streamHarness)
    const streamFailure = fakeLlm({
      stream: () => (async function* fail(): AsyncGenerator<Chunk> {
        yield { type: 'text-delta', text: '{"keep":' }
        throw new Error(`stream broke: ${secret}`)
      })(),
    })
    streamHarness.ctx.provide('llm', streamFailure.host)
    const second = extractorFor(streamHarness)!
    await expect(second.extract(input({ text: secret }))).resolves.toBeUndefined()
    second.dispose()
    expect(streamHarness.logs.length).toBeGreaterThan(0)
    expect(streamHarness.logs.join('\n')).not.toContain(secret)
    await streamHarness.service.close()
  })

  it('returns undefined when no llm service is mounted', async () => {
    const harness = await mount()
    await enableExtraction(harness)
    const extractor = extractorFor(harness)!
    await expect(extractor.extract(input())).resolves.toBeUndefined()
    extractor.dispose()
    await harness.service.close()
  })
})

describe('budget and deadline bounds', () => {
  it('skips calls at the UTC-day budget and resets on the next UTC day', async () => {
    const harness = await mount()
    const { host, recorded } = fakeLlm({ chunks: ['{"keep":true,"confidence":0.9}'] })
    harness.ctx.provide('llm', host)
    let clock = T0
    const extractor = extractorFor(harness, { dailyBudget: 1, now: () => clock })!
    await enableExtraction(harness)

    expect(await extractor.extract(input())).toEqual({ keep: true })
    // Over budget: no model call, no cost, candidate unchanged.
    expect(await extractor.extract(input())).toBeUndefined()
    expect(recorded.prepares).toHaveLength(1)

    clock += DAY_MS
    expect(await extractor.extract(input())).toEqual({ keep: true })
    expect(recorded.prepares).toHaveLength(2)
    extractor.dispose()
    await harness.service.close()
  })

  it('a zero budget disables calls without changing the settings toggle', async () => {
    const harness = await mount()
    const { host, recorded } = fakeLlm({ chunks: ['{"keep":true,"confidence":0.9}'] })
    harness.ctx.provide('llm', host)
    const extractor = extractorFor(harness, { dailyBudget: 0 })!
    await enableExtraction(harness)
    expect(extractor.enabled()).toBe(true)
    expect(await extractor.extract(input())).toBeUndefined()
    expect(recorded.prepares).toHaveLength(0)
    extractor.dispose()
    await harness.service.close()
  })

  it('aborts at the deadline and returns undefined instead of hanging', async () => {
    const harness = await mount()
    const { host, recorded } = fakeLlm({ stream: blockedStream })
    harness.ctx.provide('llm', host)
    const extractor = extractorFor(harness, { timeoutMs: 25 })!
    await enableExtraction(harness)

    const started = Date.now()
    await expect(extractor.extract(input())).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2_000)
    const signal = recorded.streams[0]?.['signal'] as AbortSignal | undefined
    expect(signal?.aborted).toBe(true)
    extractor.dispose()
    await harness.service.close()
  })

  it('dispose aborts an in-flight call and stops accepting new ones', async () => {
    const harness = await mount()
    const { host, recorded } = fakeLlm({ stream: blockedStream })
    harness.ctx.provide('llm', host)
    const extractor = extractorFor(harness, { timeoutMs: 10_000 })!
    await enableExtraction(harness)

    const pending = extractor.extract(input())
    await new Promise(resolve => setTimeout(resolve, 10))
    extractor.dispose()
    await expect(pending).resolves.toBeUndefined()
    expect(recorded.streams[0]?.['signal']).toMatchObject({ aborted: true })
    expect(extractor.enabled()).toBe(false)
    expect(await extractor.extract(input())).toBeUndefined()
    await harness.service.close()
  })
})

describe('pure helpers', () => {
  it('truncates by UTF-8 bytes, not code units', () => {
    expect(truncateToBytes('abc', 10)).toBe('abc')
    expect(truncateToBytes('abcdef', 3)).toBe('abc')
    // Three-byte characters: 2 fit in 7 bytes, 3 do not.
    expect(truncateToBytes('日本語', 7)).toBe('日本')
    expect(truncateToBytes('abc', 0)).toBe('')
  })

  it('builds an untrusted-data prompt and strips one code fence', () => {
    expect(buildPrompt('hello', 100)).toContain('untrusted data')
    expect(buildPrompt('hello', 100)).toContain('hello')
    expect(stripCodeFence('```json\n{"keep":true}\n```')).toBe('{"keep":true}')
    expect(stripCodeFence('{"keep":true}')).toBe('{"keep":true}')
    expect(stripCodeFence('```\n{}\n```')).toBe('{}')
  })

  it('sanitizes a verdict title: whitespace collapsed, capped at 120 chars', () => {
    expect(parseVerdict('{"keep":true,"kind":"risk","title":"  a   b  ","confidence":0.9}'))
      .toEqual({ keep: true, title: 'a b' })
    const long = parseVerdict(JSON.stringify({ keep: true, title: 'x'.repeat(200), confidence: 0.9 }))
    expect(long).toEqual({ keep: true, title: 'x'.repeat(120) })
  })
})
