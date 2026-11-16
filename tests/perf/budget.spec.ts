/**
 * M6 performance guards.
 *
 * Hermetic by default (skipped unless `OI_PERF=1`): these are budget checks on
 * this machine, not correctness tests. Run them with
 *
 *     OI_PERF=1 ./node_modules/.bin/vitest run tests/perf
 *
 * Two budgets:
 * 1. **Read path at cap** — 5,000 resolved records across 100 sessions in a fake
 *    domain; the snapshot, the register page and the resolved list must stay
 *    under the generous 150 ms p95 budget at the design cap (DESIGN §7.4.4 uses
 *    5,000 as the resolution safety cap; the views scan in memory, no indexes).
 * 2. **Fold throughput** — the projection fold over roughly the recorded corpus
 *    size (118 sessions / ~98k events, task-20 acceptance measurement) so the
 *    backfill's projected wall time is a number, not a promise.
 *
 * The measured numbers are committed to `docs/perf.md`; this file prints them.
 *
 * @module tests/perf/budget.spec
 */
import { describe, expect, it } from 'vitest'

import { Context } from '@deepseek-ai/cordis'

import { createCaptureDriver } from '../../src/host/capture'
import { OpenItemsService } from '../../src/host/service'
import { OpenItemsStore } from '../../src/host/store'
import type { CaptureEvent } from '../../src/host/capture-contract'
import type { OpenItemRecord } from '../../src/shared/schema'
import { parseItemRecord } from '../../src/shared/records'
import { FakeSink, sessionInfo } from '../capture/fakes'
import { createFakeDomain, fakeContext } from '../fake-domain'

const ENABLED = process.env['OI_PERF'] === '1'

/** Read-path budget (milliseconds, p95). */
const READ_BUDGET_MS = 150
/** Fold-throughput floor (events/second); a pathological regression trips it. */
const MIN_FOLD_EVENTS_PER_SECOND = 5_000

/** Base timestamp for synthetic records. */
const T0 = 1_760_000_000_000
/** Fixed clock so timings exclude clock noise. */
const NOW = T0 + 1_000_000

/** Recorded acceptance corpus scope (task-20 acceptance run). */
const CORPUS = { sessions: 118, events: 97_755, inheritedEvents: 5_587 } as const

/**
 * Build one resolved record at the design cap shape.
 * @param index - record index.
 * @param sessionCount - number of distinct sessions to spread across.
 * @returns the validated record.
 */
function resolvedRecord(index: number, sessionCount: number): OpenItemRecord {
  const sessionIndex = index % sessionCount
  const workspaceIndex = sessionIndex % 10
  const id = `0199${index.toString(16).padStart(8, '0')}-7000-7000-8000-${(index % 1_000_000)
    .toString(16).padStart(12, '0')}`
  return parseItemRecord({
    schemaVersion: 3,
    id,
    origin: 'install-perf',
    kind: index % 3 === 0 ? 'decision' : index % 3 === 1 ? 'approval' : 'question',
    state: 'resolved',
    tier: 'structural',
    severity: (index % 3) + 1,
    title: `Resolved decision ${index}`,
    body: `The answer for decision ${index}.`,
    source: {
      sessionId: `session-${sessionIndex}`,
      sessionTitle: `Session ${sessionIndex}`,
      workspace: { workspaceId: `workspace-${workspaceIndex}`, title: `Workspace ${workspaceIndex}`, path: `/work/${workspaceIndex}` },
    },
    blocking: true,
    reply: { controls: ['text'], freeText: true, requiresConfirm: false },
    deliveries: [{
      deliveryId: `delivery-${index}`,
      at: T0 + index,
      track: 'client-settle',
      payload: { type: 'text', text: `answer ${index}` },
      state: 'settled',
    }],
    occurrences: [{ sessionId: `session-${sessionIndex}`, seenAt: T0 }],
    dedupeKey: `perf|${index}`,
    detectedBy: ['tool'],
    firstSeenAt: T0,
    lastSeenAt: T0 + index,
    updatedAt: T0 + index,
    version: 2,
    resolution: {
      kind: 'answered',
      at: T0 + index,
      actor: 'user',
      payload: { type: 'text', text: `answer ${index}` },
    },
    acknowledgement: { state: 'observed', at: T0 + index, evidence: { kind: 'next-turn' } },
    resolvedAt: T0 + index,
    reopenCount: 0,
    retention: { class: 'active' },
    history: [{ at: T0, action: 'raised' }, { at: T0 + index, action: 'answered' }],
  })
}

/**
 * Percentile of a duration sample.
 * @param samples - sorted durations in ms.
 * @param percentile - 0..1.
 * @returns the percentile duration.
 */
function percentile(samples: readonly number[], percentileValue: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1))
  return sorted[index] ?? 0
}

/**
 * Time one operation repeatedly and return its samples.
 * @param iterations - measured iterations.
 * @param operation - operation to await.
 * @returns durations in milliseconds.
 */
async function measure(iterations: number, operation: () => void | Promise<void>): Promise<number[]> {
  const samples: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now()
    await operation()
    samples.push(performance.now() - start)
  }
  return samples
}

