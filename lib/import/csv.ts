/**
 * The rules behind the CSV customer importer.
 *
 * Everything here is pure and free of database access, because BOTH SIDES RUN
 * IT. The wizard runs these functions in the browser to build the preview the
 * operator approves; `app/actions/import.ts` runs the same functions on the
 * same raw strings to build the rows it writes. A preview that disagreed with
 * the write would be worse than no preview at all, so there is exactly one
 * implementation of each rule and neither side re-states it.
 *
 * NOTHING IN THIS FILE MAY NAME A COLUMN FROM A PARTICULAR ISP'S FILE. Every
 * operator sends a different layout; the header guesses below are generic word
 * fragments, and every one of them is a suggestion the operator overrides in
 * step 2.
 */

// ---------------------------------------------------------------------------
// Fields a column can be mapped to
// ---------------------------------------------------------------------------

export type FieldTarget =
  | 'full_name'
  | 'first_name'
  | 'last_name'
  | 'phone'
  | 'address'
  | 'service_plan'
  | 'monthly_rate'
  | 'cut_off_day'
  | 'mac_address'
  | 'pppoe_username'
  | 'notes'
  | 'ignore'

/** Dropdown order in step 2. `ignore` sits last as the opt-out. */
export const FIELD_TARGETS: FieldTarget[] = [
  'full_name', 'first_name', 'last_name', 'phone', 'address', 'service_plan',
  'monthly_rate', 'cut_off_day', 'mac_address', 'pppoe_username', 'notes', 'ignore',
]

export const FIELD_LABELS: Record<FieldTarget, string> = {
  full_name: 'Full name',
  first_name: 'First name',
  last_name: 'Last name',
  phone: 'Phone',
  address: 'Address',
  service_plan: 'Service plan',
  monthly_rate: 'Monthly rate',
  cut_off_day: 'Cut off day',
  mac_address: 'MAC address',
  pppoe_username: 'PPPoE username',
  notes: 'Notes',
  ignore: 'Ignore',
}

/**
 * The key a value travels under once it is off the spreadsheet.
 *
 * Deliberately not the database column names: `full_name` has no column, and
 * `rate`/`mac` are still raw text at this stage rather than the numeric and
 * normalised forms that eventually get written.
 */
export type ImportField =
  'name' | 'first' | 'last' | 'phone' | 'address' | 'plan' | 'rate' | 'cutOff'
  | 'mac' | 'pppoe' | 'notes'

const TARGET_FIELD: Record<Exclude<FieldTarget, 'ignore'>, ImportField> = {
  full_name: 'name',
  first_name: 'first',
  last_name: 'last',
  phone: 'phone',
  address: 'address',
  service_plan: 'plan',
  monthly_rate: 'rate',
  cut_off_day: 'cutOff',
  mac_address: 'mac',
  pppoe_username: 'pppoe',
  notes: 'notes',
}

/** One spreadsheet row reduced to the fields the operator mapped. */
export type RawRow = Partial<Record<ImportField, string>>

// ---------------------------------------------------------------------------
// Text keys
// ---------------------------------------------------------------------------

/**
 * Case, spacing and punctuation removed.
 *
 * Used for two different comparisons that happen to want the same rule:
 * guessing a column's meaning from its header, and matching a plan name in the
 * file against one already in `service_plans` ("MAX P" against "Max P").
 */
export function normaliseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Header fragments, in priority order — the first rule that matches wins.
 *
 * The order carries real weight. "MAC ADDRESS" contains both `mac` and
 * `address`, so the MAC rule has to come first; "CUSTOMER PHONE" contains both
 * `phone` and `customer`, so the catch-all name rule has to come last. The
 * fragments are shortened where an exported header is commonly misspelled —
 * `monthl` catches "MONTHLEY BILL" as well as "MONTHLY".
 */
