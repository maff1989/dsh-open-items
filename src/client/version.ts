/**
 * Version stamped into deterministic export headers.
 *
 * Kept here rather than read from `package.json` so the browser bundle does not
 * need a JSON import, and so the value is explicit in the source. It must be
 * bumped with the package version; the Host `hello` capability probe does not
 * carry a plugin version yet (protocol v1), which is why this is the only
 * client-side source of truth.
 */
export const PLUGIN_VERSION = '0.1.0-rc.2'
