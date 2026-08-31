'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { createCompany, type CompanyResult } from '@/app/actions/platform'
import { CURRENCIES, TIMEZONES } from '@/lib/data/company'

const inputCls =
  'w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder:text-gray-500 outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/30'

const lockedCls = inputCls + ' cursor-not-allowed opacity-50'

function Field({
  label, htmlFor, hint, required, children,
}: {
  label: string
  htmlFor?: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-gray-400">
        {label}
        {required ? <span className="ml-0.5 text-red-400" aria-hidden>*</span> : null}
      </label>
      {children}
      {hint ? <p className="text-[11px] text-gray-600">{hint}</p> : null}
    </div>
  )
}

function Card({ title, subtitle, children }: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      {subtitle ? <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p> : null}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  )
}

function SaveButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Creating…' : 'Create Company'}
    </button>
  )
}

export function NewCompanyForm() {
  const [state, formAction] = useActionState<CompanyResult | null, FormData>(
    createCompany, null
  )

  const prior = state && !state.ok ? (state.values ?? {}) : {}
  const v = (name: string) => prior[name] ?? ''

  return (
    <form action={formAction} className="space-y-4">
      {state && !state.ok ? (
        <p
          role="alert"
          className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300"
        >
          {state.error}
        </p>
      ) : null}

      <Card title="Company">
        <Field label="Name" htmlFor="name" required>
          <input id="name" name="name" defaultValue={v('name')} className={inputCls} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" htmlFor="email">
            <input id="email" name="email" type="email" defaultValue={v('email')} className={inputCls} />
          </Field>
          <Field label="Phone" htmlFor="phone">
            <input id="phone" name="phone" defaultValue={v('phone')} className={inputCls} />
          </Field>
        </div>

        <Field label="Address" htmlFor="address">
          <input id="address" name="address" defaultValue={v('address')} className={inputCls} />
        </Field>
      </Card>

      <Card title="Locale">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Currency" htmlFor="currency" required>
            <select
              id="currency"
              name="currency"
              defaultValue={v('currency') || 'JMD'}
              className={inputCls}
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </Field>

          <Field label="Timezone" htmlFor="timezone" required>
            <select
              id="timezone"
              name="timezone"
              defaultValue={v('timezone') || 'America/Jamaica'}
              className={inputCls}
            >
              {TIMEZONES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      {/* Disabled on purpose. The Mikrotik is configured by hand today, and
          nothing in this app reads these two values yet — a filled-in field
          would imply the platform acts on them. Disabled inputs post nothing,
          so no dead values reach the database either. */}
      <Card
        title="Network"
        subtitle="Reference only — the Mikrotik is configured by hand. Not yet in use."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="DDNS Hostname"
            htmlFor="ddns_hostname"
            hint="Not yet in use — set this later in the company's own settings."
          >
            <input
              id="ddns_hostname"
              name="ddns_hostname"
              placeholder="e.g. myisp.ddns.net"
              disabled
              className={lockedCls}
            />
          </Field>

          <Field
            label="Network Shared Secret"
            htmlFor="radius_secret"
            hint="Not yet in use — set this later in the company's own settings."
          >
            <input
              id="radius_secret"
              name="radius_secret"
              type="password"
              autoComplete="new-password"
              disabled
              className={lockedCls}
            />
          </Field>
        </div>
      </Card>

      <Card
        title="First Admin User"
        subtitle="Signs in as company admin. They can add the rest of the team themselves."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First Name" htmlFor="admin_first_name" required>
            <input
              id="admin_first_name"
              name="admin_first_name"
              defaultValue={v('admin_first_name')}
              className={inputCls}
            />
          </Field>
          <Field label="Last Name" htmlFor="admin_last_name" required>
            <input
              id="admin_last_name"
              name="admin_last_name"
              defaultValue={v('admin_last_name')}
              className={inputCls}
            />
          </Field>
        </div>

        <Field label="Email" htmlFor="admin_email" required hint="Used to sign in.">
          <input
            id="admin_email"
            name="admin_email"
            type="email"
            autoComplete="off"
            defaultValue={v('admin_email')}
            className={inputCls}
          />
        </Field>

        <Field
          label="Temporary Password"
          htmlFor="admin_password"
          required
          hint="At least 8 characters. Share it with them — they can change it from their account menu."
        >
          <input
            id="admin_password"
            name="admin_password"
            type="text"
            minLength={8}
            autoComplete="new-password"
            className={inputCls}
          />
        </Field>
      </Card>

      <div className="flex items-center gap-2">
        <SaveButton />
        <Link
          href="/superadmin"
          className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
