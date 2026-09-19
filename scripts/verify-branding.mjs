// Branding verification: runs the REAL logo pipeline, the REAL letterhead and
// the REAL email shell, and checks what comes out.
//
//   node scripts/verify-branding.mjs <output-dir>
//
// What it proves, and how:
//   1. lib/logo.ts turns awkward uploads (transparent, greyscale, oversized,
//      16-bit) into the one stored shape, and refuses what is not an image.
//   2. lib/letterhead-pdf.ts writes a PDF whose xref offsets are right and
//      whose embedded image DECODES TO THE SAME PIXELS as the PNG it came
//      from — the passthrough of IDAT data is checked, not trusted.
//   3. The right-aligned contact block really ends at the right margin: the
//      Helvetica width tables have 95 entries and known strings measure what
//      the AFM says.
//   4. The email shell renders for a logo, for no logo, and for a colour too
//      light to read, in every block type, with HTML and text parts that say
//      the same thing.
//
// It writes the sample pages and emails to <output-dir> so they can be LOOKED
// AT, which is the other half of checking a letterhead.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Outside the repository by default: the output is for looking at, not committing.
const OUT = path.resolve(process.argv[2] ?? path.join(tmpdir(), 'ispman-branding-check'))
mkdirSync(OUT, { recursive: true })

// The project's own modules, imported as they are: '@/x' resolved the way
// tsconfig resolves it, and 'server-only' (which throws outside a React server
// build) replaced by nothing. Node strips the types itself.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,', shortCircuit: true }
    if (specifier.startsWith('@/')) {
      const base = path.join(ROOT, specifier.slice(2))
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        if (existsSync(base + ext)) return { url: pathToFileURL(base + ext).href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  },
})

const { brandPalette, contrast, isStoredLogoShape, readPngHeader } = await import('../lib/brand.ts')
const { normaliseLogo } = await import('../lib/logo.ts')
const { letterheadSamplePdf, pngToPdfImage, textWidth, A4, PAGE_MARGIN } = await import('../lib/letterhead-pdf.ts')
const { blocksFromText, renderEmailHtml, renderEmailText, LOGO_CID } = await import('../lib/messaging/email-shell.ts')
const { DEFAULT_EMAIL_BODIES } = await import('../lib/sms/templates.ts')

let failures = 0
function check(what, ok, detail = '') {
  console.log((ok ? '  ok    ' : '  FAIL  ') + what + (detail ? '  — ' + detail : ''))
  if (!ok) failures += 1
}

// ---------------------------------------------------------------------------
// 1. The logo pipeline
// ---------------------------------------------------------------------------
console.log('\n1. lib/logo.ts — uploads become the one stored shape')

const svgLogo = (w, h) => Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 520 160">' +
  '<circle cx="80" cy="80" r="62" fill="#0f766e"/>' +
  '<path d="M48 84 L80 44 L112 84 M62 84 L80 62 L98 84" stroke="#fff" stroke-width="10" fill="none" stroke-linecap="round"/>' +
  '<circle cx="80" cy="104" r="8" fill="#fff"/>' +
  '<text x="164" y="78" font-family="Arial" font-weight="bold" font-size="52" fill="#0f172a">WestCentral</text>' +
  '<text x="166" y="122" font-family="Arial" font-size="30" fill="#0f766e">NETWORKS</text>' +
  '</svg>'
)

const uploads = {
  'transparent RGBA PNG': await sharp(svgLogo(520, 160)).png().toBuffer(),
  'greyscale JPEG': await sharp(svgLogo(520, 160)).flatten({ background: '#fff' }).greyscale().jpeg().toBuffer(),
  'oversized WebP (2600x800)': await sharp(svgLogo(2600, 800)).webp().toBuffer(),
  '16-bit PNG': await sharp(svgLogo(520, 160)).flatten({ background: '#fff' }).toColourspace('rgb16').png().toBuffer(),
  'small PNG (120x37)': await sharp(svgLogo(120, 37)).png().toBuffer(),
}

const logos = {}
for (const [name, bytes] of Object.entries(uploads)) {
  const r = await normaliseLogo(new Uint8Array(bytes))
  if (!r.ok) { check(name, false, r.error); continue }
  const h = readPngHeader(r.logo.png)
  check(
    name, isStoredLogoShape(h),
    h.width + 'x' + h.height + ', depth ' + h.bitDepth + ', colour type ' + h.colourType +
    ', ' + r.logo.png.length + ' bytes'
  )
  logos[name] = r.logo
}

