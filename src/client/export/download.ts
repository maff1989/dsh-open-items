/**
 * Browser download wrapper for one deterministic register export.
 *
 * This is the only DOM-touching module of the export feature, and it is
 * deliberately thin: the bytes come from `src/shared/export.ts`, this file only
 * turns them into a local file. It never calls the Host, never calls the
 * network, and never uploads anything (DESIGN §7.4.7: "the file is generated in
 * the browser and downloaded locally").
 *
 * The package's `tsconfig.json` deliberately has no DOM lib (`lib: ["ES2023"]`)
 * because the Host half and the generators must stay environment-free, so this
 * file declares the minimal browser surface it uses structurally and resolves it
 * from `globalThis` at call time. Tests inject a fake environment instead of a
 * browser, which is also how the "no network" property is asserted.
 *
 * @module dsh-open-items/client/export/download
 */
import type { OpenItemRecord } from '../../shared/schema'
import {
  EXPORT_MIME_TYPES,
  exportChunks,
  type ExportChunkSet,
  type ExportOptions,
} from '../../shared/export'

/** The minimal slice of `Blob` this wrapper needs. */
export interface BlobLike {
  readonly type: string
  readonly size: number
}

/** The minimal slice of `HTMLAnchorElement` this wrapper needs. */
export interface AnchorLike {
  href: string
  download: string
  rel: string
  click(): void
}

/**
 * The browser surface the wrapper uses. Every member is injectable so the
 * download can be exercised under Node with a fake environment
 * (`tests/export/download.spec.ts`).
 */
export interface DownloadEnvironment {
  /** Create a Blob from the export chunks (the streaming path: no giant string). */
  readonly createBlob: (parts: readonly string[], type: string) => BlobLike
  /** Create an object URL for the Blob. */
  readonly createObjectUrl: (blob: BlobLike) => string
  /** Release the object URL after the click. */
  readonly revokeObjectUrl: (url: string) => void
  /** Create an anchor element. */
  readonly createAnchor: () => AnchorLike
  /** Attach the anchor to the document so the click is honoured everywhere. */
  readonly mountAnchor: (anchor: AnchorLike) => void
  /** Detach the anchor again. */
  readonly unmountAnchor: (anchor: AnchorLike) => void
  /** Defer the URL revoke until the browser has started the download. */
  readonly defer: (callback: () => void) => void
}

/** Outcome of one download attempt; nothing is silently truncated or half-reported. */
export type DownloadResult =
  | {
    readonly ok: true
    readonly filename: string
    readonly mimeType: string
    /** Exact UTF-8 byte length of the file. */
    readonly byteLength: number
    /** Number of chunks handed to the Blob (1 for a tiny export, N for a large one). */
    readonly chunkCount: number
  }
  | {
    readonly ok: false
    /** Why the download did not happen, e.g. `download-unavailable: no Blob in this environment`. */
    readonly error: string
  }

/** The structural globals this wrapper resolves; absent under Node and in tests without a fake. */
interface BrowserGlobals {
  readonly Blob?: new (parts: readonly string[], options: { readonly type: string }) => BlobLike
  readonly URL?: {
    readonly createObjectURL?: (blob: BlobLike) => string
    readonly revokeObjectURL?: (url: string) => void
  }
  readonly document?: {
    readonly createElement?: (tagName: string) => AnchorLike
    readonly body?: { readonly appendChild?: (node: AnchorLike) => void; readonly removeChild?: (node: AnchorLike) => void }
  }
  readonly setTimeout?: (callback: () => void, milliseconds: number) => unknown
}

/**
 * Resolve the real browser environment, or `undefined` when the globals a
 * download needs are absent (Node, a worker without a document, jsdom without a
 * URL implementation). Callers must treat `undefined` as a failure, never as a
 * reason to fake success.
 * @returns the environment, or `undefined`.
 */
