<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Backslashes never go through the shell

**Any file content containing a backslash goes through the Write or Edit tool. Never a shell heredoc, `perl -pi`, `sed`, or `node -e`.**

That means every regex, every escape sequence, every Windows path in a string. If the content has a `\` in it, do not build it with a shell command.

## Why this is a hard rule and not a preference

Backslashes are eaten somewhere between the tool call and the file. It happened three times in a single session:

- `[^()\\]` became `[^()\]` in a PDF parser — caught immediately, the file would not parse.
- A `perl` replacement using `|` as its delimiter while the replacement text contained `|` corrupted the `Role` union and a props block — caught immediately by `tsc`.
- `new RegExp('\\| ' + name + '=…')` became `new RegExp('\| ' + name + '=…')` in a log parser. **This one reached production and took the customer detail page down with a 500.**

The third is the reason for the rule. The first two failed loudly. The third could not:

```js
new RegExp('\| ' + name + '=([^|]+)')
```

`'\|'` is not an escaped pipe. It is an unrecognised escape, so JavaScript silently drops the backslash and the pattern becomes the **alternation** `| name=(...)`. Its left branch is empty, so it matches at position 0 of every string ever passed in. `m` is always truthy, `m[1]` is always `undefined`, and `m[1].trim()` throws on every row.

**`tsc` cannot catch it. `eslint` cannot catch it.** `'\| '` is a perfectly valid string literal. The type checker is not a safety net here, which is exactly why the tooling choice has to be.

## The related rule

A regex written twice is a regex that will differ. `lib/format.ts` held the correct `'\\| '` while `components/customers/ChangeHistory.tsx` held the broken `'\| '` — two parsers reading the same rows, disagreeing, one of them fatal. Both now come from `lib/log-detail.ts`, the single definition of the `log.details` wire format, the way `lib/search.ts` is the single definition of customer matching.

If you find yourself writing a second parser for a format that already has one, collapse them instead.
