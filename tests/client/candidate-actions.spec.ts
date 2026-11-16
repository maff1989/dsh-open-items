/**
 * Candidate lifecycle actions: the two controls call the CAS endpoints with the
 * version the row showed, re-read the inbox on every outcome, and report the
 * result honestly through the app-scoped notice host.
 */
import { describe, expect, it, vi } from 'vitest'

import { createCandidateActions, type CandidateActionsDeps, type CandidatePromotePatch, type CandidateTarget } from '../../src/client/data/candidate-actions'
import type { CandidateTransport } from '../../src/client/data/transport'
import { OpenItemsRpcError } from '../../src/client/data/transport'
import type { OpenItemRecord } from '../../src/shared/schema'
import type { PromoteRequest, SuppressRequest } from '../../src/shared/protocol'
import { en } from '../../src/client/locales'
import type { CandidateNoticeKey } from '../../src/client/data/candidate-actions'

/** Substitute `{name}` placeholders the way the locale runtime does. */
function fill(template: string, params?: Record<string, string>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => params[name] ?? match)
}

/** A translate over the real English dictionary, narrowed to this module's keys. */
const translate = (key: CandidateNoticeKey, params?: Record<string, string>): string =>
  fill(en[key as keyof typeof en], params)

/** One candidate record at a known version. */
function candidate(overrides: Partial<OpenItemRecord> = {}): OpenItemRecord {
  return {
    id: 'candidate-1',
    tier: 'candidate',
    title: 'Also update the docs?',
    version: 7,
    ...overrides,
  } as OpenItemRecord
}

/** Injection points with spies; each test overrides the transport. */
function deps(transport: CandidateTransport): CandidateActionsDeps & {
  readonly refresh: ReturnType<typeof vi.fn>
  readonly notices: { tone: string; text: string }[]
} {
  const notices: { tone: string; text: string }[] = []
  const refresh = vi.fn()
  return {
    transport,
    refresh,
    notices,
    notify: notice => { notices.push({ tone: notice.tone, text: notice.text }) },
    translate,
  }
}

/** A candidate transport whose two writes each test states. */
function fakeTransport(overrides: Partial<CandidateTransport> = {}): CandidateTransport & {
  readonly promoted: PromoteRequest[]
  readonly suppressed: SuppressRequest[]
} {
  const promoted: PromoteRequest[] = []
  const suppressed: SuppressRequest[] = []
  return {
    promoted,
    suppressed,
    async promote(request) {
      promoted.push(request)
      return { item: candidate() }
    },
    async suppress(request) {
      suppressed.push(request)
      return { item: candidate() }
    },
    ...overrides,
  }
}

describe('createCandidateActions', () => {
  it('promotes with the candidate id and the version the row showed', async () => {
    const transport = fakeTransport()
    const options = deps(transport)
    const actions = createCandidateActions(options)
    await expect(actions.promote(candidate())).resolves.toEqual({ ok: true })
    expect(transport.promoted).toEqual([{ itemId: 'candidate-1', expectedVersion: 7 }])
    expect(options.refresh).toHaveBeenCalledTimes(1)
    expect(options.notices).toEqual([
      { tone: 'ok', text: en['candidate.notice.promoted'].replace('{title}', 'Also update the docs?') },
    ])
  })

  it('suppresses with the candidate id and version, and says it is not an item', async () => {
    const transport = fakeTransport()
    const options = deps(transport)
    const actions = createCandidateActions(options)
    await expect(actions.suppress(candidate())).resolves.toEqual({ ok: true })
    expect(transport.suppressed).toEqual([{ itemId: 'candidate-1', expectedVersion: 7 }])
    expect(options.refresh).toHaveBeenCalledTimes(1)
    expect(options.notices).toEqual([
      { tone: 'ok', text: en['candidate.notice.suppressed'].replace('{title}', 'Also update the docs?') },
    ])
  })

  it('returns a refused write for the row/detail to keep, resyncs the list, and does not toast it', async () => {
    const transport = fakeTransport({
      async promote() {
        throw new OpenItemsRpcError('conflict', 'it changed since you saw it')
      },
    })
    const options = deps(transport)
    const actions = createCandidateActions(options)
    await expect(actions.promote(candidate())).resolves.toEqual({
      ok: false,
      message: fill(en['candidate.notice.conflict'], { title: 'Also update the docs?' }),
    })
    expect(options.refresh).toHaveBeenCalledTimes(1)
    // Failures live beside the row/detail, not only in a vanishing toast.
    expect(options.notices).toEqual([])
  })

  it('returns the route message for a non-conflict failure', async () => {
    const transport = fakeTransport({
      async suppress() {
        throw new Error('carrier refused')
      },
    })
    const options = deps(transport)
    const actions = createCandidateActions(options)
    await expect(actions.suppress(candidate())).resolves.toEqual({
      ok: false,
      message: fill(en['candidate.notice.failed'], { title: 'Also update the docs?', message: 'carrier refused' }),
    })
    expect(options.notices).toEqual([])
  })

  it('asks the transport for nothing else: no reason is invented for suppression', async () => {
    const transport = fakeTransport()
    const actions = createCandidateActions(deps(transport))
    await actions.suppress(candidate({ id: 'cand-2', version: 3 }))
    expect(transport.suppressed).toEqual([{ itemId: 'cand-2', expectedVersion: 3 }])
  })
})