/**
 * Build a fold workload of roughly the recorded corpus size.
 * @param sessions - number of root sessions.
 * @param eventsPerSession - approval pairs per session (each pair is 2 events).
 * @returns sessions with their synthetic event logs.
 */
function foldWorkload(sessions: number, eventsPerSession: number): { info: ReturnType<typeof sessionInfo>; events: CaptureEvent[] }[] {
  return Array.from({ length: sessions }, (_, sessionIndex) => {
    const events: CaptureEvent[] = []
    let seq = 0
    for (let pair = 0; pair < eventsPerSession; pair += 1) {
      const approvalId = `approval-${sessionIndex}-${pair}`
      const callId = `call-${sessionIndex}-${pair}`
      events.push({
        seq: seq++,
        type: 'approval/asked',
        time: T0 + sessionIndex * 10_000 + pair,
        data: { id: approvalId, toolName: 'bash', callId },
      })
      events.push({
        seq: seq++,
        type: 'approval/decided',
        time: T0 + sessionIndex * 10_000 + pair,
        data: { id: approvalId, outcome: 'rejected' },
      })
    }
    return {
      info: sessionInfo(`session-${sessionIndex}`, { title: `Session ${sessionIndex}`, updatedAt: NOW }),
      events,
    }
  })
}

describe.skipIf(!ENABLED)('performance budgets (OI_PERF=1)', () => {
  it('keeps the read path inside the 150 ms p95 budget at 5,000 resolved records', async () => {
    const sessionCount = 100
    const recordCount = 5_000
    const records = Array.from({ length: recordCount }, (_, index) => resolvedRecord(index, sessionCount))
    const domain = createFakeDomain({ records: { items: records } })
    const ctx = new Context()
    ctx.provide('storageDomain', { open: async () => domain })
    const store = await OpenItemsStore.open(ctx, { now: () => NOW })
    const service = new OpenItemsService(ctx, store)
    expect(service.register({ limit: 1 }).total).toBe(recordCount)

    const iterations = 30
    // Warm up the JIT and the view projections.
    for (let index = 0; index < 3; index += 1) {
      service.list({ status: 'resolved', limit: 50 })
      service.register({ limit: 50 })
    }

    const snapshotSamples = await measure(iterations, () => {
      service.list({})
    })
    const resolvedSamples = await measure(iterations, () => {
      service.list({ status: 'resolved', limit: 50 })
    })
    const registerSamples = await measure(iterations, () => {
      service.register({ limit: 50 })
    })

    const report = {
      records: recordCount,
      sessions: sessionCount,
      snapshot: { p50: percentile(snapshotSamples, 0.5), p95: percentile(snapshotSamples, 0.95), max: Math.max(...snapshotSamples) },
      resolvedPage: { p50: percentile(resolvedSamples, 0.5), p95: percentile(resolvedSamples, 0.95), max: Math.max(...resolvedSamples) },
      registerPage: { p50: percentile(registerSamples, 0.5), p95: percentile(registerSamples, 0.95), max: Math.max(...registerSamples) },
    }
    console.log(`[perf] read path @ ${recordCount} resolved / ${sessionCount} sessions: ${JSON.stringify(report)}`)

    expect(report.snapshot.p95).toBeLessThan(READ_BUDGET_MS)
    expect(report.resolvedPage.p95).toBeLessThan(READ_BUDGET_MS)
    expect(report.registerPage.p95).toBeLessThan(READ_BUDGET_MS)
    await service.close()
  }, 120_000)

  it('folds about the recorded corpus size at a usable throughput', async () => {
    const workload = foldWorkload(CORPUS.sessions, 414)
    const eventCount = workload.reduce((total, session) => total + session.events.length, 0)
    const sink = new FakeSink()
    const driver = createCaptureDriver({ sink, source: 'log-fold', now: () => NOW, batchSize: 100 })

    const startedAt = performance.now()
    for (const session of workload) await driver.driveSession(session.info, session.events)
    const durationMs = performance.now() - startedAt
    await driver.flush()

    const eventsPerSecond = Math.round(eventCount / (durationMs / 1000))
    const projectedCorpusMs = Math.round((CORPUS.events / eventsPerSecond) * 1000)
    const report = {
      sessions: workload.length,
      events: eventCount,
      drafts: sink.opens.length,
      durationMs: Number(durationMs.toFixed(1)),
      eventsPerSecond,
      recordedCorpus: CORPUS,
      projectedCorpusMs,
      projectedCorpusSeconds: Number((projectedCorpusMs / 1000).toFixed(1)),
    }
    console.log(`[perf] fold throughput: ${JSON.stringify(report)}`)

    expect(eventCount).toBeGreaterThan(90_000)
    expect(eventsPerSecond).toBeGreaterThan(MIN_FOLD_EVENTS_PER_SECOND)
  }, 120_000)
})

describe.skipIf(ENABLED)('performance budgets (gated)', () => {
  it('is skipped without OI_PERF=1', () => {
    expect(ENABLED).toBe(false)
  })
})
