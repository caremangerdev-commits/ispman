/**
 * Portal wording that both a page and a server action need to say.
 *
 * NOT IN app/actions/portal.ts, where it started. A file marked 'use server'
 * may export NOTHING but async functions — a plain const there is not a lint
 * nit, it fails the build and takes every importer of that module down with
 * it, which is exactly what happened on 26 October 2026. `tsc` does not check
 * this; only `next build` does.
 *
 * No 'use server' and no 'server-only' here on purpose: a client component
 * showing the same sentence must be able to import it too.
 */

/** Why the phone change is refused for an account-details session. */
export const NEEDS_SMS =
  'To change the number on this account, sign in with a code sent by text.'
