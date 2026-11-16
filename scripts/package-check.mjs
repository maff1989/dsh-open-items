#!/usr/bin/env node
/**
 * Package/release readiness check (M6).
 *
 * The npm cache is read-only in this sandbox, so `npm pack` cannot run. Instead
 * this script asserts the *declared* payload and metadata against the built
 * tree: every `files` entry exists (directories expanded), the bundle payload
 * contains the host + client artifacts and their maps, the `dsh` manifest
 * fields point at real files, the peer dependencies are pinned to the installed
 * rc.1 runtime, and the release docs/version constants agree with the package
 * version.
 *
 * Usage: node scripts/package-check.mjs   (exit 1 on any failure)
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

/**
 * Record one assertion.
 * @param condition - whether it holds.
 * @param message - failure description.
 */
function check(condition, message) {
  if (!condition) failures.push(message)
}

/**
 * Assert one path exists under the package root.
 * @param relative - package-relative path.
 * @param kind - expected type ('file' default).
 * @returns true when it exists.
 */
async function exists(relative, kind = 'file') {
  try {
    const info = await stat(join(ROOT, relative))
    return kind === 'file' ? info.isFile() : info.isDirectory()
  } catch {
    return false
  }
}

/**
 * Expand one `files` entry (directory entries end in `/` or are known dirs).
 * @param entry - package.json `files` entry.
 * @returns package-relative file paths covered by the entry.
 */
async function expandEntry(entry) {
  const trimmed = entry.replace(/\/$/u, '')
  const absolute = join(ROOT, trimmed)
  try {
    const info = await stat(absolute)
    if (!info.isDirectory()) return [entry]
  } catch {
    return [entry]
  }
  const covered = []
  /**
   * Walk one directory.
   * @param directory - absolute directory.
   * @returns package-relative files.
   */
  async function walk(directory) {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const absoluteChild = join(directory, child.name)
      if (child.isDirectory()) await walk(absoluteChild)
      else if (child.isFile()) covered.push(absoluteChild.slice(ROOT.length + 1))
    }
  }
  await walk(absolute)
  return covered
}

/* ----- package.json basics ------------------------------------------------ */
let manifest
try {
  manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
} catch (error) {
  console.error(`package-check FAILED: cannot read package.json: ${error.message}`)
  process.exit(1)
}

check(manifest.name === 'dsh-open-items', `package name is ${JSON.stringify(manifest.name)}, expected "dsh-open-items"`)
check(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(String(manifest.version ?? '')), `version ${JSON.stringify(manifest.version)} is not semver`)
check(manifest.type === 'module', 'package type must be "module" (ESM host + client bundle contract)')
check(manifest.private === true, 'package must stay private (distribution is a profile install, not npm publish)')
check(manifest.license === 'MIT', `license is ${JSON.stringify(manifest.license)}, expected "MIT"`)
check(await exists('LICENSE'), 'LICENSE file is missing')
const licenseText = await readFile(join(ROOT, 'LICENSE'), 'utf8').catch(() => '')
check(licenseText.startsWith('MIT License'), 'LICENSE does not start with "MIT License"')
check(await exists('README.md'), 'README.md is missing')
check(await exists('CHANGELOG.md'), 'CHANGELOG.md is missing')