describe('candidate corrections and the bulk batch', () => {
  /** The raw markdown title a prose gate can store. */
  const rawTitle = '- **E** — Ship together as one PR/branch or two (host semantics vs card client)?'

  it('sends the chosen kind and edited title with the confirm write', async () => {
    const transport = fakeTransport()
    const options = deps(transport)
    const actions = createCandidateActions(options)
    const item = candidate({ title: rawTitle })
    const patch: CandidatePromotePatch = { kind: 'decision', title: 'E — Ship together or separately?' }
    await expect(actions.promote(item, patch)).resolves.toEqual({ ok: true })
    expect(transport.promoted).toEqual([{ itemId: 'candidate-1', expectedVersion: 7, patch }])
    // The notice names the plain title — never the raw markdown and never a
    // discarded draft: the edited title is what the user chose to persist.
    expect(options.notices).toEqual([
      { tone: 'ok', text: en['candidate.notice.promoted'].replace('{title}', 'E — Ship together or separately?') },
    ])
  })

  it('projects the notice title when the candidate has no correction', async () => {
    const transport = fakeTransport()
    const options = deps(transport)
    const actions = createCandidateActions(options)
    await actions.promote(candidate({ title: rawTitle }))
    expect(transport.promoted).toEqual([{ itemId: 'candidate-1', expectedVersion: 7 }])
    expect(options.notices[0]?.text).not.toContain('**')
    expect(options.notices[0]?.text).toContain('E — Ship together')
  })

  it('confirms a batch with exactly one inbox refresh', async () => {
    const transport = fakeTransport()
    const options = deps(transport)
    const actions = createCandidateActions(options)
    const targets: CandidateTarget[] = [
      { item: candidate({ id: 'cand-1', version: 2 }), patch: { kind: 'decision' } },
      { item: candidate({ id: 'cand-2', version: 4 }) },
    ]
    await expect(actions.promoteMany(targets)).resolves.toEqual({ confirmed: 2, failed: 0, failures: [] })
    expect(transport.promoted).toEqual([
      { itemId: 'cand-1', expectedVersion: 2, patch: { kind: 'decision' } },
      { itemId: 'cand-2', expectedVersion: 4 },
    ])
    // N confirms cost one re-read, never N+1.
    expect(options.refresh).toHaveBeenCalledTimes(1)
    expect(options.notices).toEqual([
      { tone: 'ok', text: en['candidate.bulk.promoted.other'].replace('{count}', '2') },
    ])
  })

  it('keeps confirming after a refusal and reports honest batch counts', async () => {
    let call = 0
    const transport = fakeTransport({
      async promote(request) {
        call += 1
        if (call === 1) throw new OpenItemsRpcError('conflict', 'stale')
        return { item: candidate() }
      },
    })
    const options = deps(transport)
    const actions = createCandidateActions(options)
    const result = await actions.promoteMany([{ item: candidate({ id: 'cand-1' }) }, { item: candidate({ id: 'cand-2' }) }])
    expect(result).toMatchObject({
      confirmed: 1,
      failed: 1,
      failures: [{ itemId: 'cand-1', message: fill(en['candidate.notice.conflict'], { title: 'Also update the docs?' }) }],
    })
    expect(options.refresh).toHaveBeenCalledTimes(1)
    expect(options.notices).toHaveLength(1)
  })
})
