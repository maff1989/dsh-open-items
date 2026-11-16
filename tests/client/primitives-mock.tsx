/**
 * Functional stand-ins for the shell's ui-primitives module in component tests.
 *
 * The real package is a platform module at runtime; its published entry imports
 * `clsx`, which this package cannot rely on existing in a worktree checkout
 * (the precedent plugin hits the same boundary). Component tests only need the
 * semantic contract — button/menu/pill/tab/dialog roles, accessible names and
 * pressed/selected/expanded state — so each atom is a plain DOM element and
 * every icon renders nothing.
 */
import {
  createElement,
  forwardRef,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'

/** Stand-in glyph for every icon export. */
function Glyph(): null {
  return null
}

/** Buckets of the platform's relative-time helper, mirrored for label tests. */
export function relativeTime(at: number, now: number): { unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'; n: number } {
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const month = 30 * day
  const year = 365 * day
  const elapsed = Math.max(0, now - at)
  if (elapsed < minute) return { unit: 'now', n: 0 }
  if (elapsed < hour) return { unit: 'minutes', n: Math.floor(elapsed / minute) }
  if (elapsed < day) return { unit: 'hours', n: Math.floor(elapsed / hour) }
  if (elapsed < month) return { unit: 'days', n: Math.floor(elapsed / day) }
  if (elapsed < year) return { unit: 'months', n: Math.floor(elapsed / month) }
  return { unit: 'years', n: Math.floor(elapsed / year) }
}

/** Native button carrying the visual-only props out of the attribute set. */
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: string
  size?: string
  icon?: ReactNode
}>(function Button({ variant, size, icon, className = '', children, ...rest }, ref) {
  void variant
  void size
  return createElement('button', { ...rest, ref, className }, icon ?? null, children)
})
Button.displayName = 'Button'

/** Native input (the real atom adds a wrapper span and a leading icon). */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }>(function Input(
  { icon, className = '', ...rest },
  ref,
) {
  void icon
  return createElement('input', { ...rest, ref, className })
})
Input.displayName = 'Input'

/** Read-only tag rendered as a span. */
export function Tag({ tone, className = '', children }: { tone?: string; className?: string; children?: ReactNode }) {
  void tone
  return createElement('span', { className }, children)
}

/** Selectable capsule (the real `Pill`): button with `aria-pressed`. */
export const Pill = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }>(
  function Pill({ active, className = '', children, ...rest }, ref) {
    return createElement('button', { ...rest, ref, type: rest.type ?? 'button', className, 'aria-pressed': active }, children)
  },
)
Pill.displayName = 'Pill'

/** Tooltip that only renders its anchor in tests. */
export function Tooltip({ children }: { children?: ReactNode }) {
  return children ?? null
}

/** Tab list that keeps the real control's tab roles and accessible names. */
export function SegmentedTabs<Value extends string>({ items, value, onChange, label, className }: {
  items: readonly { value: Value; label: ReactNode; id: string; panelId?: string }[]
  value: Value
  onChange: (value: Value) => void
  label: string
  className?: string
  size?: string
}) {
  return createElement(
    'div',
    { role: 'tablist', 'aria-label': label, className },
    items.map(item => createElement(
      'button',
      {
        key: item.value,
        type: 'button',
        role: 'tab',
        id: item.id,
        'aria-selected': item.value === value,
        ...(item.panelId === undefined ? {} : { 'aria-controls': item.panelId }),
        onClick: () => { onChange(item.value) },
      },
      item.label,
    )),
  )
}

/** Exclusive mode control (the real `SegmentedControl`): one tablist, one selection. */
export function SegmentedControl<Value extends string>({ id, value, options, onChange, label, disabled, className }: {
  id: string
  value: Value
  options: readonly { readonly value: Value; readonly label: string; readonly disabled?: boolean; readonly title?: string }[]
  onChange: (next: Value) => void
  label: string
  disabled?: boolean
  className?: string | undefined
}) {
  return createElement(
    'div',
    { role: 'tablist', 'aria-label': label, className, 'data-control-id': id },
    options.map(option => createElement(
      'button',
      {
        key: option.value,
        type: 'button',
        role: 'tab',
        id: `${id}-${option.value}`,
        'aria-selected': option.value === value,
        'aria-controls': `${id}-${option.value}-panel`,
        disabled: disabled === true || option.disabled === true,
        ...(option.title === undefined ? {} : { title: option.title }),
        onClick: () => { if (option.value !== value) onChange(option.value) },
      },
      option.label,
    )),
  )
}

/** One data row or non-interactive heading/separator of the mocked menu. */
type MenuMockEntry =
  | { readonly id: string; readonly label: ReactNode; readonly disabled?: boolean; readonly type?: undefined }
  | { readonly type: 'separator' | 'label'; readonly id: string; readonly text?: string }

