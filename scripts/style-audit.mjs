#!/usr/bin/env node
/**
 * Static DSH style audit (rc2 WP-08, style register S-18).
 *
 * The mechanical half of the DSH style gate: it enforces the decidable rules
 * from the DSH style owners (docs/web-styling.md, docs/ui-radius.md, the
 * ui-primitives catalogue, .agents/skills/dsh-client-ui-ux) over the browser
 * half and reports file:line findings a human verifies in the browser. The
 * visual half stays manual (ACCEPTANCE-rc2 §5.3/§5.4).
 *
 * Rules:
 * - tokens-only-colors    semantic --dsw-alias-* tokens only; no hex, colour
 *                         functions with literal channels, or named colours
 * - palette-reference     no --dsw-static-* palette references
 * - hover-guard           every :hover selector sits under @media (hover: hover)
 * - font-weight           feature CSS keeps font-weight <= 500
 * - radius-token          border-radius is 0 / --dsw-radius-* / a full round
 * - corner-shape-pairing  full-round radii pair corner-shape: round
 * - theme-selector        no theme/palette selectors in feature CSS
 * - hairline              neutral box borders use the 0.5px hairline
 * - accent-border         no thick side accent without a shipped precedent
 * - border-elevation      never pair a neutral border with --dsw-elevation-*
 * - elevation-material    box-shadow is none or --dsw-elevation-{panel,prominent,soft}
 * - native-select         no native <select> (Menu / SegmentedControl / Pill)
 * - native-dialog         no native <dialog> or role="dialog" (Modal)
 * - hand-rolled-control   no feature copy of a catalogue control
 * - hand-rolled-menu      no hand-rolled menu/listbox (Menu / MenuSurface)
 * - hand-rolled-disclosure no hand-rolled <details> disclosure (DisclosureRow or justification)
 * - native-textarea       draft fields use InlineEditor
 * - dead-css              every styled class has a consumer (S-20)
 * - style-interpolation   a stylesheet must be statically auditable
 *
 * Usage: node scripts/style-audit.mjs [--strict] [--json] [--help]
 *   --strict exits 1 when a HIGH or MEDIUM finding exists that is not justified
 *            (the release gate).
 *   --json   prints the machine-readable report.
 *   --help   prints this usage, the rule list and the justification format.
 *
 * Justifying an authentic deviation:
 *  Put a directive on the line immediately before the line a finding reports:
 *
 *      // style-justification: <rule-id> — <reason>
 *
 *  The report keeps the finding visible as a JUSTIFIED line with the reason, so
 *  the gate cannot be silenced silently. A directive with an unknown rule, an
 *  empty reason, or no matching finding is itself a `justification` finding and
 *  fails the strict gate. The reason is the design record: cite the owning
 *  section (for example DESIGN §6.8) and why the shipped primitive is the wrong
 *  interaction for that surface.
 *
 * @module dsh-open-items/scripts/style-audit
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.STYLE_AUDIT_ROOT !== undefined && process.env.STYLE_AUDIT_ROOT !== ''
  ? resolve(process.env.STYLE_AUDIT_ROOT)
  : resolve(SCRIPT_DIR, '..')
const CLIENT = join(ROOT, 'src', 'client')
const argv = process.argv.slice(2)
const strict = argv.includes('--strict')
const jsonOnly = argv.includes('--json')
const helpRequested = argv.includes('--help') || argv.includes('-h')

/** Rule descriptions, in report order. */
const RULES = new Map([
  ['tokens-only-colors', 'semantic --dsw-alias-* colour tokens only'],
  ['palette-reference', 'no --dsw-static-* palette references'],
  ['hover-guard', 'every :hover selector sits under @media (hover: hover)'],
  ['font-weight', 'feature CSS keeps font-weight <= 500'],
  ['radius-token', 'border-radius uses 0 / --dsw-radius-* / a full round'],
  ['corner-shape-pairing', 'full-round radii pair corner-shape: round'],
  ['theme-selector', 'no theme/palette selectors in feature CSS'],
  ['hairline', 'neutral box borders use the 0.5px hairline'],
  ['accent-border', 'no thick side accent without a shipped precedent'],
  ['border-elevation', 'never pair a neutral border with --dsw-elevation-*'],
  ['elevation-material', 'box-shadow is none or --dsw-elevation-panel/prominent/soft'],
  ['native-select', 'no native <select>'],
  ['native-dialog', 'no native <dialog> or role="dialog"'],
  ['hand-rolled-control', 'no feature copy of a catalogue control'],
  ['hand-rolled-menu', 'no hand-rolled menu/listbox'],
  ['hand-rolled-disclosure', 'no hand-rolled disclosure without a written justification'],
  ['native-textarea', 'draft fields use InlineEditor'],
  ['dead-css', 'every styled class has a consumer'],
  ['style-interpolation', 'stylesheets stay statically auditable'],
  ['justification', 'every justification directive is valid and matches a finding'],
])

