/**
 * CSV generation, for exports an owner opens in Excel.
 *
 * The whole point of this file is that the result behaves like data once it
 * gets there. Two things decide that and neither is obvious:
 *
 *   - AMOUNTS MUST BE BARE NUMBERS. `5000`, never `J$5,000`. A formatted
 *     amount arrives as text, will not sum, and defeats the reason for
 *     exporting figures at all. The currency belongs in the column heading.
 *   - THE FILE NEEDS A BOM. Excel reads a CSV without one as the system code
 *     page, so any name outside plain ASCII arrives mangled.
 */

/**
 * Spreadsheet formula characters.
 *
 * A cell whose text starts with one of these is EXECUTED by Excel, Sheets and
 * LibreOffice when the file is opened. Notes and customer names in this
 * database are free text typed at a counter, so this is not hypothetical: a
 * note beginning `=` or `+` becomes a live formula in a file somebody opens
 * without thinking about it, and `=HYPERLINK` or a DDE payload in one is a
 * known way to turn an innocuous-looking export into an attack on whoever
 * reads it.
 *
 * Tab and carriage return are included because both are stripped by the
 * spreadsheet before it decides what the cell starts with.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/

/**
 * One field, quoted and made safe.
 *
 * A leading formula character is neutralised with a single quote, which
 * spreadsheets treat as "the rest of this cell is text" and do not display.
 * The value is not otherwise altered — a note reading "-500 refund" still
 * says that, it simply stops being an expression.
 */
function field(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""'

  // Numbers are written bare and unquoted so the spreadsheet types them as
  // numbers. Non-finite values would render as "NaN" or "Infinity" text, so
  // they become empty instead.
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''

  const text = FORMULA_LEAD.test(value) ? "'" + value : value
  return '"' + text.replace(/"/g, '""') + '"'
}

/** One record. Numbers stay numeric; everything else is quoted text. */
export function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(field).join(',')
}

/**
 * Joins rows into a downloadable CSV body.
 *
 * CRLF because that is what RFC 4180 specifies and what Excel is least
 * surprised by; the BOM for the reason at the top of this file.
 */
export function csvFile(rows: string[]): string {
  return '\uFEFF' + rows.join('\r\n') + '\r\n'
}

/**
 * A filename-safe slug, for naming a download after the company.
 *
 * Anything that is not a letter, digit or dash collapses to a dash, so a
 * company name cannot inject a path separator or a quote into the
 * Content-Disposition header.
 */
export function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'export'
  )
}
