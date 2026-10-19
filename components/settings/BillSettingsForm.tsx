'use client'

import { useActionState, useState } from 'react'

import { saveBillSettings, type BillSettingsResult } from '@/app/actions/bill-settings'
import { Card, Field, SaveButton, Toggle } from '@/components/settings/form-parts'
import { settingsInput } from '@/components/settings/Modal'
import {
  BANK_DETAILS_MAX, BILL_TEMPLATE_HELP, BILL_TEMPLATE_LABELS, BILL_TEMPLATES, CURRENCY_SYMBOL_MAX,
  DEFAULT_TAX_LABEL, formatRate, REGISTERED_ADDRESS_MAX, splitTax, TAX_LABEL_MAX, TAX_NUMBER_MAX,
  type BillSettings, type BillTemplate,
} from '@/lib/bill/settings'

/**
 * Settings > Bills: which of the three templates a company's bills use, and
 * everything a bill says about the company — its registered address, tax and
 * registration numbers, the tax line, the currency symbol, and how to pay.
 *
 * NOTHING HERE IS JAMAICA-SPECIFIC. The tax line's label and rate, the
 * currency symbol and the tax ID's label are all the company's own. The tax ID
 * label is the one General Settings already sets for customers' tax IDs
 * (country, or its override), so a company's TRN and its customers' TRNs are
 * called the same thing.
 *
 * Each template has a sample PDF made from this company's saved settings,
 * brand and letterhead, so what is chosen here is seen before a customer sees
 * it. The samples show the SAVED settings: save, then open a sample.
 */