if (helpRequested) {
  console.log('style-audit — DSH style gate (rc2 S-18)')
  console.log('Usage: node scripts/style-audit.mjs [--strict] [--json] [--help]')
  console.log('  --strict  exit 1 when a HIGH or MEDIUM finding is not justified')
  console.log('  --json    print the machine-readable report')
  console.log('  --help    print this usage, the rules and the justification format')
  console.log('')
  console.log('Justify an authentic deviation with a directive on the line immediately')
  console.log('before the line the finding reports:')
  console.log('  // style-justification: <rule-id> — <reason>')
  console.log('The report keeps a JUSTIFIED line with the reason; stale, unknown-rule and')
  console.log('empty-reason directives are `justification` findings and fail --strict.')
  console.log('')
  console.log('Rules:')
  for (const [rule, description] of RULES) console.log(`  ${rule} — ${description}`)
  process.exit(0)
}

/** All findings. */
const findings = []
/** Rule ids with no finding. */
const clean = new Set()
/** Scan statistics. */
let scannedStylesheets = 0
let scannedRules = 0
let scannedModules = 0

/**
 * Record one finding.
 * @param rule - rule id.
 * @param severity - 'high' | 'medium' | 'low'.
 * @param file - absolute file path.
 * @param line - 1-based line.
 * @param message - actionable description.
 */
function finding(rule, severity, file, line, message) {
  findings.push({ rule, severity, file: relative(ROOT, file), line, message })
}

/**
 * 1-based line of one index inside a text.
 * @param text - file text.
 * @param index - character index.
 * @returns 1-based line number.
 */
function lineAt(text, index) {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === '\n') line += 1
  }
  return line
}

/**
 * Walk a directory.
 * @param directory - absolute directory.
 * @param pattern - filename test.
 * @returns absolute file paths.
 */
async function walk(directory, pattern) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(absolute, pattern))
    else if (entry.isFile() && pattern.test(entry.name)) files.push(absolute)
  }
  return files
}

/**
 * Whether a template-literal body is a stylesheet (rather than JSX copy).
 * @param css - literal body.
 * @returns true when the body parses as CSS-like rules.
 */