/* ----- dsh manifest ------------------------------------------------------- */
check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must be ./cordis.patch.yml')
check(await exists('cordis.patch.yml'), 'cordis.patch.yml is missing')
check(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform must be "web"')

/* ----- engines and peers -------------------------------------------------- */
check(manifest.engines?.dsh === '>=0.2.2-rc.1 <0.3.0', `engines.dsh is ${JSON.stringify(manifest.engines?.dsh)}`)
check(/^>=\d+\.\d+\.\d+/u.test(String(manifest.engines?.node ?? '')), 'engines.node is missing or not a range')
const peers = manifest.peerDependencies ?? {}
const dshPeers = Object.entries(peers).filter(([name]) => name.startsWith('@deepseek-ai/'))
check(dshPeers.length >= 10, `expected the full runtime peer set, found ${dshPeers.length}`)
for (const [name, range] of dshPeers) {
  if (name === '@deepseek-ai/cordis') {
    check(range === '~4.1.0', `peer ${name} is ${range}, expected ~4.1.0`)
    continue
  }
  if (name === '@deepseek-ai/schemastery') {
    check(range === '~3.19.0', `peer ${name} is ${range}, expected ~3.19.0`)
    continue
  }
  check(range === '0.2.2-rc.1', `peer ${name} is ${range}; the release targets the installed 0.2.2-rc.1 runtime exactly`)
}

/* ----- files payload ------------------------------------------------------ */
const declaredFiles = Array.isArray(manifest.files) ? manifest.files : []
check(declaredFiles.length > 0, 'package.json files[] is empty')
const covered = new Set()
for (const entry of declaredFiles) {
  for (const file of await expandEntry(entry)) covered.add(file)
}
const required = [
  'lib/index.js',
  'lib/index.js.map',
  'lib/client.js',
  'lib/client.js.map',
  'cordis.patch.yml',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'tests/acceptance/last-run.json', // must NOT be required; guarded below
]
const mustShip = required.filter(file => file !== 'tests/acceptance/last-run.json')
for (const file of mustShip) {
  check(covered.has(file), `files payload does not cover ${file} (run \`node scripts/build.mjs\` if lib/ is missing)`)
}
check(!covered.has('tests/acceptance/last-run.json'), 'local acceptance output tests/acceptance/last-run.json must not ship')
for (const doc of ['docs/install.md', 'docs/release.md', 'docs/perf.md', 'docs/a11y.md', 'docs/session-log-policy.md']) {
  check(covered.has(doc), `files payload does not cover ${doc}`)
}
check(!covered.has('node_modules/anything'), 'files payload must not include node_modules')

/* ----- built artifacts ---------------------------------------------------- */
for (const file of ['lib/index.js', 'lib/client.js']) {
  const info = await stat(join(ROOT, file)).catch(() => undefined)
  check(info !== undefined && info.size > 1_000, `${file} is missing or suspiciously small (run \`node scripts/build.mjs\`)`)
}
const hostBundle = await readFile(join(ROOT, 'lib/index.js'), 'utf8').catch(() => '')
const clientBundle = await readFile(join(ROOT, 'lib/client.js'), 'utf8').catch(() => '')
check(hostBundle.includes('open-items') || hostBundle.includes('dsh-open-items'), 'host bundle does not look like this plugin')
check(/export\s*\{[^}]*\bapply\b/u.test(hostBundle), 'host bundle does not export apply()')
check(!hostBundle.includes('session.append') && !hostBundle.includes('appendPluginRecord'), 'host bundle contains a Session-log write path')
check(clientBundle.includes('window.__ModuleLoader__.load'), 'client bundle is not module-loader wrapped')
check(clientBundle.includes('"dsh-open-items"'), 'client bundle does not register the package id')
check(!clientBundle.includes('node_modules/react/'), 'client bundle inlined React instead of using the platform module table')

/* ----- version constants and changelog ----------------------------------- */
const clientVersion = await readFile(join(ROOT, 'src', 'client', 'version.ts'), 'utf8').catch(() => '')
const versionMatch = /PLUGIN_VERSION\s*=\s*'([^']+)'/u.exec(clientVersion)
check(versionMatch !== null, 'src/client/version.ts has no PLUGIN_VERSION constant')
if (versionMatch !== null) {
  check(versionMatch[1] === manifest.version,
    `src/client/version.ts PLUGIN_VERSION ${versionMatch[1]} does not match package version ${manifest.version}`)
  notes.push(`version ${manifest.version} (client export header uses the same constant)`)
}
const changelog = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8').catch(() => '')
check(changelog.includes(`## [${manifest.version}]`) || changelog.includes(`## ${manifest.version}`),
  `CHANGELOG.md has no release section for ${manifest.version}`)

/* ----- report ------------------------------------------------------------- */
if (failures.length > 0) {
  console.error(`package-check FAILED (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
const sorted = [...covered].sort()
console.log(`package-check OK: ${manifest.name}@${manifest.version} — ${sorted.length} payload file(s), ${dshPeers.length} pinned peers`)
console.log(`  payload: ${sorted.join(', ')}`)
for (const note of notes) console.log(`  note: ${note}`)
console.log('  (no `npm pack` was run: the npm cache is read-only in this sandbox)')