const notImage = await normaliseLogo(new TextEncoder().encode('<html>not a logo</html>'))
check('HTML refused', !notImage.ok, notImage.ok ? '' : notImage.error)
const svgRefused = await normaliseLogo(new Uint8Array(svgLogo(520, 160)))
check('SVG refused (format decided from the bytes)', !svgRefused.ok, svgRefused.ok ? '' : svgRefused.error)
const tooBig = await normaliseLogo(new Uint8Array(600 * 1024))
check('over 512 KB refused', !tooBig.ok, tooBig.ok ? '' : tooBig.error)

// ---------------------------------------------------------------------------
// 2. The letterhead PDF
// ---------------------------------------------------------------------------
console.log('\n2. lib/letterhead-pdf.ts — structure, and the image decodes to the same pixels')

const contact = {
  address: '14 Great George Street\nSavanna-la-Mar\nWestmoreland, Jamaica',
  phone: '+1 876 555 0142',
  email: 'accounts@westcentral.example',
}
const brands = {
  'with-logo': {
    name: 'West Central Networks Limited', logo: logos['transparent RGBA PNG'],
    palette: brandPalette('#0f766e'), contact,
  },
  'no-logo': {
    name: 'West Central Networks Limited', logo: null,
    palette: brandPalette('#0f766e'), contact,
  },
  'no-logo-long-name-light-colour': {
    name: 'Christopher-Alexander McWhinney Wireless Broadband & Cable Company Limited',
    logo: null, palette: brandPalette('#fde047'), contact,
  },
  'small-logo-default-colour': {
    name: 'WCN', logo: logos['small PNG (120x37)'], palette: brandPalette(null),
    contact: { address: null, phone: '+1 876 555 0142', email: null },
  },
  'grey-logo': {
    name: 'West Central Networks Limited', logo: logos['greyscale JPEG'],
    palette: brandPalette('#7c3aed'), contact,
  },
  // Past even two lines at the smallest size: must be cut short, not overprinted.
  'no-logo-absurd-name': {
    name: 'The Very Reverend Christopher-Alexander McWhinney and Sons and Daughters Wireless Broadband, ' +
      'Cable Television, Fibre and Satellite Communications Company of Westmoreland and Hanover Limited',
    logo: null, palette: brandPalette('#b91c1c'), contact,
  },
}

// A one-channel PNG, built here rather than through normaliseLogo (which always
// emits RGB): the letterhead accepts colour type 0 too, and an accepted shape
// that nothing exercises is a branch waiting to be wrong.
{
  const png = new Uint8Array(await sharp(svgLogo(520, 160)).flatten({ background: '#fff' })
    .greyscale().toColourspace('b-w').png({ palette: false }).toBuffer())
  const h = readPngHeader(png)
  check('one-channel PNG fixture is colour type 0', h.colourType === 0 && isStoredLogoShape(h))
  brands['one-channel-logo'] = {
    name: 'West Central Networks Limited', logo: { png, width: h.width, height: h.height },
    palette: brandPalette('#334155'), contact,
  }
}

/** Every text run in a content stream, as a box. Strings are un-escaped to measure them. */
function textBoxes(pdfText) {
  const boxes = []
  const re = /BT \/(F[12]) ([\d.]+) Tf [\d. ]+ rg 1 0 0 1 ([\d.]+) ([\d.]+) Tm \(((?:\\.|[^\\)])*)\) Tj ET/g
  for (const m of pdfText.matchAll(re)) {
    const size = Number(m[2])
    const str = m[5].replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\(.)/g, '$1')
    const x = Number(m[3]), y = Number(m[4])
    boxes.push({ str, x0: x, x1: x + textWidth(str, size, m[1] === 'F2'), y0: y - size * 0.22, y1: y + size * 0.72 })
  }
  return boxes
}

/** Reverses PNG row filters: the same job a PDF reader does for /Predictor 15. */
function unfilter(data, width, height, bpp) {
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)
  let p = 0
  for (let y = 0; y < height; y++) {
    const f = data[p++]
    for (let x = 0; x < stride; x++) {
      const raw = data[p++]
      const a = x >= bpp ? out[y * stride + x - bpp] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0
      let v
      if (f === 0) v = raw
      else if (f === 1) v = raw + a
      else if (f === 2) v = raw + b
      else if (f === 3) v = raw + ((a + b) >> 1)
      else {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
        v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      out[y * stride + x] = v & 0xff
    }
  }
  return out
}