function looksLikeCss(css) {
  if (!css.includes('{') || !css.includes(';') || !css.includes(':')) return false
  if (!/(?:^|\n)\s*(?:[.#@:]|[a-z][\w-]*\s*[,{])/iu.test(css)) return false
  if (!/(?:[.#][a-z]|@(?:media|container|keyframes|supports))/iu.test(css)) return false
  return /[a-z-]+\s*:\s*[^;{}]+/iu.test(css)
}

/**
 * Extract the CSS template literals of one module.
 * @param file - absolute path (for findings).
 * @param text - module source.
 * @returns `{ css, startLine }` blocks.
 */
function extractCssBlocks(file, text) {
  const blocks = []
  for (const match of text.matchAll(/`((?:[^`\\]|\\.)*)`/gu)) {
    const body = match[1]
    if (!looksLikeCss(body)) continue
    const startLine = lineAt(text, match.index + 1)
    if (body.includes('${')) {
      finding('style-interpolation', 'medium', file, startLine,
        'stylesheet interpolates values and cannot be audited statically; keep feature CSS literal')
      continue
    }
    blocks.push({ css: body, startLine })
  }
  return blocks
}

/**
 * Parse CSS into rules with declarations and ancestor at-rules.
 * @param css - stylesheet text.
 * @param startLine - file line the text starts on.
 * @returns `{ selector, line, ancestors, declarations }` entries.
 */
function parseCss(css, startLine) {
  const rules = []
  const stack = []
  let buffer = ''
  let bufferLine = startLine
  let line = startLine
  let quote = ''
  let comment = false
  for (let index = 0; index < css.length;) {
    const character = css[index]
    if (character === '\n') {
      line += 1
      if (buffer === '') bufferLine = line
      buffer += character
      index += 1
      continue
    }
    if (comment) {
      if (character === '*' && css[index + 1] === '/') { comment = false; index += 2 } else index += 1
      continue
    }
    if (character === '/' && css[index + 1] === '*') { comment = true; index += 2; continue }
    if (quote !== '') {
      buffer += character
      if (character === quote) quote = ''
      index += 1
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      buffer += character
      index += 1
      continue
    }
    if (character === '{') {
      const node = {
        selector: buffer.replace(/\s+/gu, ' ').trim(),
        line: bufferLine,
        ancestors: stack.map(entry => entry.selector),
        declarations: [],
      }
      rules.push(node)
      stack.push(node)
      buffer = ''
      bufferLine = line
      index += 1
      continue
    }
    if (character === '}') {
      stack.pop()
      buffer = ''
      bufferLine = line
      index += 1
      continue
    }
    if (character === ';') {
      const declaration = buffer.replace(/\s+/gu, ' ').trim()
      if (stack.length > 0 && declaration !== '') {
        const colon = declaration.indexOf(':')
        if (colon > 0) {
          stack[stack.length - 1].declarations.push({
            prop: declaration.slice(0, colon).trim().toLowerCase(),
            value: declaration.slice(colon + 1).trim(),
            line: bufferLine,
          })
        }
      }
      buffer = ''
      bufferLine = line
      index += 1
      continue
    }
    if (buffer === '') bufferLine = line
    buffer += character
    index += 1
  }
  return rules
}

/** Alpha-0 hex literal (exempt from the colour rule). */
const alphaZeroHex = value => (/^#[0-9a-f]{4}$/iu.test(value) && value.endsWith('0'))
  || (/^#[0-9a-f]{8}$/iu.test(value) && value.slice(-2).toLowerCase() === '00')

/** Properties where a literal would replace a colour token. */
const COLOR_PROPERTY = /^(?:color|background|background-color|background-image|border|border-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end)(?:-color)?|outline|outline-color|fill|stroke|caret-color|text-decoration-color|text-emphasis-color|column-rule|column-rule-color|--[\w-]+)$/u

/** Named colours that would be literals in feature CSS. */
const NAMED_COLORS = /\b(?:white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink|brown|cyan|magenta|lime|maroon|navy|olive|teal|aqua|fuchsia)\b/iu

/** Radius properties. */
const RADIUS_PROPERTY = /^border-radius$|^border-(?:top|bottom)-(?:left|right)-radius$|^border-(?:start|end)-(?:start|end)-radius$/u

/** Full-round radius values. */
const isFullRound = value => value === '50%' || value === '100%' || /^9{3,}px$/u.test(value)

/** Whether one radius component is on the shared scale. */
const radiusAllowed = value => value === '0' || value === '0px'
  || /^var\(--dsw-radius-(?:xs|sm|md|lg|xl|panel)\)$/u.test(value)
  || value.startsWith('calc(')
  || /^(?:inherit|initial|unset|revert|revert-layer)$/u.test(value)

/** Border properties carrying a visible edge. */
const BORDER_PROPERTY = /^border(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?(?:-(?:width|style|color))?$/u

/** Side-border properties (accent-rule candidates). */
const SIDE_BORDER = /^border-(?:left|right|inline-start|inline-end|top|bottom)(?:-(?:width|style|color))?$/u

/** Neutral stroke tokens. */
const NEUTRAL_STROKE = /--dsw-alias-(?:border-[\w-]+|settings-card-stroke)/u

/** State-coloured stroke tokens. */
const STATE_STROKE = /--dsw-alias-state-[\w-]+/u

/**
 * Audit one parsed rule's selector and declarations.
 * @param rule - parsed rule.
 * @param file - absolute path.
 */
function auditRule(rule, file) {
  if (/^@keyframes/u.test(rule.selector) || rule.ancestors.some(ancestor => /^@keyframes/u.test(ancestor))) return
  const inHoverMedia = rule.ancestors.some(ancestor => /\(hover:\s*hover\)/iu.test(ancestor))
  for (const selector of rule.selector.split(',')) {
    const trimmed = selector.trim()
    if (trimmed === '') continue
    if (/:hover\b/u.test(trimmed) && !inHoverMedia) {
      finding('hover-guard', 'high', file, rule.line,
        `:hover selector "${trimmed}" is not under @media (hover: hover)`)
    }
    if (/\[[^\]]*data-(?:ds-)?(?:dark|light)-theme|\[data-theme|prefers-color-scheme|(?:^|[\s,>+~])(?:html|body|:root)(?=$|[\s,.#:[>+~])/iu.test(trimmed)) {
      finding('theme-selector', 'high', file, rule.line,
        `selector "${trimmed}" reaches a theme/palette root; light/dark belongs to ui-theme`)
    }
  }

  let hasBorder = false
  let hasElevation = false
  let fullRound = false
  let cornerShapeRound = false
  for (const declaration of rule.declarations) {
    const { prop, value } = declaration
    const line = declaration.line
    if (prop === 'font-weight') {
      const numeric = /^(\d{3})$/u.exec(value.trim())
      if ((numeric !== null && Number(numeric[1]) > 500) || /^(?:bold|bolder)$/u.test(value.trim())) {
        finding('font-weight', 'high', file, line, `font-weight ${value.trim()} exceeds the feature-CSS limit of 500`)
      }
    }
    if (COLOR_PROPERTY.test(prop)) {
      for (const hex of value.match(/#[0-9a-f]{3,8}/giu) ?? []) {
        if (!alphaZeroHex(hex)) finding('tokens-only-colors', 'high', file, line, `literal colour ${hex}; use a --dsw-alias-* token`)
      }
      if (/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|device-cmyk)\(\s*[^)]*[0-9]/iu.test(value)) {
        finding('tokens-only-colors', 'high', file, line, 'colour function with literal channels; use a --dsw-alias-* token')
      }
      if (NAMED_COLORS.test(value)) finding('tokens-only-colors', 'high', file, line, `named colour literal "${value.trim()}"; use a --dsw-alias-* token`)
    }
    if (/--dsw-static-[\w-]+/u.test(value)) {
      finding('palette-reference', 'high', file, line, 'static palette reference; use a --dsw-alias-* token')
    }
    if (RADIUS_PROPERTY.test(prop)) {
      for (const part of value.split('/').flatMap(side => side.trim().split(/\s+/u))) {
        if (isFullRound(part)) { fullRound = true; continue }
        if (!radiusAllowed(part)) {
          finding('radius-token', 'medium', file, line, `border-radius ${part} is off the --dsw-radius-* scale`)
        }
      }
    }
    if (prop === 'corner-shape' && /\bround\b/u.test(value)) cornerShapeRound = true
    if (BORDER_PROPERTY.test(prop)) {
      const edge = value.trim()
      if (!/^(?:0|0px|none)$/u.test(edge)) {
        hasBorder = true
        const neutral = NEUTRAL_STROKE.test(edge)
        const state = STATE_STROKE.test(edge)
        const side = SIDE_BORDER.test(prop)
        const width = /^(\d*\.?\d+)px/u.exec(edge)
        const widthPx = width === null ? undefined : Number(width[1])
        if (widthPx !== undefined) {
          if (side && widthPx > 2) {
            finding('accent-border', 'medium', file, line,
              `${widthPx}px side accent border; DSH cards/rows have no accent-border precedent — use material or hierarchy (S-14/S-15)`)
          } else if (side && widthPx === 2 && state) {
            finding('accent-border', 'medium', file, line,
              '2px state-coloured accent border; state borders keep the 1px treatment (S-14)')
          } else if (side && widthPx === 2) {
            // Blockquote rule precedent (markdown blockquote: 2px label-caption left rule).
          } else if (neutral && widthPx !== 0.5) {
            finding('hairline', 'medium', file, line,
              `neutral border width ${widthPx}px; neutral flat borders use the 0.5px hairline (state borders keep their width)`)
          }
        }
      }
    }
    if (prop === 'box-shadow') {
      const shadow = value.trim()
      if (/--dsw-elevation-/u.test(shadow)) hasElevation = true
      if (shadow !== 'none' && !/--dsw-elevation-/u.test(shadow) && !/^inset\b/u.test(shadow)) {
        finding('elevation-material', 'medium', file, line,
          'box-shadow is not an elevation token; elevated surfaces take var(--dsw-elevation-panel|prominent|soft) with border: 0')
      }
    }
  }
  if (fullRound && !cornerShapeRound) {
    finding('corner-shape-pairing', 'high', file, rule.line,
      'full-round radius must pair corner-shape: round in the same rule')
  }
  if (hasElevation && hasBorder) {
    finding('border-elevation', 'high', file, rule.line,
      'elevated surface pairs a border with --dsw-elevation-*; set border: 0 and let the elevation stroke own the edge')
  }
}

/**
 * Audit one browser module for hand-rolled catalogue controls.
 * @param file - absolute path.
 * @param text - module source.
 */
function auditModule(file, text) {
  const imported = new Set()
  for (const match of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'@deepseek-ai\/dsh-client-ui-primitives'/gu)) {
    for (const name of match[1].split(',')) imported.add(name.trim().split(/\s+as\s+/u)[0])
  }
  let match
  const patterns = [
    ['native-select', 'high', /<select\b/gu, 'native <select>; use Menu or SegmentedControl/Pill (S-02)'],
    ['native-dialog', 'high', /<(?:dialog)\b|role=["'](?:dialog|alertdialog)["']/gu, 'hand-rolled dialog; use the shipped Modal (S-03)'],
    ['hand-rolled-menu', 'high', /role=["'](?:menu|menuitem|listbox)["']/gu, 'hand-rolled menu/listbox; use Menu/MenuSurface/MenuGroup (S-02)'],
    ['native-textarea', 'medium', /<textarea\b/gu, 'raw <textarea> draft; use InlineEditor (S-06)'],
  ]
  for (const [rule, severity, pattern, message] of patterns) {
    pattern.lastIndex = 0
    while ((match = pattern.exec(text)) !== null) finding(rule, severity, file, lineAt(text, match.index), message)
  }
  const details = /<details\b[^>]*>/gu
  while ((match = details.exec(text)) !== null) {
    if (/menu/iu.test(match[0])) {
      finding('hand-rolled-menu', 'high', file, lineAt(text, match.index),
        'hand-rolled menu (<details>); use Menu/MenuSurface (S-02)')
    } else {
      finding('hand-rolled-disclosure', 'medium', file, lineAt(text, match.index),
        'hand-rolled <details> disclosure; use DisclosureRow or record the justification (S-08)')
    }
  }
  const CATALOG = [
    [/Dialog$/u, 'Modal'],
    [/Menu$/u, 'Menu'],
    [/Toast$/u, 'Toast'],
    [/Confirm(?:ation)?$/u, 'RiskConfirmation'],
    [/InlineEditor$/u, 'InlineEditor'],
    [/DraftEditor$/u, 'InlineEditor'],
    [/SegmentedControl$/u, 'SegmentedControl'],
    [/Checkbox$/u, 'Checkbox'],
    [/Pill$/u, 'Pill'],
    [/Tag$/u, 'Tag'],
    [/StateDot$/u, 'StateDot'],
    [/DisclosureRow$/u, 'DisclosureRow'],
    [/AnimatedRows$/u, 'AnimatedRows'],
    [/Modal$/u, 'Modal'],
  ]
  const declaration = /(?:export\s+)?(?:function|class)\s+([A-Z][A-Za-z0-9_]*)|(?:const|let)\s+([A-Z][A-Za-z0-9_]*)\s*=/gu
  while ((match = declaration.exec(text)) !== null) {
    const name = match[1] ?? match[2]
    if (name === undefined) continue
    for (const [suffix, primitive] of CATALOG) {
      if (suffix.test(name) && !imported.has(primitive)) {
        finding('hand-rolled-control', 'high', file, lineAt(text, match.index),
          `${name} duplicates the shipped ${primitive}; import it from @deepseek-ai/dsh-client-ui-primitives (S-18)`)
        break
      }
    }
  }
}

/** Class names in a selector list. */
function classNames(text) {
  return [...text.matchAll(/\.([A-Za-z][\w-]*)/gu)].map(match => match[1])
}

const modules = await walk(CLIENT, /\.(?:ts|tsx|css)$/u)
const moduleText = new Map()
for (const file of modules) moduleText.set(file, await readFile(file, 'utf8'))

/** Files that carry a stylesheet (their own class names are not consumers). */
const stylesheetFiles = new Set()
const parsedRules = []
for (const file of modules) {
  const text = moduleText.get(file) ?? ''
  const blocks = file.endsWith('.css') ? [{ css: text, startLine: 1 }] : extractCssBlocks(file, text)
  if (blocks.length === 0) continue
  scannedStylesheets += 1
  stylesheetFiles.add(file)
  for (const block of blocks) {
    for (const rule of parseCss(block.css, block.startLine)) {
      parsedRules.push({ rule, file })
      auditRule(rule, file)
    }
  }
}
scannedRules = parsedRules.length

for (const file of modules) {
  if (stylesheetFiles.has(file)) continue
  scannedModules += 1
  auditModule(file, moduleText.get(file) ?? '')
}

const classNamesByFile = new Map()
for (const entry of parsedRules) {
  if (entry.rule.selector.startsWith('@')) continue
  for (const name of classNames(entry.rule.selector)) {
    if (!classNamesByFile.has(name)) classNamesByFile.set(name, entry)
  }
}
for (const [name, owner] of classNamesByFile) {
  const base = name.includes('--') ? name.slice(0, name.indexOf('--')) : name
  let consumed = false
  for (const file of modules) {
    if (stylesheetFiles.has(file)) continue
    const text = moduleText.get(file) ?? ''
    if (text.includes(name) || (base !== name && text.includes(base))) { consumed = true; break }
  }
  if (!consumed) {
    finding('dead-css', 'medium', owner.file, owner.rule.line, `.${name} has a style rule but no consumer; delete the dead CSS (S-20)`)
  }
}

/** `style-justification` directive: one visible, reasoned acceptance per line. */
const JUSTIFICATION = /(?:\/\/|\/\*|<!--)\s*style-justification:\s+([a-z][a-z0-9-]*)\s+(?:—|–|--|-)\s+(.+?)\s*(?:\*\/|-->)?\s*$/u

/**
 * Parse the justification directives of one module or stylesheet.
 * @param file - absolute path.
 * @param text - source text.
 * @returns directive entries `{ file, line, rule, reason, used }`.
 */
function directivesOf(file, text) {
  const directives = []
  text.split('\n').forEach((lineText, index) => {
    const match = JUSTIFICATION.exec(lineText)
    if (match !== null) {
      directives.push({ file: relative(ROOT, file), line: index + 1, rule: match[1], reason: match[2].trim(), used: false })
    }
  })
  return directives
}

const directives = []
for (const file of modules) directives.push(...directivesOf(file, moduleText.get(file) ?? ''))
const justified = []
for (const entry of [...findings]) {
  const directive = directives.find(candidate => candidate.file === entry.file
    && candidate.rule === entry.rule
    && (candidate.line === entry.line || candidate.line === entry.line - 1))
  if (directive === undefined) continue
  directive.used = true
  justified.push({ ...entry, reason: directive.reason, directiveLine: directive.line })
  findings.splice(findings.indexOf(entry), 1)
}
for (const directive of directives) {
  if (!RULES.has(directive.rule)) {
    finding('justification', 'medium', directive.file, directive.line,
      `unknown rule "${directive.rule}" in a style-justification; use one of ${[...RULES.keys()].filter(rule => rule !== 'justification').join(', ')}`)
  } else if (!directive.used) {
    finding('justification', 'medium', directive.file, directive.line,
      'style-justification matches no finding on the following line; move it, fix the rule id, or remove it')
  }
}

for (const rule of RULES.keys()) {
  if (!findings.some(entry => entry.rule === rule)) clean.add(rule)
}
const order = { high: 0, medium: 1, low: 2 }
findings.sort((left, right) => (order[left.severity] - order[right.severity])
  || left.file.localeCompare(right.file)
  || left.line - right.line)
const counts = {
  high: findings.filter(entry => entry.severity === 'high').length,
  medium: findings.filter(entry => entry.severity === 'medium').length,
  low: findings.filter(entry => entry.severity === 'low').length,
}
if (jsonOnly) {
  console.log(JSON.stringify({ scannedStylesheets, scannedRules, scannedModules, counts, clean: [...clean], justified, findings }, null, 2))
} else {
  console.log(`style-audit: ${scannedStylesheets} stylesheet source(s), ${scannedRules} rule(s), ${scannedModules} browser module(s)`)
  console.log(`  findings: ${counts.high} high, ${counts.medium} medium, ${counts.low} low; justified: ${justified.length}`)
  for (const rule of RULES.keys()) if (clean.has(rule)) console.log(`  PASS ${rule}: ${RULES.get(rule)}`)
  for (const entry of findings) {
    console.log(`  ${entry.severity.toUpperCase()} ${entry.rule} ${entry.file}:${entry.line} — ${entry.message}`)
  }
  for (const entry of justified) {
    console.log(`  JUSTIFIED ${entry.rule} ${entry.file}:${entry.line} — ${entry.reason} (directive line ${entry.directiveLine})`)
  }
  console.log('  Justify an authentic deviation with `// style-justification: <rule> — <reason>` on the line above the reported line (see --help).')
  console.log('  Visual review (ACCEPTANCE-rc2 §5.3/§5.4) remains a manual gate.')
}
if (strict && (counts.high > 0 || counts.medium > 0)) process.exit(1)
