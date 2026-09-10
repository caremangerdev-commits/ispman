/**
 * The `log.details` wire format: one definition, for everything that reads or
 * writes it.
 *
 * WHY THIS EXISTS. There were two parsers for this format in two files with two
 * implementations — lib/format.ts#humaniseLogDetail for the activity feed and a
 * private `parse()` inside components/customers/ChangeHistory.tsx — plus a third
 * copy of the marker rules in lib/audit.ts for the write side. They drifted, and
 * the drift shipped: ChangeHistory's field regex was written `'\| '` instead of
 * `'\\| '`, which is not an escaped pipe but an ALTERNATION with an empty left
 * branch. It matched at position 0 of every string, so the capture group was
 * always undefined and reading it threw. The activity feed, holding the correct
 * copy, kept working — two parsers disagreeing about rows they both read.
 *
 * This is the same failure lib/search.ts was created to end, and the same rule
 * applies: ONE definition, imported by everyone. Do not write a second regex
 * against this format anywhere.
 *
 * CLIENT-SAFE. The activity feed and the Change History card are both client
 * components; lib/audit.ts is server-only and imports from here, never the
 * other way round.
 */

/**
 * Appended to `details` when a platform operator writes into a tenant.
 *
 * A field on the existing `details` column rather than a new column, because
 * this project's migrations are applied by hand — a marker that depends on
 * someone remembering to run SQL is a marker that silently lies until they do.
 */
export function actingMarker(userId: number): string {
  return ' | via=super_admin:#' + userId
}

/**
 * The marker, anywhere in the string. For the WRITE path.
 *
 * Several `details` strings embed free-text form fields — checkoff notes, an
 * import's file name. Without stripping these on the way in, a tenant's own
 * staff could type "| via=super_admin:#1" into a notes box and have their
 * change render as the platform operator's.
 */
const MARKER_ANYWHERE = /\s*\|\s*via=super_admin:#\d+/gi

/** The marker as a suffix only. For the READ path — it is written last. */
const MARKER_TRAILING = /\s*\|\s*via=super_admin:#\d+\s*$/

/**
 * Removes anything shaped like the marker from caller-supplied text.
 *
 * The write path's sanitiser: lib/audit.ts runs this over every `details` it is
 * given, so the marker means one thing and only logEvent can put it there.
 */
export function stripActingMarkers(details: string): string {
  return details.replace(MARKER_ANYWHERE, '')
}

/** A stored `details` string, split into its text and its provenance. */
export type LogDetail = {
  /** The details with the trailing marker removed. */
  body: string
  /** True when this row was written by a platform operator inside a tenant. */
  viaPlatform: boolean
}

/**
 * Reads a stored row. Total: a null or empty `details` gives an empty body.
 */
export function readLogDetail(details: string | null | undefined): LogDetail {
  const raw = details ?? ''
  const body = raw.replace(MARKER_TRAILING, '')
  return { body, viaPlatform: body !== raw }
}

/**
 * One `| name=value` field out of a body, or null when it is not present.
 *
 * THE PIPE IS ESCAPED WITH TWO BACKSLASHES, and that is not a style choice. In
 * a JavaScript string `'\|'` is an unrecognised escape which JavaScript drops,
 * leaving the pattern `| name=(...)` — an alternation whose empty left branch
 * matches everything and whose capture group is therefore always undefined.
 * That exact typo took the customer page down. If you edit this line, edit it
 * with a tool that does not pass it through a shell.
 *
 * The value runs to the next pipe, so a value containing one truncates the
 * field — which is why writers put every free-text value through
 * lib/customer-changes.ts#safeValue first.
 */
export function logField(body: string, name: string): string | null {
  const m = new RegExp('\\| ' + name + '=([^|]+)').exec(body)
  // Guarded rather than trusted. The group is mandatory in this pattern, so a
  // match implies a value — but that was true of the broken version too, right
  // up until the pattern stopped being the pattern anyone intended.
  return m && m[1] !== undefined ? m[1].trim() : null
}

/**
 * The subject of an "<X> updated | …" row — the customer's name as it stood.
 *
 * Non-greedy up to the first pipe, so a name containing spaces survives and one
 * containing a pipe cannot swallow the fields after it.
 */
export function logSubject(body: string): string | null {
  const m = /^(.+?) updated \|/.exec(body.trim())
  return m ? m[1].trim() : null
}
