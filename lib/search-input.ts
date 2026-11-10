/**
 * The one definition of a search box: how it behaves on a phone keyboard, and
 * what it looks like.
 *
 * WHY THIS EXISTS. Search is typed into on a phone, at a gate, by somebody
 * being talked at — and until now every search box in the app was spelled out
 * by hand, so each one had a different set of these attributes or none at all.
 * A box that fights the keyboard is worse than no box.
 */

/**
 * WHAT A PHONE KEYBOARD DOES TO A SEARCH BOX, AND HOW EACH OF THESE STOPS IT.
 *
 * autoCapitalize 'none'
 *   iOS and Android capitalise the first letter of a text field, and again
 *   after anything they read as the end of a sentence. Typing a name is fine;
 *   typing a MAC address, an email or an account number is not, and a query
 *   that silently becomes "Mich" matches nothing. 'none' is the modern value
 *   and 'off' is the legacy spelling of it; both are honoured, 'none' is the
 *   one in the spec.
 *
 * autoCorrect 'off' and spellCheck false
 *   Autocorrect rewrites a half-typed surname into a dictionary word — the
 *   single most common way a search for a real customer returns nothing. It is
 *   also what produces the "random deletion" people report: the keyboard
 *   replaces the whole word it thinks you are typing, so several characters
 *   vanish at once. Not a standard attribute pair, but honoured by every
 *   mobile browser that matters, and harmless where it is not.
 *
 * autoComplete 'off'
 *   Stops the browser offering the person's own name and address over the
 *   result list, which on a phone covers it completely.
 *
 * enterKeyHint 'search'
 *   Labels the keyboard's action key "Search" rather than "Go" or a newline,
 *   so the key does what the person expects and does not submit a surrounding
 *   form by accident.
 *
 * NOT inputMode 'search'
 *   It changes nothing about the keyboard and is widely unimplemented;
 *   type="search" already carries the meaning.
 */
export const SEARCH_INPUT_PROPS = {
  type: 'search' as const,
  autoComplete: 'off',
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
  enterKeyHint: 'search' as const,
}

/**
 * How a search box looks, everywhere.
 *
 * IT HAS TO BE FOUND BEFORE IT CAN BE TYPED INTO (owner, 10 Nov 2026). Every
 * search box was drawn in bg-gray-950 with a gray-800 border, which against
 * the gray-900 header and the gray-950 page behind it was very nearly
 * invisible — an outline on a background of the same tone. On the payment
 * screen, where somebody is standing at a counter with a customer waiting,
 * that is the one control they need to find first.
 *
 * So it is lighter than anything it sits on rather than darker. A gray-800
 * fill was the first attempt; the owner asked for white with grey text
 * (10 Nov 2026), which is the strongest version of the same idea — on a dark
 * app the one white rectangle on the screen cannot be missed, and it reads as
 * a control against the header, the page and a card alike without needing a
 * different class in each place.
 *
 * Grey text and not black: gray-800 on white is the full-contrast pairing
 * without the hard edge of pure black on pure white, and it leaves gray-500
 * below it for the placeholder, so a typed query still outweighs the hint.
 */
const base =
  'w-full rounded-lg border bg-white text-gray-800 placeholder:text-gray-500 ' +
  'outline-none transition border-gray-300 ' +
  'hover:border-gray-400 focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/40'

/** Header and filter bars: compact, with room for the icon on the left. */
export const SEARCH_INPUT_CLASS = base + ' py-2 pl-9 pr-8 text-sm'

/**
 * The till and anywhere else a search box is the main thing on screen.
 * text-base rather than text-sm on purpose: iOS zooms the whole page in when
 * a focused field's text is under 16px, and on the payment screen that zoom
 * lands with the field under the keyboard.
 */
export const SEARCH_INPUT_CLASS_LG = base + ' py-3 pl-12 pr-3 text-base'