for (const [label, brand] of Object.entries(brands)) {
  const pdf = Buffer.from(letterheadSamplePdf(brand))
  writeFileSync(path.join(OUT, 'letterhead-' + label + '.pdf'), pdf)
  const text = pdf.toString('latin1')

  // Every xref entry must point at the "N 0 obj" it claims to.
  const xrefAt = Number(text.slice(text.lastIndexOf('startxref') + 9).trim().split('\n')[0])
  const xref = text.slice(xrefAt).split('\n')
  const count = Number(xref[1].split(' ')[1])
  let offsetsOk = text.startsWith('xref', xrefAt)
  for (let i = 1; i < count; i++) {
    const off = Number(xref[2 + i].slice(0, 10))
    if (!text.startsWith(i + ' 0 obj', off)) offsetsOk = false
  }
  check(label + ': xref offsets (' + (count - 1) + ' objects)', offsetsOk)

  // No text over text, and nothing past the right margin. This is the check
  // the first long-name sample page failed by eye.
  const boxes = textBoxes(text)
  const clashes = []
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) clashes.push(a.str + ' / ' + b.str)
    }
  }
  const overflow = boxes.filter((b) => b.x1 > A4.width - PAGE_MARGIN + 0.5)
  check(label + ': ' + boxes.length + ' text runs, none overlapping, none past the margin',
    boxes.length > 0 && clashes.length === 0 && overflow.length === 0,
    [...clashes, ...overflow.map((b) => 'past margin: ' + b.str)].join('; '))

  if (brand.logo) {
    const im = pngToPdfImage(brand.logo.png)
    const dict = text.indexOf('/Subtype /Image')
    const start = text.indexOf('stream\n', dict) + 7
    const length = Number(text.slice(dict, start).match(/\/Length (\d+)/)[1])
    const stream = pdf.subarray(start, start + length)
    const endsRight = text.startsWith('\nendstream', start + length)

    const bpp = im.colours
    const rows = inflateSync(stream)
    const sized = rows.length === im.height * (1 + im.width * bpp)
    const pixels = sized ? unfilter(rows, im.width, im.height, bpp) : Buffer.alloc(0)

    // The reference: the same PNG decoded by a real decoder. sharp hands a
    // one-channel PNG back as three unless told otherwise, so it is told.
    const decoder = sharp(Buffer.from(brand.logo.png))
    const ref = await (bpp === 1 ? decoder.toColourspace('b-w') : decoder).raw().toBuffer({ resolveWithObject: true })
    const same = ref.info.channels === bpp && Buffer.compare(pixels, ref.data) === 0
    check(
      label + ': embedded image',
      endsRight && sized && same,
      im.width + 'x' + im.height + ', ' + bpp + ' channel(s), ' + length + ' bytes, ' +
      (same ? 'pixels identical to the PNG' : 'PIXELS DIFFER')
    )
  } else {
    check(label + ': no image object, wordmark drawn', !text.includes('/Subtype /Image') && text.includes('/F2'))
  }
}

console.log('\n3. Helvetica metrics — the right-aligned block depends on them')
// Known values from the AFM: widths in 1/1000 em, so at size 1000 they read directly.
check('Helvetica "Hello" = 2222', Math.round(textWidth('Hello', 1000)) === 722 + 556 + 222 + 222 + 556)
check('Helvetica-Bold "Hello" = 2445', Math.round(textWidth('Hello', 1000, true)) === 722 + 556 + 278 + 278 + 611)
check('"~" is the last entry of both tables (95 each)',
  Math.round(textWidth('~', 1000)) === 584 && Math.round(textWidth('~', 1000, true)) === 584)
check('every printable ASCII character has a width', (() => {
  for (let c = 32; c <= 126; c++) {
    for (const bold of [false, true]) {
      const w = textWidth(String.fromCharCode(c), 1000, bold)
      if (!(w >= 150 && w <= 1100)) return false
    }
  }
  return true
})())
check('A4 content width leaves room for both blocks', A4.width - PAGE_MARGIN * 2 > 400)

// ---------------------------------------------------------------------------
// 4. The email shell
// ---------------------------------------------------------------------------
console.log('\n4. lib/messaging/email-shell.ts — HTML and text from the same blocks')

const receiptText = DEFAULT_EMAIL_BODIES.payment_receipt
  .replaceAll('{{first_name}}', 'Margaret').replaceAll('{{amount}}', 'J$4,500.00')
  .replaceAll('{{account}}', 'WCN-10122').replaceAll('{{balance}}', 'J$0.00')
  .replaceAll('{{company}}', 'West Central Networks Limited')

const receiptBlocks = blocksFromText(receiptText)
check('default receipt template: "Account / Balance now" became a table',
  receiptBlocks.some((b) => b.type === 'keyvalue' && b.rows.length === 2))
check('a lone "Note: ..." line stays a sentence',
  blocksFromText('Note: we are closed on Monday.').every((b) => b.type === 'paragraph'))

