/**
 * Session-log policy regression suite (`docs/session-log-policy.md`).
 *
 * The scaffold originally declared `open-items/*` events through
 * `SessionEventMap` and appended them to the calling Session. That is unsafe for
 * an out-of-tree plugin: `KNOWN_SESSION_EVENT_TYPES` is a static generated
 * allow-list, the persistence read path throws
 * `SessionFormatUnsupportedMigrationError` for any type outside it that is not
 * marked `ignorable`, and only `packages/experimental/` may use
 * `appendPluginRecord`. A session that received such an event would fail to
 * restore on resume. These tests make the removal permanent.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { Config, type Config as ConfigValues } from '../src/host/config'
import { apply } from '../src/host/index'
import { createFakeDomain } from './fake-domain'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Schemastery's call signature is over the validated type; tests feed partials. */
const validate = Config as unknown as (input: unknown) => ConfigValues

/**
 * Read every production source file under `src/`.
 * @returns one `{ path, text }` per file.
 */
async function readSourceTree(): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = []
  /**
   * Walk one directory.
   * @param directory - absolute directory to walk.
   */
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) await walk(entryPath)
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push({ path: entryPath, text: await readFile(entryPath, 'utf8') })
      }
    }
  }
  await walk(join(PACKAGE_ROOT, 'src'))
  return files
}

describe('no Session-log write path exists', () => {
  it('has no SessionEventMap declaration and no append call in src/', async () => {
    const sources = await readSourceTree()
    expect(sources.length).toBeGreaterThan(0)
    for (const file of sources) {
      const relative = file.path.slice(PACKAGE_ROOT.length + 1)
      expect(file.text, `${relative} declares SessionEventMap`).not.toMatch(/SessionEventMap/u)
      expect(file.text, `${relative} calls session.append`).not.toMatch(/\.append\s*\(/u)
      expect(file.text, `${relative} calls appendPluginRecord`).not.toMatch(/appendPluginRecord/u)
      expect(file.text, `${relative} names a non-ignorable open-items event`)
        .not.toMatch(/['"`]open-items\/(?:raised|answered|dismissed|reopened)/u)
    }
    // The deleted module must not come back: nothing may re-export or import it.
    const sharedDirectory = await readdir(join(PACKAGE_ROOT, 'src', 'shared'))
    expect(sharedDirectory).not.toContain('events.ts')
  })

  it('does not advertise a session-capture knob anywhere a deployment/tests read', async () => {
    const manifests = [
      join(PACKAGE_ROOT, 'cordis.patch.yml'),
      join(PACKAGE_ROOT, 'package.json'),
      join(PACKAGE_ROOT, 'src', 'host', 'config.ts'),
    ]
    for (const manifestPath of manifests) {
      const text = await readFile(manifestPath, 'utf8')
      expect(text, `${manifestPath.slice(PACKAGE_ROOT.length + 1)} still mentions captureSessionEvents`)
        .not.toMatch(/captureSessionEvents/u)
    }
  })

  it('declares the v2 domain-backed config in the bundle patch', async () => {
    const patch = await readFile(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8')
    for (const key of ['maxLiveItems', 'listLimit', 'activeResolveDays', 'maxResolvedRecords', 'acknowledgementWindowHours']) {
      expect(patch, `cordis.patch.yml is missing ${key}`).toContain(key)
    }
  })
})

describe('apply() mounts store, service and tool only', () => {
  let caseDirectory: string
  let filePath: string

  beforeEach(async () => {
    const root = join(PACKAGE_ROOT, 'tests', '.tmp-policy')
    await mkdir(root, { recursive: true })
    caseDirectory = await mkdtemp(join(root, 'policy-'))
    filePath = join(caseDirectory, 'store.json')
  })

  afterAll(async () => {
    await rm(join(PACKAGE_ROOT, 'tests', '.tmp-policy'), { recursive: true, force: true })
  })

  it('registers exactly one tool and writes nothing to the session log', async () => {
    const registered: ToolDefinition[] = []
    const domain = createFakeDomain()
    const ctx = new Context()
    ctx.provide('storageDomain', { open: async () => domain })
    ctx.provide('tools', {
      /**
       * Capture the registered tool definition.
       * @param definition - the definition.
       * @returns the disposer.
       */
      register(definition: ToolDefinition): () => void {
        registered.push(definition)
        return () => undefined
      },
    })
    await apply(ctx, validate({
      storePath: join(filePath, '..', 'legacy.json'),
      maxLiveItems: 500,
      listLimit: 20,
      activeResolveDays: 365,
      maxResolvedRecords: 5000,
      acknowledgementWindowHours: 24,
    }))

    expect(ctx.openItems).toBeDefined()
    expect(registered).toHaveLength(1)
    const definition = registered[0]!
    expect(definition.name).toBe('open_items')
    // No registration surface other than the tool: no event types, no listeners.
    expect(definition.parameters).toBeDefined()

    let appends = 0
    const exec = {
      agent: {
        id: 'policy-session',
        session: {
          id: 'policy-session',
          append() {
            appends += 1
            throw new Error('apply()/open_items must not append session events')
          },
        },
      },
    } as unknown as ToolRunContext

    const raised = await definition.execute({ action: 'raise', title: 'Policy check' }, exec) as { items: { id: string }[] }
    const id = raised.items[0]!.id
    await definition.execute({ action: 'list' }, exec)
    await definition.execute({ action: 'resolve', id, answer: 'done' }, exec)
    await ctx.openItems.reopen(id)
    await definition.execute({ action: 'dismiss', id, reason: 'obsolete' }, exec)

    expect(appends).toBe(0)
    expect(ctx.openItems.get(id)?.history.map(entry => entry.action))
      .toEqual(['raised', 'answered', 'reopened', 'dismissed'])
    expect(ctx.openItems.schemaVersion).toBe(3)
    expect(ctx.openItems.installId).toMatch(/^[0-9a-f-]{36}$/u)
  })
})

describe('docs/session-log-policy.md', () => {
  it('exists and quotes both pieces of evidence', async () => {
    const document = await readFile(join(PACKAGE_ROOT, 'docs', 'session-log-policy.md'), 'utf8')
    expect(document).toMatch(/known-event-types\.ts:8-20|known-event-types\.ts:4-20/u)
    expect(document).toContain('KNOWN_SESSION_EVENT_TYPES')
    expect(document).toContain('SessionFormatUnsupportedMigrationError')
    expect(document).toMatch(/validation\.ts:59-62/u)
    expect(document).toContain('appendPluginRecord')
    expect(document).toContain('packages/experimental/')
    await expect(stat(join(PACKAGE_ROOT, 'src', 'shared', 'events.ts'))).rejects.toThrow()
  })
})
