// Receipt print verification: compiles the real stylesheet, builds a fixture with
// the real ancestor chain, prints it through headless Chrome and Edge, and
// reads font, weight, stroke and glyph extents back out of the PDFs.
//
// It also ASSERTS the page: one page, 80mm wide, exactly as tall as the
// receipt. A second page or a page longer than the content is paper fed after
// the last line, and the run exits 1.
//
//   node scripts/verify-receipt-print.mjs <label>
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { inflateSync } from 'node:zlib'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'

// The real page rule, not a copy of it: the same function the modal renders.
import { receiptPageCss, receiptPageHeightMm } from '../lib/receipt-page.ts'

const label = process.argv[2] ?? 'run'
const OUT = tmpdir().split('\\').join('/') + '/ispman-receipt-print/' + label
mkdirSync(OUT, { recursive: true })

const failures = []

// --- 1. the real CSS, through the real pipeline ---------------------------------
const cssSource = readFileSync('app/globals.css', 'utf8')
const css = (await postcss([tailwind()]).process(cssSource, { from: 'app/globals.css' })).css
writeFileSync(OUT + '/compiled.css', css)

// --- 2. the fixture: the worst receipt, 32 columns, real ancestor chain ------------
const W = 32
const lines = [
  'W'.repeat(W),                                    // widest glyph run there is
  '='.repeat(W),
  'WEST CENTRAL NETWORKS LIMITED'.padEnd(W),
  'Receipt #00001847'.padEnd(W),
  'Date: 14 Sep 2026 10:42 AM'.padEnd(W),
  '-'.repeat(W),
  'Customer:'.padEnd(W),
  'CHRISTOPHER-ALEXANDER MCWHINNEY'.slice(0, W).padEnd(W),
  'Acct: WCN-10122'.padEnd(W),
  '-'.repeat(W),
  ('Monthly service' + '4,500.00'.padStart(W - 15)),
  ('Previous balance' + '9,000.00'.padStart(W - 16)),
  ('Amount paid' + '13,500.00'.padStart(W - 11)),
  ('Balance' + '0.00'.padStart(W - 7)),
  '='.repeat(W),
  'Paid by: Cash   Agent: J. Cole'.padEnd(W),
  'Thank you for your business'.padEnd(W),
  'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM',
]
// html and body carry what app/layout.tsx gives them, and the shell its
// `min-h-screen` — the three things that could hold a page open.
const html = `<!doctype html><html class="h-full antialiased"><head><meta charset="utf-8"><style>${css}</style></head>
<body class="min-h-full flex flex-col">
<div class="min-h-screen bg-gray-950"><aside class="fixed w-64"></aside><main class="ml-64 pt-16"><div class="p-6">
<table><tbody><tr><td class="px-4 py-2.5"><div class="overflow-x-auto">
<div class="receipt-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog">
<div class="max-h-full w-full max-w-sm overflow-y-auto rounded-xl border border-gray-800 bg-gray-900 shadow-2xl">
<div class="p-5"><div class="overflow-x-auto rounded-lg bg-white p-4">
<style>${receiptPageCss(lines.length)}</style>
<pre class="receipt-print whitespace-pre font-mono text-[13px] leading-[1.45] text-black">${lines.join('\n')}</pre>
</div></div></div></div></div></td></tr></tbody></table></div></main></div></body></html>`
const fixture = OUT + '/fixture.html'
writeFileSync(fixture, html)

// --- 3. print ---------------------------------------------------------------------
const browsers = {
  chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
}
for (const [name, exe] of Object.entries(browsers)) {
  const pdf = OUT + '/' + name + '.pdf'
  execFileSync(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + OUT + '/profile-' + name,
    '--no-pdf-header-footer', '--print-to-pdf=' + pdf, 'file:///' + fixture,
  ], { stdio: 'ignore', timeout: 60_000 })
  report(name, readFileSync(pdf))
}

if (failures.length) {
  for (const f of failures) console.error('FAIL ' + f)
  process.exit(1)
}
console.log('[' + label + '] page OK: one page, 80mm wide, ' + receiptPageHeightMm(lines.length).toFixed(1) + 'mm for ' + lines.length + ' lines')