/**
 * Anchored dropdown (the real `Menu`): the anchor renders in place and the
 * list appears only while `open`. Row activation reports through `onSelect`;
 * closing stays the owner's state change, matching the primitive.
 */
export function Menu({ open, anchor, items, children, selectedId, selectedIds, onSelect, onClose, className, footer }: {
  open: boolean
  anchor: ReactNode
  items?: readonly MenuMockEntry[]
  children?: ReactNode
  selectedId?: string | undefined
  selectedIds?: readonly string[] | undefined
  onSelect?: (id: string) => void
  onClose: () => void
  className?: string | undefined
  footer?: readonly MenuMockEntry[]
}) {
  void selectedIds
  void footer
  void onClose
  const rows = (items ?? []).flatMap((entry): ReactNode[] => {
    if (entry.type !== undefined) {
      return entry.type === 'label'
        ? [createElement('div', { key: entry.id, role: 'presentation' }, entry.text ?? '')]
        : []
    }
    return [createElement('button', {
      key: entry.id,
      type: 'button',
      role: 'menuitem',
      'aria-current': selectedId === entry.id ? 'true' : undefined,
      disabled: entry.disabled === true,
      onClick: () => { if (entry.disabled !== true) onSelect?.(entry.id) },
    }, entry.label)]
  })
  return createElement(
    'span',
    { className, 'data-menu-open': open ? 'true' : undefined },
    anchor,
    open ? createElement('div', { role: 'menu' }, rows, children ?? null) : null,
  )
}

/** One component-rendered menu row (the real `MenuItemButton`). */
export function MenuItemButton({ children, current, disabled, disabledReason, danger, onSelect }: {
  children: ReactNode
  shortcut?: { readonly keys: readonly string[]; readonly aria?: string | undefined } | undefined
  icon?: ReactNode
  current?: boolean
  disabled?: boolean
  disabledReason?: string | undefined
  danger?: boolean
  separatorBefore?: boolean
  onSelect: () => void
}) {
  return createElement('button', {
    type: 'button',
    role: 'menuitem',
    'aria-current': current ? 'true' : undefined,
    'aria-disabled': disabled === true ? 'true' : undefined,
    disabled: disabled === true,
    'data-danger': danger ? 'true' : undefined,
    ...(disabled === true && disabledReason !== undefined
      ? { title: disabledReason, 'data-disabled-reason': disabledReason }
      : {}),
    onClick: () => { if (disabled !== true) onSelect() },
  }, children)
}

/** Compact disclosure header + controlled content (the real `DisclosureRow`). */
/** List animation container (the real `AnimatedRows`): rows render in place. */
export function AnimatedRows({ children, className, role, label }: {
  children?: ReactNode
  className?: string
  role?: string
  label?: string
  rowKeys?: readonly string[]
  ready?: boolean
  resetKey?: string
}) {
  return createElement('div', { className, role, 'aria-label': label, 'data-animated-rows': 'true' }, children)
}

export function DisclosureRow({ icon, title, open, expandable, onToggle, headerAccessory, children, className }: {
  icon: ReactNode
  title: string
  open: boolean
  expandable: boolean
  onToggle: () => void
  headerAccessory?: ReactNode
  children?: ReactNode
  className?: string | undefined
}) {
  return createElement(
    'div',
    { className },
    createElement(
      'div',
      { 'data-disclosure-row': 'true' },
      icon,
      expandable
        ? createElement('button', { type: 'button', 'aria-expanded': open, onClick: onToggle }, title)
        : createElement('span', null, title),
      headerAccessory ?? null,
    ),
    open ? (children ?? null) : null,
  )
}

/** Centered dialog (the real `Modal`): renders only while open. */
export function Modal({ open, onClose, title, description, children, footer, closeLabel, headless, onKeyDownCapture }: {
  open: boolean
  onClose: () => void
  title: string
  description?: string | undefined
  children?: ReactNode
  footer?: ReactNode
  closeLabel?: string | undefined
  headless?: boolean
  onKeyDownCapture?: unknown
}) {
  void onKeyDownCapture
  if (!open) return null
  return createElement(
    'div',
    { role: 'dialog', 'aria-label': title },
    headless === true
      ? null
      : createElement('h2', null, title),
    headless === true || closeLabel === undefined
      ? null
      : createElement('button', { type: 'button', 'aria-label': closeLabel, onClick: onClose }),
    description === undefined ? null : createElement('p', null, description),
    children ?? null,
    footer ?? null,
  )
}

