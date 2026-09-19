import { NextResponse } from 'next/server'

import { brandFor } from '@/lib/data/brand'
import { letterheadSampleFilename, letterheadSamplePdf } from '@/lib/letterhead-pdf'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'

/**
 * A sample page on the company's letterhead, as a PDF.
 *
 * THE LETTERHEAD'S FIRST REAL CALLER. Bills are what it was built for, but a
 * function with no caller is a function nobody has watched work; this serves
 * the same letterhead() a bill will, from the same brandFor(), so the company
 * admin who uploads a logo sees it on paper straight away — and so does
 * whoever changes lib/letterhead-pdf.ts.
 *
 * Gated like the settings page it is linked from. The check stands on its own:
 * a hidden link is not access control.
 */
export async function GET() {
  const { company, profile } = await getSession()

  if (!can(profile.role, 'manage_company_settings')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const pdf = letterheadSamplePdf(await brandFor(company.id))

  return new NextResponse(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="' + letterheadSampleFilename() + '"',
      // The brand changes; a cached sample would show the logo before last.
      'Cache-Control': 'no-store',
    },
  })
}
