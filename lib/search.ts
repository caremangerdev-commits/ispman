/**
 * Customer lookup, shared by the two places that search for one.
 *
 * There used to be two implementations — an in-memory filter behind the
 * customer list (lib/data/customers.ts) and a PostgREST `or` filter behind
 * /api/search, which the global search box and the record-payment picker both
 * call. They matched on overlapping but different field sets, so a customer
 * findable at the counter was not necessarily findable on the list. This module
 * is the one definition of "does this customer match what was typed", in both
 * the SQL and the JavaScript dialect.
 *
 * THE TWO MUST STAY IN STEP. If you add a field, add it to both
 * `searchClauses` and `matchesCustomer` — the tests a cashier runs are at a
 * counter with a queue behind them, and a field that only one half searches
 * reads as "the system can't find me" either way.
 */

/**
 * How many whitespace-separated words are honoured.
 *
 * Each word becomes its own OR clause and every clause has to match, so the
 * query grows with the word count. Four is more than any real counter query —
 * "Marcia Brown Slipe 876" is already four — and it bounds what a paste of a
 * whole paragraph into the search box can cost.
 */
const MAX_TOKENS = 4

/**
 * A word that is an id, `1234` or `#1234`.
 *
 * Bounded at nine digits because `customers.id` is a Postgres `int4`: a longer
 * run of digits would overflow it, and PostgREST answers `id.eq.<overflow>`
 * with a 400 that would fail the whole search rather than simply not matching.
 * A cashier typing a long number is typing a phone number anyway, which the
 * ilike clauses already cover.
 */
const ID_TOKEN = /^#?(\d{1,9})$/

/**
 * Splits what was typed into the words that all have to match.
 *
 * Multiple words are ANDed, not ORed, and each word is ORed across the fields.
 * That is what makes "John Smith" find the customer whose first_name is John
 * and last_name is Smith — neither field contains the whole string — while
 * "Brown" alone still finds every Brown. It also means "John 876" narrows to
 * the John whose phone carries 876, which is how a name plus a partial number
 * gets used at a counter.
 */
export function searchTokens(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS)
}

/**
 * The `%term%` pattern for one word.
 *
 * PostgREST parses an `or` expression by its delimiters, so a comma or a
 * parenthesis in the typed text could otherwise change the shape of the filter
 * rather than being searched for. `*` is PostgREST's own alias for `%` inside
 * an ilike value and is stripped for the same reason — it would silently turn
 * into a wildcard the cashier did not ask for.
 */
function pattern(token: string): string {
  return '%' + token.replace(/[%*,()]/g, '') + '%'
}

/** The digits of `1234` or `#1234`. Null when the word is not an id. */
function asId(token: string): string | null {
  return ID_TOKEN.exec(token)?.[1] ?? null
}

/**
 * One PostgREST `or` clause per word, to be applied with a `.or()` each.
 *
 * Chained `.or()` calls are ANDed by PostgREST — separate query parameters —
 * which is exactly the "every word must match something" rule above, without
 * having to nest logical operators inside a single expression.
 *
 * Returns an empty array for a blank query, meaning "no filter", not
 * "match nothing".
 */
export function searchClauses(
  query: string,
  /**
   * Whether migration 0020 has been applied.
   *
   * MUST BE PASSED HONESTLY. PostgREST rejects the WHOLE query for one unknown
   * column, so naming account_number before the migration exists does not
   * degrade the search — it breaks it outright, everywhere it is used.
   */
  opts: { accountNumbers?: boolean } = {}
): string[] {
  return searchTokens(query).map((token) => {
    const p = pattern(token)
    const parts = [
      'first_name.ilike.' + p,
      'last_name.ilike.' + p,
      'phone.ilike.' + p,
      'address.ilike.' + p,
      'mac_address.ilike.' + p,
    ]
    if (opts.accountNumbers) parts.push('account_number.ilike.' + p)
    // The row id, still matched now that account numbers exist alongside it.
    // It is what the customer's own URL ends in and what an operator reads off
    // the address bar, so a digits-only word is checked against it as well as
    // against the phone and the account number.
    const id = asId(token)
    if (id) parts.push('id.eq.' + id)
    return parts.join(',')
  })
}

