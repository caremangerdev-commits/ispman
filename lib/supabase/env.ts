/**
 * Centralised access to the public Supabase environment variables.
 *
 * Reading these through a helper (instead of `process.env.X!`) means a missing
 * variable fails with an actionable message at the call site rather than a bare
 * "supabaseUrl is required" thrown from deep inside supabase-js.
 *
 * NOTE: these must be referenced as full literal `process.env.NEXT_PUBLIC_*`
 * expressions so the Next.js bundler can statically inline them into the
 * client bundle. Do not refactor to dynamic lookups.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Add it to .env.local — see .env.example.`
    )
  }
  return value
}

export function supabaseUrl(): string {
  return required('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL)
}

export function supabaseAnonKey(): string {
  return required('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
}
