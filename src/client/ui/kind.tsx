/**
 * Kind presentation shared by rows and the detail pane: one glyph, one tone,
 * one dictionary key per item kind. Colour is never the only signal — the badge
 * always carries the word.
 *
 * The badge is the shipped read-only `Tag` (S-10): neutral for the ordinary
 * kinds, warning for approvals/risks, danger for blockers. `Tag` owns the
 * capsule geometry, so this file only supplies the glyph and the label.
 *
 * A prose candidate's kind is a guess, not a fact (D2): `KindChip` takes an
 * `inferred` flag that tints it as information and appends the localized
 * "inferred" qualifier, and `KindPicker` is the shipped `Menu` the candidate
 * detail and the bulk review use to correct it before the confirm write.
 *
 * @module dsh-open-items/client/ui/kind
 */
import { useState, type ReactNode } from 'react'
import {
  Button,
  IconCheckCircleOutlineRegular,
  IconChecklistOutlineRegular,
  IconChevronDownOutlineRegular,
  IconListPenOutlineRegular,
  IconQuestionOutlineRegular,
  IconRefreshOutlineRegular,
  IconShieldOutlineRegular,
  IconWarningOutlineRegular,
  IconWarningTriangleOutlineRegular,
  Menu,
  Tag,
  type MenuItem,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'

import type { OpenItemsKey } from '../locales'
import type { OpenItemKind } from '../../shared/schema'

/** Presentation of one kind. `render` keeps JSX out of the table's type. */
export interface KindMeta {
  readonly render: (size: number) => ReactNode
  readonly tone: 'neutral' | 'warning' | 'error'
  readonly label: OpenItemsKey
}

/** Kind metadata table; exhaustive over `OpenItemKind`. */
export const KIND_META: Record<OpenItemKind, KindMeta> = {
  decision: { render: size => <IconChecklistOutlineRegular size={size} />, tone: 'neutral', label: 'kind.decision' },
  approval: { render: size => <IconShieldOutlineRegular size={size} />, tone: 'warning', label: 'kind.approval' },
  question: { render: size => <IconQuestionOutlineRegular size={size} />, tone: 'neutral', label: 'kind.question' },
  'plan-review': { render: size => <IconListPenOutlineRegular size={size} />, tone: 'neutral', label: 'kind.plan-review' },
  blocker: { render: size => <IconWarningOutlineRegular size={size} />, tone: 'error', label: 'kind.blocker' },
  risk: { render: size => <IconWarningTriangleOutlineRegular size={size} />, tone: 'warning', label: 'kind.risk' },
  'follow-up': { render: size => <IconRefreshOutlineRegular size={size} />, tone: 'neutral', label: 'kind.follow-up' },
  task: { render: size => <IconCheckCircleOutlineRegular size={size} />, tone: 'neutral', label: 'kind.task' },
}

/** Correctable kinds in the order the picker offers them (decision/question first). */
export const KIND_ORDER: readonly OpenItemKind[] = [
  'decision',
  'question',
  'approval',
  'plan-review',
  'blocker',
  'risk',
  'follow-up',
  'task',
]

/** Semantic tone of one kind mapped onto the shipped tag palettes. */
const TAG_TONE: Record<KindMeta['tone'], TagTone> = {
  neutral: 'neutral',
  warning: 'warning',
  error: 'danger',
}

/**
 * Render one kind badge.
 * @param props - kind, localized label, glyph size and the inferred qualifier.
 * @returns the badge element.
 */
export function KindChip(props: {
  readonly kind: OpenItemKind
  readonly label: string
  readonly iconSize?: number
  /** True when the kind is the detector's guess and can still be corrected. */
  readonly inferred?: boolean
  /** Localized "inferred" qualifier (required with `inferred`). */
  readonly inferredLabel?: string
}): ReactNode {
  const meta = KIND_META[props.kind]
  const inferred = props.inferred === true
  return (
    <Tag tone={inferred ? 'info' : TAG_TONE[meta.tone]} className="dsh-oi-kindTag">
      <span className="dsh-oi-kindGlyph" aria-hidden="true">{meta.render(props.iconSize ?? 12)}</span>
      <span>{props.label}</span>
      {inferred && props.inferredLabel !== undefined && (
        <span className="dsh-oi-kindInferred"> · {props.inferredLabel}</span>
      )}
    </Tag>
  )
}

/**
 * Render the kind-correcting menu (candidate detail and bulk review).
 * @param props - current kind, translator, accessible name and the change hook.
 * @returns the picker element.
 */
export function KindPicker(props: {
  readonly kind: OpenItemKind
  readonly t: (key: OpenItemsKey) => string
  readonly ariaLabel: string
  readonly disabled?: boolean
  readonly onSelect: (kind: OpenItemKind) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const meta = KIND_META[props.kind]
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      selectedId={props.kind}
      items={KIND_ORDER.map(kind => ({ id: kind, label: props.t(KIND_META[kind].label) })) satisfies readonly MenuItem[]}
      onSelect={(id) => {
        setOpen(false)
        props.onSelect(id as OpenItemKind)
      }}
      anchor={(
        <Button
          size="sm"
          variant="outline"
          disabled={props.disabled === true}
          aria-label={props.ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          icon={meta.render(12)}
          onClick={() => { setOpen(value => !value) }}
        >
          {props.t(meta.label)}
          <IconChevronDownOutlineRegular size={12} />
        </Button>
      )}
    />
  )
}
