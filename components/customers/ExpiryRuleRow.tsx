'use client'

import {
  anniversaryExpiry, EXPIRY_RULES, EXPIRY_RULE_LABELS, parseYmd, serviceExpiry,
  type ExpiryRule,
} from '@/lib/billing'

/**
 * The customer's expiry rule (migration 0039), and what it means for THIS
 * customer in words staff can read out at the counter.
 *
 * The dates in the explanation come from the same functions the till and the
 * payment path land the expiry with (lib/billing.ts), so what the record says
 * a payment will do is what a payment does.
 *
 * Changing the rule writes customers.expiry_rule and nothing else — no expiry
 * moves (app/actions/customers.ts#updateCustomer). The next payment is the
 * first one it applies to.
 */
export function ExpiryRuleRow({
  rule,
  chosen,
  onChoose,
  editing,
  editable,
  modelApplies,
  cutOffDay,
  anniversaryDay,
  expiryDate,
  todayYmd,
}: {
  /** As saved. */
  rule: ExpiryRule
  /** What the edit buttons currently say. */
  chosen: ExpiryRule
  onChoose: (rule: ExpiryRule) => void
  editing: boolean
  /** Migration 0039 applied and this role may change it. */
  editable: boolean
  /** The prepaid calendar model applies to the company: the rule is inert. */
  modelApplies: boolean
  cutOffDay: number | null
  anniversaryDay: number | null
  /** The expiry the registry holds, "YYYY-MM-DD", or null. */
  expiryDate: string | null
  /** Today in the company's zone, "YYYY-MM-DD". From the server, so the two renders agree. */
  todayYmd: string
}) {
  const shown = editing ? chosen : rule
  const canChoose = editing && editable && !modelApplies

  return (
    <div className="px-4 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-gray-500">Expiry Rule</span>
        {canChoose ? (
          <span className="flex gap-1.5" role="group" aria-label="Expiry rule">
            <input type="hidden" name="expiry_rule" value={chosen} />
            {EXPIRY_RULES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => onChoose(r)}
                aria-pressed={chosen === r}
                className={
                  'rounded-md px-2 py-1 text-[11px] font-semibold transition ' +
                  (chosen === r
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200')
                }
              >
                {EXPIRY_RULE_LABELS[r]}
              </button>
            ))}
          </span>
        ) : (
          <span className={'text-sm ' + (modelApplies && rule === 'anniversary' ? 'text-gray-500 line-through' : 'text-gray-200')}>
            {EXPIRY_RULE_LABELS[rule]}
          </span>
        )}
      </div>
      <div className="mt-1 space-y-0.5 text-[11px] leading-snug text-gray-600">
        {explain({ rule: shown, modelApplies, cutOffDay, anniversaryDay, expiryDate, todayYmd }).map((line) => (
          <p key={line}>{line}</p>
        ))}
        {editing && editable && !modelApplies && chosen !== rule ? (
          <p className="text-amber-400/90">
            Saving changes no expiry. The next payment is the first to use this rule.
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** "17 Nov 2026" from a local-midnight Date. */
function day(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return n + tail
}

/** The explanation, as separate sentences. Pure. */
function explain(opts: {
  rule: ExpiryRule
  modelApplies: boolean
  cutOffDay: number | null
  anniversaryDay: number | null
  expiryDate: string | null
  todayYmd: string
}): string[] {
  const { rule, modelApplies, cutOffDay, anniversaryDay } = opts

  if (modelApplies) {
    return [
      'This company bills prepaid by calendar month, so expiry follows the month and the ' +
        'anniversary rule is not applied.',
    ]
  }

  const today = parseYmd(opts.todayYmd) ?? new Date()
  const expiry = parseYmd(opts.expiryDate)
  const active = expiry !== null && opts.expiryDate !== null && opts.expiryDate > opts.todayYmd

  if (rule === 'company') {
    const next = serviceExpiry({ cutOffDay, currentExpiry: expiry, from: today, months: 1 })
    const head = cutOffDay
      ? 'Renews to the cut-off day (day ' + cutOffDay + ') after the current expiry.'
      : 'No cut-off day is set, so a payment adds one month.'
    return [head, 'A month paid today runs to ' + day(next) + '.']
  }

  const next = anniversaryExpiry({ currentExpiry: expiry, from: today, months: 1, anniversaryDay })
  const lines = ['Renews to the same day next month as the payment.']
  if (active && expiry) {
    lines.push(
      'Still active: a payment adds a month to the current expiry, so no days are lost. ' +
        'Runs to ' + day(expiry) + '; paying now takes it to ' + day(next.expiry) + '.'
    )
  } else {
    lines.push(
      (expiry ? 'Cut off since ' + day(expiry) + ': ' : 'Not connected yet: ') +
        'a payment runs from the payment day to the same day next month. Paying today runs to ' +
        day(next.expiry) + '.'
    )
  }
  lines.push(
    next.day > 28
      ? 'Their anniversary is the ' + ordinal(next.day) + '. In a month without that day it is the ' +
        'last day of the month, and the month after goes back to the ' + ordinal(next.day) + '.'
      : 'A day the next month does not have becomes its last day (paid on the 31st, runs to ' +
        '30 Nov), and the month after goes back to the 31st.'
  )
  return lines
}
