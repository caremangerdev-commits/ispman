/** Kinds of site, kept apart from lib/data/sites.ts so pages can use them. */
export const SITE_KINDS = [
  { kind: 'tower', label: 'Tower' },
  { kind: 'office', label: 'Office' },
  { kind: 'building', label: 'Building / rooftop' },
  { kind: 'cabinet', label: 'Cabinet / pole' },
  { kind: 'other', label: 'Other' },
] as const

export type SiteKind = (typeof SITE_KINDS)[number]['kind']

export function isSiteKind(v: string): v is SiteKind {
  return SITE_KINDS.some((k) => k.kind === v)
}

export function siteKindLabel(kind: string): string {
  return SITE_KINDS.find((k) => k.kind === kind)?.label ?? 'Other'
}
