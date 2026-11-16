/**
 * Client-side protocol tolerance.
 *
 * The client half is HMR-live while the Host needs a restart, so the browser can
 * legitimately be newer than the Host (DESIGN §5.3). `hello` is the only place
 * the versions are published, so this module reads them once and names the skew
 * instead of letting mismatched fields fail silently.
 *
 * @module dsh-open-items/client/data/compat
 */
import { PROTOCOL_VERSION, type HelloValue } from '../../shared/protocol'

/** Serialized store format this client knows how to read (`hello.domainVersion`). */
export const SUPPORTED_DOMAIN_VERSION = 1

/** How the two halves disagree, if they do. */
export type Skew = 'none' | 'protocol' | 'domain'

/**
 * Classify one `hello` probe.
 * @param hello - the probe, when one has landed.
 * @returns `none` while compatible or before the first read.
 */
export function skewOf(hello: HelloValue | undefined): Skew {
  if (hello === undefined) return 'none'
  if (hello.protocol !== PROTOCOL_VERSION) return 'protocol'
  if (hello.domainVersion > SUPPORTED_DOMAIN_VERSION) return 'domain'
  return 'none'
}
