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
export function searchClauses(query: string): string[] {
  return searchTokens(query).map((token) => {
    const p = pattern(token)
    const parts = [
      'first_name.ilike.' + p,
      'last_name.ilike.' + p,
      'phone.ilike.' + p,
      'address.ilike.' + p,
      'mac_address.ilike.' + p,
    ]
    // `customers` HAS NO ACCOUNT NUMBER COLUMN — see lib/data/receipts.ts,
    // which omits the receipt's Account line for the same reason. The row id is
    // the only account-shaped identifier the system has, and it is what the
    // customer's own URL ends in, so a digits-only word is matched against it
    // as well as against the phone. The day a real account number column
    // exists, add it here and to matchesCustomer and nothing else changes.
    const id = asId(token)
    if (id) parts.push('id.eq.' + id)
    return parts.join(',')
  })
}

/** The fields a search reads. Kept next to the clause builder above. */
export type SearchableCustomer = {
  id: number
  first_name: string | null
  last_name: string | null
  phone: string | null
  address: string | null
  mac_address: string | null
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
