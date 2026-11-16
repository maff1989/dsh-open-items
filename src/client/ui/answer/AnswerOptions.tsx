/**
 * Exclusive answer choices as a native radio list (AnswerOptions v2).
 *
 * The previous implementation used the shipped `Pill`, whose idle fill
 * (`bg-layer-2`) equals the page background in the light theme and whose fixed
 * 24 px height lets a long sentence wrap to two lines that overflow the capsule:
 * the choices painted as loose grey prose with no affordance. A radio list is
 * the honest control for "pick one of these sentences" — it is visible, it has
 * a selection state, it keeps native keyboard behaviour (arrows/space), and the
 * label text can wrap.
 *
 * "(Recommended)" is presentation, not data: the schema carries no recommended
 * flag, so a trailing marker in the option text is split into a quiet tag and the
 * full original string is still what the payload sends.
 *
 * @module dsh-open-items/client/ui/answer/AnswerOptions
 */
import { useId, type ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'

import type { PageTranslate } from '../../format'

/** Props of one exclusive option group. */
export interface AnswerOptionsProps {
  readonly t: PageTranslate
  readonly options: readonly string[]
  /** Chosen option, or null before the user picks one. */
  readonly value: string | null
  readonly onChange: (option: string) => void
  readonly disabled?: boolean
}

/**
 * Split a trailing "(Recommended)" marker off an option label.
 * @param option - the option as the raised item carries it.
 * @returns the display label and whether the marker was present.
 */
export function splitRecommended(option: string): { label: string; recommended: boolean } {
  const match = /\s*\(recommended\)\s*$/i.exec(option)
  if (match === null) return { label: option, recommended: false }
  return { label: option.slice(0, match.index).trimEnd(), recommended: true }
}

/**
 * Render the answer choices as one exclusive radio list.
 * @param props - copy, choices, current choice and its change handler.
 * @returns the radio group.
 */
export function AnswerOptions({ t, options, value, onChange, disabled }: AnswerOptionsProps): ReactNode {
  const name = useId()
  return (
    <div className="dsh-oi-optionList" role="radiogroup" aria-label={t('answer.options.aria')}>
      {options.map(option => {
        const { label, recommended } = splitRecommended(option)
        const selected = value === option
        return (
          <label
            key={option}
            className="dsh-oi-option"
            data-selected={selected ? 'true' : 'false'}
            data-disabled={disabled === true ? 'true' : undefined}
          >
            <input
              type="radio"
              className="dsh-oi-optionInput"
              name={name}
              value={option}
              checked={selected}
              disabled={disabled}
              onChange={() => {
                onChange(option)
              }}
            />
            <span className="dsh-oi-optionDot" aria-hidden="true" />
            <span className="dsh-oi-optionText">{label}</span>
            {recommended && <Tag tone="quiet" className="dsh-oi-optionRecommended">{t('answer.options.recommended')}</Tag>}
          </label>
        )
      })}
    </div>
  )
}
