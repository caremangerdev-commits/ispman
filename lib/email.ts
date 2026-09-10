/**
 * The one definition of what this app accepts as an email address.
 *
 * There is no second copy. `app/actions/users.ts`, `app/actions/platform.ts`
 * and `app/actions/customers.ts` each held their own, and they had already
 * drifted apart in strictness — the same way the two log-detail parsers did
 * before `lib/log-detail.ts`, and the three customer searches did before
 * `lib/search.ts`. If a new form needs to accept an email, import this.
 *
 * WHAT CHANGED AND WHY
 *   The old pattern was /^[^\s@]+@[^\s@]+\.[^\s@]+$/ — a top-level domain of
 *   "anything non-empty". It accepted "renardosmith364@gmail.com1", which is
 *   how a legacy staff account reached the migration with an address that can
 *   never receive mail. A staff account is a login AND the only channel for a
 *   password reset, so an address that silently fails to deliver is worse than
 *   a rejected one.
 *
 *   The last label must now be letters. That is the whole of the change: every
 *   real TLD is letters, and a trailing digit is the specific typo seen.
 *
 * DELIBERATELY NOT RFC 5322. That grammar permits quoted local parts, comments
 * and bracketed IP literals, none of which anyone types into a customer form,
 * and matching it in full would accept far more than it rejects. This is the
 * conservative reading: no whitespace, no @ in either half, dot-separated
 * domain labels that are each non-empty, and an alphabetic TLD.
 */

/**
 * Local part, then one or more non-empty dot-separated labels, then a TLD of
 * letters only. The label class excludes "." as well as "@" and whitespace, so
 * "a@b..com" and "a@b.com." are both rejected rather than being read as a
 * label that happens to be empty.
 */
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[A-Za-z]{2,63}$/

/**
 * Whether `value` is an address this app will accept.
 *
 * Trims first, so a pasted address with a trailing space is judged on what it
 * actually says. Callers that store the value should store their own trimmed
 * copy — this deliberately does not hand one back, so it cannot be mistaken
 * for a normaliser.
 */
export function isEmail(value: string | null | undefined): boolean {
  return EMAIL.test(String(value ?? '').trim())
}