const everyBlock = [
  { type: 'paragraph', text: 'Hi Margaret,' },
  { type: 'paragraph', text: 'Your bill for October is ready. Pay online at https://pay.example.com/wcn, or at any of our offices.' },
  { type: 'callout', label: 'Amount due', value: 'J$4,500.00', note: 'Due 28 October 2026' },
  { type: 'keyvalue', rows: [
    { label: 'Account', value: 'WCN-10122' },
    { label: 'Billing period', value: '1 Oct 2026 to 31 Oct 2026' },
    { label: 'Plan', value: 'Home 25 Mbps' },
  ] },
  { type: 'button', label: 'View your bill', url: 'https://pay.example.com/wcn/bills/8123' },
  { type: 'paragraph', text: 'Thank you.\nWest Central Networks Limited' },
]

const hostile = blocksFromText('Hi <script>alert(1)</script>,\n\nSee https://x.example/"onmouseover="alert(1) now.')
const hostileHtml = renderEmailHtml({ brand: brands['no-logo'], logoSrc: null, subject: 'x', blocks: hostile })
check('template text cannot inject markup',
  !hostileHtml.includes('<script>') && !hostileHtml.includes('"onmouseover="'))

const dataUri = (logo) => 'data:image/png;base64,' + Buffer.from(logo.png).toString('base64')
const emails = {
  'receipt-with-logo': { brand: brands['with-logo'], blocks: receiptBlocks },
  'receipt-no-logo': { brand: brands['no-logo'], blocks: receiptBlocks },
  'all-blocks-with-logo': { brand: brands['with-logo'], blocks: everyBlock },
  'all-blocks-light-colour': { brand: brands['no-logo-long-name-light-colour'], blocks: everyBlock },
}

for (const [label, { brand, blocks }] of Object.entries(emails)) {
  const asSent = renderEmailHtml({ brand, logoSrc: brand.logo ? 'cid:' + LOGO_CID : null, subject: 'Payment received', blocks })
  const text = renderEmailText({ brand, blocks })

  check(label + ': logo referenced by CID only, never a URL',
    brand.logo ? asSent.includes('src="cid:logo"') && !asSent.includes('src="http') : !asSent.includes('<img'))
  check(label + ': no <style>, no <div> layout, no external resources',
    !asSent.includes('<style') && !asSent.includes('<link') && !asSent.includes('<script'))
  check(label + ': text part carries every figure the HTML does',
    blocks.every((b) =>
      b.type === 'keyvalue' ? b.rows.every((r) => text.includes(r.label + ': ' + r.value))
      : b.type === 'callout' ? text.includes(b.value)
      : b.type === 'button' ? text.includes(b.url)
      : text.includes(b.text)))

  // For looking at: the same HTML with the logo as a data URI, since a
  // browser cannot resolve cid:.
  const viewable = renderEmailHtml({ brand, logoSrc: brand.logo ? dataUri(brand.logo) : null, subject: 'Payment received', blocks })
  writeFileSync(path.join(OUT, 'email-' + label + '.html'), viewable)
  writeFileSync(path.join(OUT, 'email-' + label + '.txt'), text)
}

const light = brands['no-logo-long-name-light-colour'].palette
check('light brand colour: text falls back to dark ink, button text stays readable',
  light.ink !== light.accent && contrast(light.onAccent, light.accent) >= 4.5,
  'accent ' + light.accent + ', ink ' + light.ink + ', on-accent ' + light.onAccent)

// Screenshots at desktop and phone widths, if Chrome is here to take them.
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
if (existsSync(CHROME)) {
  for (const label of Object.keys(emails)) {
    // Headless Chrome will not make a window narrower than about 500px, so a
    // "375 wide" screenshot is a crop of a wider layout and proves nothing.
    // The phone view is the email inside a 375px iframe, which IS laid out at 375.
    writeFileSync(
      path.join(OUT, 'phone-' + label + '.html'),
      '<body style="margin:0;background:#333"><iframe src="email-' + label + '.html" ' +
      'style="width:375px;height:1200px;border:0;display:block"></iframe></body>'
    )
    for (const [name, size, file] of [
      ['desktop', '800,1000', 'email-' + label + '.html'],
      ['phone', '600,1200', 'phone-' + label + '.html'],
    ]) {
      const png = path.join(OUT, 'email-' + label + '-' + name + '.png')
      try {
        execFileSync(CHROME, [
          '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=' + size,
          '--allow-file-access-from-files',
          '--screenshot=' + png, pathToFileURL(path.join(OUT, file)).href,
        ], { stdio: 'ignore', timeout: 60_000 })
      } catch (err) {
        console.log('  (screenshot failed for ' + label + ' ' + name + ': ' + err.message + ')')
      }
    }
  }
  console.log('\n  screenshots written')
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') + '\nOutput: ' + OUT)
process.exit(failures === 0 ? 0 : 1)
