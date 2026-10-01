/**
 * The printed page for a receipt: 80mm wide and exactly as tall as its lines.
 *
 * THE HEIGHT IS COMPUTED, BECAUSE CSS CANNOT ASK FOR IT. There is no "roll
 * width, automatic height": `size: 80mm auto` is not valid CSS, the browser
 * drops the declaration and takes the driver's page instead — a roll reported
 * as 3276mm long. The fixed `80mm 200mm` that replaced it printed at the right
 * scale but fed 200mm of paper for an 80mm receipt, every time.
 *
 * A receipt is a known number of fixed-height lines (lib/receipt.ts), so its
 * height is arithmetic rather than something to be measured: the page is given
 * an explicit height, as the drivers need, and that height is the content's.
 *
 * No imports, on purpose: scripts/verify-receipt-print.mjs loads this file
 * directly so the page it asserts is the page the modal prints.
 */

/**
 * `.receipt-print` in app/globals.css: 10pt at line-height 1.3, under a 2mm
 * top margin. These restate that rule and move only with it — the verify
 * script fails on a second page or a wrong height if they drift apart.
 */
const LINE_HEIGHT_PT = 13
const TOP_MARGIN_MM = 2

/** Page height for a receipt of `lineCount` lines, in mm. */
export function receiptPageHeightMm(lineCount: number): number {
  const mm = (Math.max(lineCount, 1) * LINE_HEIGHT_PT * 25.4) / 72 + TOP_MARGIN_MM
  // Rounded UP to a tenth of a millimetre. Rounded down, the last line is a
  // hair taller than the page and becomes a second page of its own.
  return Math.ceil(mm * 10) / 10
}

/**
 * The `@page` rule for a receipt of `lineCount` lines.
 *
 * Rendered into the document after the stylesheet, so it replaces the fallback
 * size in app/globals.css. The width is that rule's 80mm, unchanged.
 */
export function receiptPageCss(lineCount: number): string {
  return `@media print { @page { size: 80mm ${receiptPageHeightMm(lineCount).toFixed(1)}mm; margin: 0; } }`
}
