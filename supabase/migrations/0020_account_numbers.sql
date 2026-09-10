-- ISPMan: a real account number for every customer.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- NOT YET APPLIED. lib/schema.ts probes for the column; until it exists the app
-- keeps identifying customers the way it does now, by name and by #id.
--
-- WHY THIS EXISTS
-- One company has 979 customers with names that collide — KEISHA BROWN twice,
-- CARL THOMAS twice, NATOYA WRAY CHRISTIE twice, and many more that are similar
-- without being identical. Staff have no way to tell two of them apart at a
-- counter, and three places in the app have been working around the absence:
-- lib/search.ts matches on the row id because there is nothing better,
-- lib/data/receipts.ts omits the receipt's Account line entirely with a note
-- saying to populate it "the day such a column exists", and the customer list
-- shows a name and hopes.
--
-- The row id is not an account number. It is global across tenants and
-- interleaved — this database has Ezmze holding ids 388-2062 and West Central
-- holding 1722-2061, straight through each other — so it leaks the platform's
-- size, gives two companies wildly different-looking numbers, and cannot be
-- read out over a phone.

-- ---------------------------------------------------------------------------
-- customers.account_number — the number the customer is told to quote.
--
-- THE RENDERED STRING, NOT A BARE COUNTER. It is stored exactly as it is
-- printed, spoken and searched: "000123", or "EZM-000123" where a company sets
-- a prefix. Storing only the sequence and rendering the prefix at read time
-- would mean changing the prefix RETROACTIVELY RENAMES EVERY ACCOUNT, including
-- the ones already printed on receipts and written in customers' notebooks.
-- That is the same mistake 0018 exists to prevent: what was issued is a fact,
-- not something to recompute from current settings.
--
-- 32 characters, which holds a generous prefix plus six digits and leaves room
-- for a company migrating in from a system with longer numbers.
-- ---------------------------------------------------------------------------
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS account_number VARCHAR(32);

-- ---------------------------------------------------------------------------
-- BACKFILL — every existing customer gets one, ordered by id within each
-- company.
--
-- ORDERED BY id, NOT BY date_added, and that is a decision this database
-- forces. Ezmze's 979 customers all carry a date_added between 2026-09-01 and
-- 2026-09-10 because they arrived in one import, so date_added cannot order
-- them at all; West Central has 6 rows with no date_added whatsoever. id is the
-- only key every row has, it never ties, and it approximates the order the rows
-- were created — which is the closest thing to "the order they joined" that
-- actually exists here.
--
-- PARTITIONED BY company_id, because ids interleave between tenants. Numbering
-- straight off the id would give Ezmze's first customer 388 and West Central's
-- 1722, which is neither company's account number one.
--
-- Six digits: 979 customers today, room to 999,999 before the format changes.
--
-- Idempotent — only rows with no number are touched — so re-running this after
-- a partial failure completes the job rather than renumbering anybody. An
-- account number, once issued, is never reissued.
-- ---------------------------------------------------------------------------
WITH numbered AS (
  SELECT
    id,
    LPAD(
      (ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY id))::text,
      6, '0'
    ) AS assigned
  FROM public.customers
  WHERE account_number IS NULL
)
UPDATE public.customers AS c
SET account_number = n.assigned
FROM numbered AS n
WHERE c.id = n.id
  AND c.account_number IS NULL;

-- ---------------------------------------------------------------------------
-- UNIQUE PER COMPANY, NOT GLOBALLY.
--
-- Two ISPs both having account 000001 is correct: every read in this app is
-- company scoped by RLS (0001), so the pair (company_id, account_number) is the
-- only thing that has to identify a row. Global uniqueness would force one
-- tenant's numbering to depend on another's, leak how many customers the
-- platform has in total, and mean the first customer of the fiftieth company
-- gets an account number in the hundreds of thousands.
--
-- This constraint is also the backstop for the allocator below: if two
-- concurrent signups ever reach for the same number, the second INSERT fails
-- loudly instead of quietly issuing a duplicate.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS customers_account_number_key
  ON public.customers (company_id, account_number)
  WHERE account_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- account_counters — the next number to issue, per company.
--
-- A ROW PER COMPANY RATHER THAN max(account_number) + 1, because the maximum
-- cannot be trusted to be a number. A company migrating in from another system
-- keeps its existing account numbers on import, and those may be "A-4471" or
-- "OLD/22/3" or anything else; parsing them back into an integer to find the
-- next one would either crash or, worse, quietly reissue a number that is
-- already on somebody's receipt.
--
-- ALLOCATION IS ONE STATEMENT AND IS THEREFORE ATOMIC:
--
--   UPDATE public.account_counters
--      SET next_value = next_value + 1
--    WHERE company_id = $1
--   RETURNING next_value - 1 AS issued;
--
-- Two concurrent signups serialise on the row lock and get different numbers.
-- A read-then-write in application code would not, and the failure mode there
-- is two customers sharing an account number — which the unique index above
-- would at least catch, but only after one of the two signups had already
-- failed in front of an operator.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_counters (
  company_id BIGINT PRIMARY KEY
    REFERENCES public.companies (id) ON DELETE CASCADE,
  -- The next number to hand out, as an integer. The prefix and the padding are
  -- applied when the string is built; only the counting lives here.
  next_value INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seeded PAST the backfill, so the first customer added after this migration
-- continues the sequence instead of colliding with an existing account number.
-- A company with no customers starts at 1.
INSERT INTO public.account_counters (company_id, next_value)
SELECT c.id, COALESCE(MAX(cu.id_rank), 0) + 1
FROM public.companies AS c
LEFT JOIN (
  SELECT company_id, ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY id) AS id_rank
  FROM public.customers
) AS cu ON cu.company_id = c.id
GROUP BY c.id
ON CONFLICT (company_id) DO NOTHING;

-- Same tenant isolation as every other table here — see 0001. The counter is
-- read and written only by the server, but it is company data and is scoped
-- like company data.
ALTER TABLE public.account_counters ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- settings.account_number_prefix — optional, and empty for almost everyone.
--
-- NULL or '' means the number stands alone: "000123". A company that runs two
-- brands, or that wants its account numbers to be obviously theirs when a
-- customer reads one out, sets a short prefix and gets "EZM-000123".
--
-- CHANGING IT DOES NOT RENAME ANYTHING. Existing account numbers are stored
-- whole and are left exactly as issued; the prefix applies to numbers issued
-- from that point on. That is deliberate, and it is why the rendered string is
-- the stored value — see the note on customers.account_number above.
-- ---------------------------------------------------------------------------
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS account_number_prefix VARCHAR(8);

-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION IS NOT
--
-- It does not make account_number NOT NULL. A column that cannot be null is a
-- column that fails an INSERT the moment any write path forgets it, and there
-- are several — the importer, the new-customer form, the seed script. The
-- allocator fills it; the unique index keeps it honest; a row that somehow
-- arrives without one is visible and fixable rather than a failed signup in
-- front of a customer.
--
-- It does not renumber anybody, ever. The backfill only touches rows where the
-- column is null, and nothing else in this file writes to it.
-- ---------------------------------------------------------------------------