/** Sensitive-action confirmation (the real `RiskConfirmation`): checkbox-gated primary. */
export function RiskConfirmation({ open, title, description, acknowledgeLabel, cancelLabel, closeLabel, confirmLabel, acknowledged, disabled, onAcknowledgedChange, onCancel, onConfirm }: {
  open: boolean
  title: string
  description: string
  acknowledgeLabel: string
  cancelLabel: string
  closeLabel: string
  confirmLabel: string
  acknowledged: boolean
  disabled?: boolean
  onAcknowledgedChange: (acknowledged: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  void closeLabel
  if (!open) return null
  return createElement(
    'div',
    { role: 'dialog', 'aria-label': title },
    createElement('h2', null, title),
    createElement('p', null, description),
    createElement(
      'label',
      null,
      createElement('input', {
        type: 'checkbox',
        checked: acknowledged,
        onChange: (event: ChangeEvent<HTMLInputElement>) => { onAcknowledgedChange(event.target.checked) },
      }),
      acknowledgeLabel,
    ),
    createElement('button', { type: 'button', onClick: onCancel }, cancelLabel),
    createElement('button', { type: 'button', disabled: disabled === true || !acknowledged, onClick: onConfirm }, confirmLabel),
  )
}

/** Keycap hint (the real `ShortcutKeys`): plain text so tests can read it. */
export function ShortcutKeys({ keys, variant, className }: {
  keys: readonly string[]
  variant?: 'plain' | 'tooltip'
  className?: string | undefined
}) {
  void variant
  return createElement('span', { className }, keys.join('+'))
}

/** Plain span for the state dot (decorative in the real primitive). */
export function StateDot({ state, size, className, appearance }: {
  state?: string
  size?: number
  className?: string
  appearance?: 'dot' | 'step'
}) {
  return createElement('span', {
    className,
    'data-state': state,
    'data-appearance': appearance,
    'data-size': size,
  })
}

export const IconChecklistOutlineRegular = Glyph
export const IconShieldOutlineRegular = Glyph
export const IconQuestionOutlineRegular = Glyph
export const IconListPenOutlineRegular = Glyph
export const IconWarningOutlineRegular = Glyph
export const IconWarningTriangleOutlineRegular = Glyph
export const IconRefreshOutlineRegular = Glyph
export const IconClockOutlineRegular = Glyph
export const IconCheckCircleOutlineRegular = Glyph
export const IconChevronRightOutlineRegular = Glyph
export const IconChevronDownOutlineRegular = Glyph
export const IconFlatListOutlineRegular = Glyph
export const IconFolderCloseRegular = Glyph
export const IconSearchOutlineRegular = Glyph
export const IconRightUpOutlineRegular = Glyph
export const IconCloseOutlineRegular = Glyph
export const IconEllipsisOutlineRegular = Glyph
export const IconTrashOutlineRegular = Glyph


/** Labeled checkbox stand-in (real semantics the risk confirmation needs). */
export function Checkbox({ checked, onChange, label, disabled, title, className }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string
  className?: string
}) {
  return createElement('label', { className, title },
    createElement('input', {
      type: 'checkbox',
      checked,
      disabled,
      onChange: (event: { target: { checked: boolean } }) => {
        onChange(event.target.checked)
      },
    }),
    label)
}

/** Controlled toggle stand-in with the real component's switch semantics. */
export function Switch({ checked, onChange, label, disabled, title, className }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string
  className?: string
}) {
  return createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    'aria-label': label,
    title,
    disabled,
    className,
    onClick: () => {
      onChange(!checked)
    },
  }, createElement('span', { 'data-thumb': 'true' }))
}

/** Six-line draft editor: Enter saves, Shift+Enter is a newline, Escape cancels. */export function InlineEditor({ value, label, onChange, onSave, onCancel, className }: {
  value: string
  label: string
  onChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
  className?: string
}) {
  return createElement('textarea', {
    className,
    'aria-label': label,
    value,
    onChange: (event: { target: { value: string } }) => {
      onChange(event.target.value)
    },
    onKeyDown: (event: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        onSave()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    },
  })
}

/** Transient banner stand-in: text, inline actions, and a manual dismiss. */
export function Toast({ text, actions, onDone }: {
  text: string
  icon?: ReactNode
  tone?: 'success'
  anchor?: HTMLElement | null
  holdMs?: number
  actions?: readonly { label: string; prefix?: string; onClick: () => void }[]
  onDone: () => void
}) {
  return createElement('div', { role: 'status', 'data-toast': 'true' },
    text,
    ...(actions ?? []).map(action => createElement('button', {
      key: action.label,
      type: 'button',
      onClick: action.onClick,
    }, action.label)),
    createElement('button', { type: 'button', 'aria-label': 'Dismiss notification', onClick: onDone }))
}
