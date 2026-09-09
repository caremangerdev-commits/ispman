/**
 * Reading a whole table past PostgREST's row ceiling.
 *
 * PostgREST answers an unranged select with AT MOST 1000 ROWS AND NO ERROR.
 * A read that expects the full set gets a truncated one and cannot tell —
 * there is no flag on the response and nothing is logged. Ezmze Company Ltd.
 * had 977 customers when this was written, so their customer list was around
 * twenty signups from dropping people off the end of their own list, off the
 * status tab counts, and out of the search, silently.
 *
 * Anything that reads a company's rows in full and then works over them in
 * memory has to page. `.limit(n)` does not help: the ceiling is applied after
 * it, so a limit above 1000 is still cut to 1000.
 */

/** Rows per request. The server ceiling; asking for more returns 1000. */
const PAGE = 1000

/**
 * Pages that would exhaust before this are a bug, not a big table.
 *
 * Two million rows for one company is not a customer list, it is a loop that
 * is not advancing — a page factory that ignores its arguments would otherwise
 * fetch the same 1000 rows forever. Throwing beats hanging a request.
 */
const MAX_PAGES = 2000

/**
 * Collects every row a paged select returns.
 *
 * `page` is called with each inclusive range and must apply it with `.range()`
 * on an otherwise identical query. THE QUERY MUST CARRY A STABLE ORDER, or the
 * pages are cut from an unspecified ordering and rows can be repeated or
 * missed between requests. Order by a unique ascending column — id — so a row
 * inserted while the pages are being read lands after the reader rather than
 * shifting rows into or out of a range already fetched.
 *
 * Rows come back as `unknown[]`, cast by the caller. The Supabase builder's
 * own row type is already erased by the dynamic select strings this codebase
 * assembles from lib/schema.ts, so a generic here would only be inventing a
 * guarantee the query cannot make.
 */
export async function fetchAllRows(
  page: (
    from: number,
    to: number
  ) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  /** Names the table in the error, e.g. 'customers'. */
  label: string
): Promise<unknown[]> {
  const rows: unknown[] = []

  for (let i = 0; i < MAX_PAGES; i++) {
    const from = i * PAGE
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new Error('Failed to load ' + label + ': ' + error.message)

    const batch = data ?? []
    rows.push(...batch)

    // A short page is the last one. A full page might be, and costs one more
    // request to find out — cheaper than the alternative, which is guessing.
    if (batch.length < PAGE) return rows
  }

  throw new Error(
    'Refusing to load ' + label + ': more than ' + MAX_PAGES * PAGE + ' rows.'
  )
}
