/**
 * The shape of a `customer_updated` log row: what changed, from what, to what.
 *
 * CLIENT-SAFE ON PURPOSE. lib/format.ts#humaniseLogDetail renders these rows
 * and is imported by client components, so the encoding and the parsing live
 * here rather than beside the server action that writes them. The reader for
 * these rows is lib/data/customer-changes.ts.
 *
 * The row is written by app/actions/customers.ts#updateCustomer through
 * lib/audit.ts#logEvent, like everything else in the log.
 */

/** The log `type` for a customer edit. */
export const CUSTOMER_UPDATED = 'customer_updated'

/** One field that changed, already rendered for display. */
export type FieldChange = {
  /** The column name, e.g. 'monthly_rate'. */
  field: string
  /** Human label, e.g. 'Monthly rate'. */
  label: string
  from: string
  to: string
}

/**
 * What each column is called in the log.
 *
 * A column absent from this map is a column the edit form does not write —
 * adding one here is what makes it appear in a customer's history, so the map
 * and the patch in updateCustomer are meant to be read side by side.
 */
export const FIELD_LABELS: Record<string, string> = {
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  phone: 'Phone',
  address: 'Address',
  gps: 'GPS',
  mac_address: 'MAC address',
  monthly_rate: 'Monthly rate',
  cut_off_date: 'Cut-off day',
  bill_date: 'Bill day',
  customer_type: 'Connection',
  pppoe_username: 'PPPoE username',
  pppoe_password: 'PPPoE password',
  access_point: 'Access point',
  connection_type: 'Connection type',
  customer_category: 'Category',
  notes: 'Notes',
  misc_category_id: 'Segment',
  service_plan_id: 'Service plan',
  expiry_mode: 'Expiry mode',
  addons: 'Add-ons',
}

/** Shown in place of a value that is null, empty, or only whitespace. */
export const EMPTY = '(none)'

/**
 * What a changed password logs as.
 *
 * THE VALUE IS NEVER RECORDED. `pppoe_password` is a live credential and the
 * log is readable by every manager; writing it here would turn an audit trail
 * into a place to harvest them. That the password changed, when, and by whom
 * is the auditable fact — the password itself is not.
 */
export const REDACTED = '(changed)'

/**
 * Longest a single value may be in the log.
 *
 * `notes` and `address` are free text with no length limit on the form. A
 * change to a long note should say that it changed, not paste an essay into
 * the activity feed twice over.
 */
const MAX_VALUE = 80

/**
 * Makes one value safe to put in a `| name=value` field.
 *
 * THE PIPE IS THE WHOLE REASON THIS EXISTS. humaniseLogDetail reads fields with
 * `\| name=([^|]+)`, so a pipe inside a value silently truncates the field and
 * everything after it — and `notes` and `address` are free text a user types.
 * Semicolons separate changes from each other, so those go too. Neither
 * character carries meaning in a name, an address or a note, so replacing them
 * costs nothing that reading the row back does not gain.
 */
export function safeValue(raw: unknown): string {
  if (raw === null || raw === undefined) return EMPTY

  const text = String(raw).replace(/[|;]/g, '/').replace(/\s+/g, ' ').trim()
  if (!text) return EMPTY
  return text.length > MAX_VALUE ? text.slice(0, MAX_VALUE - 1) + '…' : text
}

/** Encodes the changes into the `changes=` field of a log row. */
export function encodeChanges(changes: FieldChange[]): string {
  return changes.map((c) => c.field + ': ' + c.from + ' → ' + c.to).join('; ')
}

/**
 * Reads `changes=` back into a list.
 *
 * Tolerant by design: a row written by an older version of this code, or one
 * hand-edited in the SQL editor, should degrade to something readable rather
 * than render as nothing. Anything that does not split into the expected parts
 * comes back as a bare label with no from/to.
 */
export function decodeChanges(encoded: string): FieldChange[] {
  return encoded
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const colon = part.indexOf(':')
      if (colon === -1) {
        return { field: part, label: FIELD_LABELS[part] ?? part, from: '', to: '' }
      }
      const field = part.slice(0, colon).trim()
      const rest = part.slice(colon + 1).trim()
      const [from, to] = rest.split('→').map((s) => s.trim())
      return {
        field,
        label: FIELD_LABELS[field] ?? field,
        from: from ?? '',
        to: to ?? '',
      }
    })
}

/**
 * Whether two stored values are the same, the way the database sees them.
 *
 * THE FALSE-POSITIVE GUARD. A form submits everything as a string; PostgREST
 * returns whatever the column type is. So the old value of monthly_rate comes
 * back as the number 2500 and the new one arrives as the string '2500', and a
 * plain !== would call that a change — meaning opening a customer and pressing
 * Save with no edits would write a log row claiming every numeric field moved.
 * A history that records edits nobody made is worse than no history: it buries
 * the real ones.
 *
 * null, undefined and '' are all "nothing here" and equal to each other. A
 * blank optional field saved back as null is not something to tell anyone
 * about.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v === null || v === undefined || v === ''
  if (empty(a) && empty(b)) return true
  if (empty(a) || empty(b)) return false

  // Numeric when EITHER side is a number, so '2500' from the form matches 2500
  // from the column. Both being non-numeric strings falls through to the text
  // comparison below.
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb
  }
  return String(a) === String(b)
}

/**
 * The log `type` for a customer deletion.
 *
 * Lives here beside CUSTOMER_UPDATED because the two are the pair that records
 * what happened to a customer record. They are written very differently
 * though: an update files its row against the customer, and a DELETION CANNOT
 * — the delete sweeps `log` by customer_id, so a row naming the customer would
 * be destroyed by the very act it exists to record. See
 * app/actions/customers.ts#logDeletion.
 */
export const CUSTOMER_DELETED = 'customer_deleted'