const GUESSES: { target: Exclude<FieldTarget, 'ignore'>; hints: string[]; unless?: string[] }[] = [
  { target: 'mac_address', hints: ['mac', 'hwaddr', 'hardwareaddress'] },
  { target: 'pppoe_username', hints: ['pppoe', 'username', 'userid', 'userame', 'login'] },
  // Ahead of the money rule so a "CUT OFF" header can never be read as a
  // charge. `cutoff` alone covers "CUT OFF", "CUTOFF", "CUT OFF DATE" and
  // "CUT OFF DAY" once punctuation and spaces are gone.
  //
  // "DUE DATE" is deliberately NOT matched: in an exported file it is as often
  // the bill day as the cut-off day, and guessing it as the cut-off would be
  // wrong more often than right. "DUE DAY" is unambiguous enough.
  { target: 'cut_off_day', hints: ['cutoff', 'dueday'] },
  {
    target: 'monthly_rate',
    hints: ['monthl', 'rate', 'amount', 'price', 'charge', 'bill', 'fee', 'cost', 'tariff'],
    // "BILL DATE" is a day of the month, not money.
    unless: ['date', 'day'],
  },
  { target: 'phone', hints: ['phone', 'mobile', 'cell', 'tel', 'contact', 'whatsapp'] },
  {
    target: 'address',
    hints: ['address', 'street', 'location', 'community', 'district', 'town', 'area', 'premise'],
  },
  { target: 'service_plan', hints: ['plan', 'package', 'tier', 'subscription', 'service'] },
  { target: 'notes', hints: ['note', 'comment', 'remark', 'description'] },
  { target: 'first_name', hints: ['firstname', 'fname', 'givenname', 'forename', 'first'] },
  { target: 'last_name', hints: ['lastname', 'lname', 'surname', 'familyname', 'last'] },
  { target: 'full_name', hints: ['name', 'customer', 'client', 'subscriber'] },
]

function guessTarget(header: string): FieldTarget {
  const key = normaliseKey(header)
  if (!key) return 'ignore'

  for (const rule of GUESSES) {
    if (rule.unless?.some((word) => key.includes(word))) continue
    if (rule.hints.some((hint) => key.includes(hint))) return rule.target
  }
  return 'ignore'
}

/**
 * A first pass at what each column means.
 *
 * A target is only guessed once: a file carrying both "NAME" and "CUSTOMER
 * NAME" would otherwise land two Full name columns and quietly drop one at
 * import time. The later column is left on Ignore for the operator to decide.
 * Manual duplicates are still permitted — extractRow() takes the leftmost.
 */
export function guessMapping(headers: string[]): FieldTarget[] {
  const used = new Set<FieldTarget>()
  return headers.map((header) => {
    const guess = guessTarget(header)
    if (guess === 'ignore' || used.has(guess)) return 'ignore'
    used.add(guess)
    return guess
  })
}