export function resolveBrowserEnvironment(): DownloadEnvironment | undefined {
  const browser = globalThis as unknown as BrowserGlobals
  const BlobConstructor = browser.Blob
  const url = browser.URL
  const document = browser.document
  const setTimeout = browser.setTimeout
  if (
    BlobConstructor === undefined
    || url?.createObjectURL === undefined
    || url.revokeObjectURL === undefined
    || document?.createElement === undefined
    || document.body?.appendChild === undefined
    || document.body.removeChild === undefined
    || setTimeout === undefined
  ) {
    return undefined
  }
  return {
    createBlob: (parts, type) => new BlobConstructor(parts, { type }),
    createObjectUrl: blob => url.createObjectURL?.(blob) ?? '',
    revokeObjectUrl: (objectUrl) => { url.revokeObjectURL?.(objectUrl) },
    createAnchor: () => {
      const anchor = document.createElement?.('a')
      /* c8 ignore next -- the guard above proved createElement exists */
      if (anchor === undefined) throw new Error('document.createElement is unavailable')
      return anchor
    },
    mountAnchor: (anchor) => { document.body?.appendChild?.(anchor) },
    unmountAnchor: (anchor) => { document.body?.removeChild?.(anchor) },
    defer: (callback) => { setTimeout(callback, REVOKE_DELAY_MS) },
  }
}

/** Revoke-delay guard: keeps the URL alive long enough for the browser to start the download. */
const REVOKE_DELAY_MS = 1_000

/**
 * Generate the export and download it locally.
 *
 * The file is built from the generator's chunks straight into one `Blob`, so a
 * large register is never flattened into one giant string first. Failure is a
 * value (`ok: false` with a reason), never a throw, so the page can show the
 * honest message instead of a silent no-op.
 * @param records - resolved records in any order (filtering and ordering happen in the generator).
 * @param options - the export request built by the export dialog.
 * @param environment - injectable browser surface; defaults to {@link resolveBrowserEnvironment}.
 * @returns the download outcome with the exact file name and byte length.
 */
export function downloadExport(
  records: readonly OpenItemRecord[],
  options: ExportOptions,
  environment: DownloadEnvironment | undefined = resolveBrowserEnvironment(),
): DownloadResult {
  let chunkSet: ExportChunkSet
  try {
    chunkSet = exportChunks(records, options)
  } catch (error: unknown) {
    return { ok: false, error: `export-failed: ${describe(error)}` }
  }
  if (environment === undefined) {
    return {
      ok: false,
      error: 'download-unavailable: this environment has no Blob, object URL or document to download with',
    }
  }

  let objectUrl: string | undefined
  let anchor: AnchorLike | undefined
  try {
    // The streaming path: the chunk array goes to the Blob as-is. Joining here
    // would defeat the point on a multi-megabyte register.
    const blob = environment.createBlob(chunkSet.chunks, chunkSet.mimeType)
    objectUrl = environment.createObjectUrl(blob)
    if (objectUrl === '') throw new Error('the browser returned no object URL')
    anchor = environment.createAnchor()
    anchor.href = objectUrl
    anchor.download = chunkSet.filename
    // `noopener` matters for the object URL handed to a navigation; nothing else is set.
    anchor.rel = 'noopener'
    environment.mountAnchor(anchor)
    anchor.click()
    return {
      ok: true,
      filename: chunkSet.filename,
      mimeType: chunkSet.mimeType,
      byteLength: chunkSet.byteLength,
      chunkCount: chunkSet.chunks.length,
    }
  } catch (error: unknown) {
    return { ok: false, error: `download-failed: ${describe(error)}` }
  } finally {
    if (anchor !== undefined) {
      try {
        environment.unmountAnchor(anchor)
      } catch (error: unknown) {
        // A detached anchor is not a failed download; the click already happened.
        void error
      }
    }
    if (objectUrl !== undefined) {
      const urlToRelease = objectUrl
      try {
        // Revoke later: revoking synchronously can cancel the download in some browsers.
        environment.defer(() => {
          try {
            environment.revokeObjectUrl(urlToRelease)
          } catch (error: unknown) {
            void error
          }
        })
      } catch (error: unknown) {
        void error
      }
    }
  }
}

/** Stable one-line description of a thrown value for a user-visible error string. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Re-exported for callers that build the dialog copy from the same table. */
export { EXPORT_MIME_TYPES }