export function BillSettingsForm({
  settings,
  available,
  taxRateAvailable,
  contactAddress,
  defaultSymbol,
  hasLetterhead,
  onlineAvailable,
}: {
  settings: BillSettings
  /** Migration 0038. */
  available: boolean
  /** Migration 0007: settings.tax_rate. */
  taxRateAvailable: boolean
  /** companies.address, printed when no registered address is set. */
  contactAddress: string | null
  /** The symbol settings.currency gives, shown as the placeholder. */
  defaultSymbol: string
  hasLetterhead: boolean
  /** A payment gateway is on, so bills offer "Card, online". */
  onlineAvailable: boolean
}) {
  const [state, action] = useActionState<BillSettingsResult | null, FormData>(saveBillSettings, null)
  const [template, setTemplate] = useState<BillTemplate>(settings.template)
  const [registered, setRegistered] = useState(settings.taxRegistered)
  const [rate, setRate] = useState(settings.taxRate ? String(settings.taxRate) : '')
  const [label, setLabel] = useState(settings.taxLabelOverride ?? '')
  const [symbol, setSymbol] = useState(settings.currencySymbolOverride ?? '')

  const locked = !available
  const lockedClass = (on: boolean) => settingsInput + (on ? '' : ' cursor-not-allowed opacity-50')

  // The example the tax hint works through, in the company's own symbol and
  // label, so the tax-inclusive rule is seen rather than read.
  const shownSymbol = symbol.trim() || defaultSymbol
  const shownLabel = label.trim() || DEFAULT_TAX_LABEL
  const rateNum = Number(rate)
  const example = splitTax(3500, Number.isFinite(rateNum) ? rateNum : 0)
  const fmt = (n: number) => shownSymbol + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <form action={action} className="space-y-4">
      {state ? (
        <p
          role="alert"
          className={
            'rounded-lg border px-3 py-2 text-sm ' +
            (state.ok
              ? 'border-green-900/60 bg-green-950/40 text-green-300'
              : 'border-red-900/60 bg-red-950/50 text-red-300')
          }
        >
          {state.ok ? state.message : state.error}
        </p>
      ) : null}

      {/* ---- Template ---- */}
      <Card title="Bill Template">
        <input type="hidden" name="bill_template" value={template} />
        <div className="grid gap-3 md:grid-cols-3" role="radiogroup" aria-label="Bill template">
          {BILL_TEMPLATES.map((t) => (
            <div
              key={t}
              className={
                'flex flex-col rounded-lg border p-3 transition ' +
                (template === t ? 'border-blue-500 bg-blue-950/30' : 'border-gray-700 bg-gray-800/40')
              }
            >
              <button
                type="button"
                role="radio"
                aria-checked={template === t}
                disabled={locked}
                onClick={() => setTemplate(t)}
                className="text-left disabled:cursor-not-allowed"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-white">
                  <span
                    className={
                      'inline-block h-3.5 w-3.5 rounded-full border-2 ' +
                      (template === t ? 'border-blue-400 bg-blue-400' : 'border-gray-500')
                    }
                  />
                  {BILL_TEMPLATE_LABELS[t]}
                  {t === 'statement' ? <span className="text-[10px] font-medium text-gray-500">default</span> : null}
                </span>
                <span className="mt-1.5 block text-[11px] leading-relaxed text-gray-500">{BILL_TEMPLATE_HELP[t]}</span>
              </button>
              <a
                href={'/api/company/bill-sample?template=' + t}
                target="_blank"
                rel="noreferrer"
                className="mt-auto pt-3 text-xs font-medium text-blue-400 hover:text-blue-300"
              >
                Open a sample (PDF)
              </a>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-gray-600">
          Customers download it from the portal, and staff print it from the customer record. Samples use
          your saved settings — save first to see a change.
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---- The company ---- */}
        <Card title="Your Company on the Bill">
          <Field
            label="Registered business address"
            htmlFor="registered_address"
            hint={
              contactAddress
                ? 'Leave blank to print your contact address from General Settings.'
                : 'Printed under your name. One line per line.'
            }
          >
            <textarea
              id="registered_address"
              name="registered_address"
              rows={3}
              maxLength={REGISTERED_ADDRESS_MAX}
              defaultValue={settings.registeredAddress ?? ''}
              placeholder={contactAddress ?? ''}
              disabled={locked}
              className={lockedClass(!locked) + ' resize-y'}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field
              label={settings.taxIdLabel}
              htmlFor="company_tax_id"
              hint="Your business's tax ID. Its name comes from General Settings."
            >
              <input
                id="company_tax_id"
                name="company_tax_id"
                maxLength={TAX_NUMBER_MAX}
                defaultValue={settings.taxId ?? ''}
                disabled={locked}
                className={lockedClass(!locked)}
              />
            </Field>
            <Field label="Tax registration number" htmlFor="tax_registration_number" hint="Printed only when registered for tax.">
              <input
                id="tax_registration_number"
                name="tax_registration_number"
                maxLength={TAX_NUMBER_MAX}
                defaultValue={settings.taxRegistrationNumber ?? ''}
                disabled={locked}
                className={lockedClass(!locked)}
              />
            </Field>
          </div>
          <p className="text-[11px] text-gray-600">
            Letterhead: {hasLetterhead
              ? 'uploaded — it heads every bill in place of your name, logo and address.'
              : 'none. Upload one under General Settings, beside your logo, to print your own stationery at the top.'}
          </p>
        </Card>

        {/* ---- Tax ---- */}
        <Card title="Tax Line">
          <Toggle
            name="tax_registered"
            label="Registered for tax"
            checked={registered}
            onChange={setRegistered}
            disabled={locked}
          />
          <p className="text-[11px] text-gray-600">
            Off: no tax line at all, and the bill is an invoice rather than a tax invoice.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Tax line label" htmlFor="tax_label" hint="e.g. GCT, VAT, Sales tax.">
              <input
                id="tax_label"
                name="tax_label"
                maxLength={TAX_LABEL_MAX}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={DEFAULT_TAX_LABEL}
                disabled={locked}
                className={lockedClass(!locked)}
              />
            </Field>
            <Field label="Tax rate %" htmlFor="tax_rate" hint={taxRateAvailable ? undefined : 'Needs migration 0007.'}>
              <input
                id="tax_rate"
                name="tax_rate"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="0"
                disabled={locked || !taxRateAvailable}
                className={lockedClass(!locked && taxRateAvailable)}
              />
            </Field>
          </div>
          <p className="text-[11px] leading-relaxed text-gray-500">
            Your prices already include tax; a bill never adds it on top. {registered && rateNum > 0
              ? 'A ' + fmt(3500) + ' month prints as ' + fmt(example.net) + ' plus ' + shownLabel + ' ' +
                formatRate(rateNum) + ' ' + fmt(example.tax) + '.'
              : 'Turn on "Registered for tax" and set a rate to print the tax line.'}
          </p>
        </Card>

        {/* ---- Money and payment ---- */}
        <Card title="Currency">
          <Field
            label="Currency symbol"
            htmlFor="currency_symbol"
            hint={'Blank uses ' + defaultSymbol + ', from your currency in General Settings. Used on bills and the customer portal.'}
          >
            <input
              id="currency_symbol"
              name="currency_symbol"
              maxLength={CURRENCY_SYMBOL_MAX}
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder={defaultSymbol}
              disabled={locked}
              className={lockedClass(!locked)}
            />
          </Field>
        </Card>

        <Card title="How to Pay">
          <Field
            label="Bank details"
            htmlFor="bank_details"
            hint="The bank transfer column. The customer's account number is added as the reference."
          >
            <textarea
              id="bank_details"
              name="bank_details"
              rows={3}
              maxLength={BANK_DETAILS_MAX}
              defaultValue={settings.bankDetails ?? ''}
              placeholder="e.g. NCB 351-000-000, West Central Networks"
              disabled={locked}
              className={lockedClass(!locked) + ' resize-y'}
            />
          </Field>
          <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-gray-500">
            <li>
              In person: {settings.paymentNote
                ? 'your portal payment note from General Settings.'
                : 'set a portal payment note in General Settings to fill this column.'}
            </li>
            <li>
              Card, online: {onlineAvailable
                ? 'your portal address, because online payment is on.'
                : 'shown once online payment is set up under Online Payments.'}
            </li>
          </ul>
        </Card>
      </div>

      {available ? <SaveButton /> : null}
    </form>
  )
}