export function extractRow(cells: string[], mapping: FieldTarget[]): RawRow {
  const out: RawRow = {}
  mapping.forEach((target, i) => {
    if (target === 'ignore') return
    const field = TARGET_FIELD[target]
    // Leftmost wins if the operator points two columns at one field.
    if (out[field] === undefined) out[field] = (cells[i] ?? '').trim()
  })
  return out
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export type NameParts = { first: string; last: string }

/**
 * Splits a single name column into the two NOT NULL columns.
 *
 * The last word is the surname and everything before it is the first name,
 * which is the only rule that survives contact with real data — middle names,
 * two-word surnames and initials all differ per file, and guessing between
 * them would be worse than a rule the operator can predict.
 *
 * A trailing counter is dropped: exported lists repeat a household with
 * "KENESHA BROWN 2" for the second line, and that digit is not part of anyone's
 * name.
 *
 * A single word is a name, not a missing one. It becomes the surname, because
 * `last_name` is what the app shows and sorts by, and the first name is left
 * empty rather than invented.
 */
export function splitFullName(raw: string): NameParts {
  const cleaned = raw.replace(/\s+/g, ' ').trim().replace(/\s*\d+$/, '').trim()
  if (!cleaned) return { first: '', last: '' }

  const words = cleaned.split(' ')
  if (words.length === 1) return { first: '', last: words[0] }
  return { first: words.slice(0, -1).join(' '), last: words[words.length - 1] }
}

// ---------------------------------------------------------------------------
// MAC addresses
// ---------------------------------------------------------------------------

/**
 * The value `customers.mac_address` defaults to.
 *
 * Omitting the key on an insert stores this, which is why the writer always
 * sends an explicit null instead. A file that literally contains it is the
 * same hazard arriving by another route, so normaliseMac() reports it as
 * missing rather than as a value.
 */
export const PLACEHOLDER_MAC = '00:00:00:00:00:00'

export type MacResult =
  | { kind: 'ok'; mac: string }
  | { kind: 'missing' }
  | { kind: 'invalid' }

/**
 * Normalises to uppercase colon form, accepting colons, dashes, dots or bare
 * hex — every separator an export has been seen to use.
 *
 * Only those separators are stripped. Stray text is NOT filtered out, so
 * "AA:BB:CC:DD:EE:GG" and "n/a" come back invalid rather than being silently
 * reshaped into something that looks like a MAC.
 */
export function normaliseMac(raw: string | null | undefined): MacResult {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { kind: 'missing' }

  const hex = trimmed.replace(/[\s:.-]/g, '')
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return { kind: 'invalid' }

  const mac = (hex.toUpperCase().match(/.{2}/g) as string[]).join(':')
  return mac === PLACEHOLDER_MAC ? { kind: 'missing' } : { kind: 'ok', mac }
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Reads a monthly rate out of a billing column, tolerating a currency symbol
 * and thousands separators. Returns null for anything that is not a number —
 * blanks, "N/A", "see notes" — which the writer stores as 0.
 */
export function parseRate(raw: string | null | undefined): number | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null

  const cleaned = trimmed.replace(/[^0-9.-]/g, '')
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null

  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// Cut off day
// ---------------------------------------------------------------------------

/**
 * The same 1-28 window the Add Customer form enforces.
 *
 * A cut-off day has to exist in every month, February included, or a customer
 * on the 31st would have no cut-off in most of the year.
 */
export const CUT_OFF_DAY_MIN = 1
export const CUT_OFF_DAY_MAX = 28

/**
 * Last resort when neither the file nor the company settings supply a day.
 *
 * Mirrors the `customers.cut_off_date` column default, so a customer written
 * this way holds the same value they would have held had the key been omitted.
 */
export const DEFAULT_CUT_OFF_DAY = 5

export type CutOffDayResult =
  | { kind: 'ok'; day: number }
  /** Empty cell — means "use the default", and is NOT an exception. */
  | { kind: 'blank' }
  /** Something was there but it is not a usable day. Falls back, and is listed. */
  | { kind: 'invalid' }

/**
 * Reads a cut-off day from a cell holding either a bare day or a whole date.
 *
 * Exports vary: some carry "7", some carry the next cut-off as a date. Taking
 * the FIRST number covers a bare day and a day-first date ("07/09/2026" -> 7),
 * which is the format this app's settings default to. An ISO date is detected
 * separately and read from its last component, because its first number is the
 * year and would otherwise be rejected as out of range.
 *
 * Anything else — a name, a blank-but-punctuated cell, a day outside 1-28 —
 * comes back invalid. The caller falls back rather than failing the row: a
 * cut-off day is not worth refusing a customer over.
 */
export function parseCutOffDay(raw: string | null | undefined): CutOffDayResult {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { kind: 'blank' }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed)
  const digits = iso ? iso[3] : /\d+/.exec(trimmed)?.[0]
  if (!digits) return { kind: 'invalid' }

  const day = Number(digits)
  if (!Number.isInteger(day) || day < CUT_OFF_DAY_MIN || day > CUT_OFF_DAY_MAX) {
    return { kind: 'invalid' }
  }
  return { kind: 'ok', day }
}

// ---------------------------------------------------------------------------
// Rows that are not customers
// ---------------------------------------------------------------------------

export type RowKind = 'blank' | 'section_header' | 'customer'

/**
 * Separates the two kinds of row that must be skipped in silence from the rows
 * that become customers. Neither appears in the exception list: they are not
 * failed imports, they are not customers at all.
 *
 * A section header is a location banner typed across the row — "ORANGE HILL"
 * sitting in the name, plan and MAC columns at once. It is recognised by the
 * same text repeating across two or more mapped columns, which is something no
 * real customer row does.
 *
 * This can only fire when at least two columns are mapped, since one column
 * cannot repeat anything. A name-only mapping therefore imports its headers as
 * customers, and that is accepted rather than papered over with a guess about
 * what a location name looks like.
 */
export function classifyRow(cells: string[], mapping: FieldTarget[]): RowKind {
  if (cells.every((cell) => !cell.trim())) return 'blank'

  const seen = new Set<string>()
  for (let i = 0; i < mapping.length; i++) {
    if (mapping[i] === 'ignore') continue
    const value = (cells[i] ?? '').trim().toLowerCase()
    if (!value) continue
    if (seen.has(value)) return 'section_header'
    seen.add(value)
  }
  return 'customer'
}

// ---------------------------------------------------------------------------
// Resolving a row
// ---------------------------------------------------------------------------

export type ExceptionReason =
  | 'missing name'
  | 'missing MAC address'
  | 'invalid MAC format'
  | 'duplicate MAC within this file'
  | 'MAC already used by an existing customer'
  | 'missing or non numeric monthly rate'
  | 'invalid cut off day, using company default'

/**
 * A spreadsheet row turned into the values that will be written, plus whatever
 * is wrong with it.
 *
 * Every reason except `missing name` is informational: the row still imports.
 * A customer with no MAC is a real customer who simply has not been put on the
 * network yet.
 */
export type ResolvedRow = {
  /** Line in the file, counting the header as row 1 — what the operator sees. */
  rowNumber: number
  first_name: string
  last_name: string
  phone: string
  address: string
  plan: string
  pppoe: string
  notes: string
  /** Uppercase colon form, or null for "no MAC" — never the placeholder. */
  mac: string | null
  rate: number | null
  /** Day from the file, or null for "fall back to the company setting". */
  cutOffDay: number | null
  reasons: ExceptionReason[]
}

export type ResolveOptions = {
  /** MAC problems are only worth reporting if the operator mapped a MAC column. */
  macMapped: boolean
  /** Same for the rate: an unmapped rate column is a choice, not a defect. */
  rateMapped: boolean
  /** Unmapped means every customer takes the company setting, as before. */
  cutOffMapped: boolean
}

export function resolveRow(
  rowNumber: number,
  raw: RawRow,
  options: ResolveOptions
): ResolvedRow {
  const reasons: ExceptionReason[] = []

  // Full name wins when both it and the parts are mapped: it is the column the
  // operator went out of their way to choose a splitting rule for.
  let { first, last } =
    raw.name !== undefined
      ? splitFullName(raw.name)
      : { first: (raw.first ?? '').trim(), last: (raw.last ?? '').trim() }

  // The single-word rule, applied to the two-column mapping as well: a lone
  // first name is a name, and last_name is the column that must not be empty.
  if (!last && first) {
    last = first
    first = ''
  }
  if (!last) reasons.push('missing name')

  let mac: string | null = null
  if (options.macMapped) {
    const result = normaliseMac(raw.mac)
    if (result.kind === 'ok') mac = result.mac
    else if (result.kind === 'invalid') reasons.push('invalid MAC format')
    else reasons.push('missing MAC address')
  }

  let rate: number | null = null
  if (options.rateMapped) {
    rate = parseRate(raw.rate)
    if (rate === null) reasons.push('missing or non numeric monthly rate')
  }

  // Null means "the writer picks the fallback". A blank cell says exactly that
  // and is not flagged — a file where most customers sit on the company day
  // would otherwise report hundreds of exceptions and bury the real ones. A
  // value that was present but unusable IS flagged, because someone typed
  // something and it is not being honoured.
  let cutOffDay: number | null = null
  if (options.cutOffMapped) {
    const parsed = parseCutOffDay(raw.cutOff)
    if (parsed.kind === 'ok') cutOffDay = parsed.day
    else if (parsed.kind === 'invalid') {
      reasons.push('invalid cut off day, using company default')
    }
  }

  return {
    rowNumber,
    first_name: first,
    last_name: last,
    phone: (raw.phone ?? '').trim(),
    address: (raw.address ?? '').trim(),
    plan: (raw.plan ?? '').trim(),
    pppoe: (raw.pppoe ?? '').trim(),
    notes: (raw.notes ?? '').trim(),
    mac,
    rate,
    cutOffDay,
    reasons,
  }
}

/**
 * How many customers land on each cut-off day.
 *
 * Shown in the preview so the operator can see at a glance whether the file
 * genuinely carries mixed days or the same value repeated down the column —
 * the latter usually means they mapped the wrong column. The null bucket is
 * everyone falling back to the company setting.
 */
export function summariseCutOffDays(
  rows: ResolvedRow[]
): { day: number | null; count: number }[] {
  const counts = new Map<number | null, number>()
  for (const row of rows) {
    counts.set(row.cutOffDay, (counts.get(row.cutOffDay) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([day, count]) => ({ day, count }))
    // Days ascending, with the fallback bucket last: it is the summary line,
    // not one of the days found.
    .sort((a, b) => (a.day === null ? 1 : b.day === null ? -1 : a.day - b.day))
}

/**
 * Adds the two MAC problems that no single row can see on its own.
 *
 * Every row sharing a duplicated MAC is flagged, including the first one —
 * whoever fixes this needs the whole set, not the copies. Duplicates still
 * import: `mac_address` carries no unique constraint, so they insert cleanly
 * and are the operator's to sort out afterwards.
 */
export function withMacConflicts(
  rows: ResolvedRow[],
  existingMacs: ReadonlySet<string>
): ResolvedRow[] {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const row of rows) {
    if (!row.mac) continue
    if (seen.has(row.mac)) duplicated.add(row.mac)
    else seen.add(row.mac)
  }

  return rows.map((row) => {
    if (!row.mac) return row
    const extra: ExceptionReason[] = []
    if (duplicated.has(row.mac)) extra.push('duplicate MAC within this file')
    if (existingMacs.has(row.mac)) extra.push('MAC already used by an existing customer')
    return extra.length ? { ...row, reasons: [...row.reasons, ...extra] } : row
  })
}

/** A row with no name cannot become a customer; everything else can. */
export function isImportable(row: ResolvedRow): boolean {
  return !row.reasons.includes('missing name')
}

export function displayNameOf(row: ResolvedRow): string {
  return [row.first_name, row.last_name].filter(Boolean).join(' ') || '(no name)'
}

// ---------------------------------------------------------------------------
// Service plans found in the file
// ---------------------------------------------------------------------------

export type PlanSummary = {
  /** normaliseKey() of the name — how it is matched and how rows find its id. */
  key: string
  /** The spelling as it first appears in the file. */
  name: string
  customerCount: number
  /** The MOST COMMON rate among these customers, or null if none are numeric. */
  commonRate: number | null
}

/**
 * Groups the file's rows by plan name and suggests a price for each.
 *
 * Callers pass the rows that will actually be written, not every row scanned —
 * a count is only useful if it is the number of customers the plan is about to
 * have, and a plan named only on rows that cannot import should not be created
 * for nobody.
 *
 * The suggestion is the mode, NOT the mean: one customer on a legacy rate or a
 * typo with an extra zero would drag an average away from the number the plan
 * actually costs, and the operator would have to notice that to catch it.
 * Ties go to whichever rate appears first in the file, so the suggestion is
 * stable across re-runs of the same import.
 */
export function summarisePlans(rows: ResolvedRow[]): PlanSummary[] {
  type Group = { name: string; count: number; counts: Map<number, number>; order: number[] }
  const groups = new Map<string, Group>()

  for (const row of rows) {
    if (!row.plan) continue
    const key = normaliseKey(row.plan)
    if (!key) continue

    let group = groups.get(key)
    if (!group) {
      group = { name: row.plan, count: 0, counts: new Map(), order: [] }
      groups.set(key, group)
    }

    group.count += 1
    if (row.rate !== null) {
      if (!group.counts.has(row.rate)) group.order.push(row.rate)
      group.counts.set(row.rate, (group.counts.get(row.rate) ?? 0) + 1)
    }
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      let commonRate: number | null = null
      let best = 0
      for (const rate of group.order) {
        const count = group.counts.get(rate) as number
        if (count > best) {
          best = count
          commonRate = rate
        }
      }
      return { key, name: group.name, customerCount: group.count, commonRate }
    })
    .sort((a, b) => b.customerCount - a.customerCount || a.name.localeCompare(b.name))
}

/** The existing plan whose name matches, ignoring case, spaces and punctuation. */
export function matchExistingPlan<T extends { id: number; name: string }>(
  key: string,
  existing: T[]
): T | null {
  return existing.find((plan) => normaliseKey(plan.name) === key) ?? null
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Above this the file is refused rather than trimmed.
 *
 * The browser parses the whole file and holds the preview in memory, and the
 * import runs as one operator-supervised sitting; past a few thousand rows both
 * stop being reasonable. Splitting the file is a thing the operator can
 * actually do, so that is what they are told to do.
 */
export const MAX_ROWS = 5000

/**
 * Rows sent to the server per call.
 *
 * Small enough that the progress bar moves several times on a real file, large
 * enough that the per-request session lookup and schema probe are not the
 * dominant cost of the import. Lives here rather than beside the action it
 * belongs to because a `'use server'` module may only export async functions.
 */
export const BATCH_SIZE = 250