/**
 * The same rule as searchClauses, restricted to the NAME fields.
 *
 * The search box asks for these separately so that customers whose NAME
 * matches are always among the candidates it ranks, however many others match
 * only on an address. Without it a common address word decides who is fetched:
 * at Ezmze "Ena Brown" matched ten customers, most through "Brown's Town", and
 * Ena Brown herself was not in the eight returned (7 Oct 2026).
 */
export function nameClauses(query: string): string[] {
  return searchTokens(query).map((token) => {
    const p = pattern(token)
    return 'first_name.ilike.' + p + ',last_name.ilike.' + p
  })
}

/**
 * How well a customer matches what was typed. Higher is better; ranking only,
 * never filtering — matchesCustomer / searchClauses decide WHETHER they match.
 *
 * Scored per word, best field wins, summed over the words:
 *
 *   100  a whole word of the name ("ena" in ENA BROWN)
 *    90  the row id or the whole account number
 *    60  the start of a name word ("bro" in BROWN)
 *    40  anywhere in the name ("ena" in JUDEENA)
 *    20  phone, account number or MAC
 *     5  the address only
 *
 * So a name match always outranks an address match, and the person whose name
 * IS what was typed comes first.
 */
export function matchScore(row: SearchableCustomer, query: string): number {
  const tokens = searchTokens(query)
    .map((t) => t.replace(/[%*,()]/g, '').toLowerCase())
    .filter(Boolean)

  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').toLowerCase()
  const nameWords = name.split(/[\s'.-]+/).filter(Boolean)
  const account = (row.account_number ?? '').toLowerCase()
  const other = [row.phone, row.account_number, row.mac_address].map((v) => (v ?? '').toLowerCase())
  const address = (row.address ?? '').toLowerCase()

  let score = 0
  for (const t of tokens) {
    let best = 0
    if (nameWords.includes(t)) best = 100
    else if (asId(t) === String(row.id) || (account !== '' && account === t)) best = 90
    else if (nameWords.some((w) => w.startsWith(t))) best = 60
    else if (name.includes(t)) best = 40
    else if (other.some((v) => v.includes(t))) best = 20
    else if (address.includes(t)) best = 5
    score += best
  }
  return score
}

/**
 * Best match first: matchScore, then name A-Z, then id, so equal scores come
 * back in the same order every time.
 */
export function rankCustomers<T extends SearchableCustomer>(rows: T[], query: string): T[] {
  const nameOf = (r: T) => [r.first_name, r.last_name].filter(Boolean).join(' ').toLowerCase()
  return rows
    .map((row) => ({ row, score: matchScore(row, query) }))
    .sort((a, b) =>
      b.score - a.score || nameOf(a.row).localeCompare(nameOf(b.row)) || a.row.id - b.row.id)
    .map((x) => x.row)
}

/** The fields a search reads. Kept next to the clause builder above. */
export type SearchableCustomer = {
  id: number
  first_name: string | null
  last_name: string | null
  phone: string | null
  address: string | null
  mac_address: string | null
  /** Migration 0020. Undefined on callers that predate it. */
  account_number?: string | null
}

/**
 * The in-memory half of the same rule, for the customer list.
 *
 * Case-insensitive and substring-matched, like `ilike` above. The joined
 * "first last" is included so a single-word query still behaves as it did, and
 * so the two halves agree on a name typed with its space.
 */
export function matchesCustomer(row: SearchableCustomer, query: string): boolean {
  const tokens = searchTokens(query)
  if (tokens.length === 0) return true

  const haystack = [
    row.first_name,
    row.last_name,
    [row.first_name, row.last_name].filter(Boolean).join(' '),
    row.phone,
    row.address,
    row.mac_address,
    row.account_number ?? null,
  ]
    .map((v) => (v ?? '').toLowerCase())
    .filter(Boolean)

  return tokens.every((token) => {
    // The id is compared for equality, not as a substring, because that is
    // what `id.eq` does on the SQL side. Matching it loosely here would make
    // "38" find customer 388 on the list and not in the payment picker, which
    // is the exact divergence this module exists to prevent.
    if (asId(token) === String(row.id)) return true

    const needle = token.replace(/[%*,()]/g, '').toLowerCase()
    return needle ? haystack.some((v) => v.includes(needle)) : true
  })
}