// --- 4. read the PDF back ----------------------------------------------------------
function report(name, buf) {
  const raw = buf.toString('latin1')
  // Every Flate stream, inflated.
  const streams = []
  const re = /stream\r?\n/g
  let m
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    const bytes = Buffer.from(raw.slice(start, end), 'latin1')
    try { streams.push(inflateSync(bytes).toString('latin1')) } catch { streams.push(bytes.toString('latin1')) }
  }
  const fonts = [...new Set([...raw.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+,\-]+)/g)].map((x) => x[1].replace(/^[A-Z]{6}\+/, '')))]
  // MediaBox
  const mb = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(raw)
  const pageW = mb ? Number(mb[3]) - Number(mb[1]) : NaN
  const pageH = mb ? Number(mb[4]) - Number(mb[2]) : NaN

  // The page itself. Chrome snaps a page to whole CSS pixels, so the sizes are
  // compared to within a pixel (0.26mm) rather than exactly.
  const pages = (raw.match(/\/Type\s*\/Page(?!s)/g) ?? []).length
  const toMm = (pt) => (pt / 72) * 25.4
  const wantH = receiptPageHeightMm(lines.length)
  if (pages !== 1) failures.push(name + ': ' + pages + ' pages, expected 1')
  if (!(Math.abs(toMm(pageW) - 80) <= 0.3)) failures.push(name + ': page is ' + toMm(pageW).toFixed(2) + 'mm wide, expected 80')
  if (!(Math.abs(toMm(pageH) - wantH) <= 0.3)) failures.push(name + ': page is ' + toMm(pageH).toFixed(2) + 'mm tall, expected ' + wantH.toFixed(1))

  // Walk text: track Tm, Td, Tf, Tr, w and every Tj/TJ advance. Courier New
  // (either weight) advances 600/1000 em per glyph, which is what makes the
  // 32-column width reason-able at all.
  let minX = Infinity, maxX = -Infinity, size = 0, renderModes = new Set(), lineWidths = new Set()
  let tx = 0, ty = 0, lx = 0, ly = 0, glyphs = 0
  // Chrome and Edge write the content stream in CSS pixels and scale it to
  // points with a `cm` matrix (0.75, i.e. 72/96). Everything measured below is
  // multiplied through that, so the figures come out in real points.
  let scale = 1
  const ops = {}
  for (const s of streams) {
    const toks = s.match(/\[(?:[^\]]*)\]|\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f]+>|[^\s\[\]()<>]+/g) ?? []
    const st = []
    // Fresh graphics state per stream, with q/Q saving and restoring the scale.
    scale = 1
    const stack = []
    for (const t of toks) {
      if (/^[A-Za-z*'"]+$/.test(t)) ops[t] = (ops[t] || 0) + 1
      if (t === 'q') { stack.push(scale); st.length = 0; continue }
      if (t === 'Q') { scale = stack.pop() ?? 1; st.length = 0; continue }
      if (t === 'cm') { const a = Number(st.at(-6)); if (a > 0) scale *= a; st.length = 0; continue }
      if (t === 'Tf') { size = Number(st.at(-1)) * scale; st.length = 0; continue }
      if (t === 'Tm') { tx = lx = Number(st.at(-2)) * scale; ty = ly = Number(st.at(-1)) * scale; st.length = 0; continue }
      if (t === 'Td' || t === 'TD') { lx += Number(st.at(-2)) * scale; ly += Number(st.at(-1)) * scale; tx = lx; ty = ly; st.length = 0; continue }
      if (t === 'T*') { st.length = 0; continue }
      if (t === 'Tr') { renderModes.add(Number(st.at(-1))); st.length = 0; continue }
      if (t === 'w') { lineWidths.add(Number((Number(st.at(-1)) * scale).toFixed(3))); st.length = 0; continue }
      if (t === 'Tj' || t === 'TJ') {
        const arg = st.at(-1) ?? ''
        let n = 0, adj = 0
        if (t === 'Tj') n = glyphCount(arg)
        else for (const part of arg.slice(1, -1).match(/\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f]+>|-?[\d.]+/g) ?? []) {
          if (part.startsWith('(') || part.startsWith('<')) n += glyphCount(part)
          else adj += Number(part)
        }
        const width = n * 0.6 * size - (adj / 1000) * size
        if (n > 0) { minX = Math.min(minX, tx); maxX = Math.max(maxX, tx + width); glyphs += n }
        tx += width
        st.length = 0; continue
      }
      st.push(t)
    }
  }
  const mm = (pt) => (pt / 72 * 25.4).toFixed(2)
  console.log(
    '[' + label + '] ' + name.padEnd(7) +
    ' page ' + mm(pageW) + 'x' + mm(pageH) + 'mm' +
    '  font ' + fonts.join('+') +
    '  size ' + size.toFixed(2) + 'pt' +
    '  render mode ' + ([...renderModes].join(',') || '0 (fill only)') +
    '  stroke width ' + ([...lineWidths].filter((w) => w > 0).join(',') || 'none') +
    '  text ' + mm(minX) + 'mm to ' + mm(maxX) + 'mm' +
    '  glyphs ' + glyphs
  )
  const interesting = ['Tj', 'TJ', 'Tr', 'w', 'S', 's', 'f', 'f*', 'B', 'b', 'W', 'n', 'Do', 'q', 'cm', 'sh']
  console.log('          ops: ' + interesting.filter((k) => ops[k]).map((k) => k + '=' + ops[k]).join(' ') + '  streams=' + streams.length)
}
function glyphCount(lit) {
  if (lit.startsWith('<')) return (lit.length - 2) / 4 // 2-byte CIDs, as Chrome emits
  return lit.slice(1, -1).replace(/\\./g, 'x').length
}
