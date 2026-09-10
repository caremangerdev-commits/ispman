-- ISPMan: a generic tax identifier on customers, named per company.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- NOT YET APPLIED. lib/schema.ts probes for these columns and the field stays
-- hidden until they exist, so applying this adds a field rather than changing
-- anything already on screen.
--
-- WHY THE COLUMN IS GENERIC AND THE LABEL IS NOT
-- In Jamaica this number is the TRN. The same platform is aimed at the US,
-- where it is an EIN for a business and an SSN for a person, and at the wider
-- Caribbean, where it is a BIR number, a TIN, or something else again. A column
-- called `trn` would be wrong in every market but one, and a column per country
-- would multiply with the customer base. So the STORAGE is one nameless string
-- and only the WORD for it varies.

-- ---------------------------------------------------------------------------
-- customers.tax_id — whatever the local revenue authority calls its number.
--
-- STORED AS TYPED. TRNs are written 123-456-789, an EIN 12-3456789, an SSN
-- 123-45-6789: the separators are part of how people read them back, and
-- stripping them would make the field print differently from the card the
-- customer is holding. Nothing in the app parses this value, so there is
-- nothing that benefits from normalising it.
--
-- NO FORMAT CONSTRAINT, DELIBERATELY. A CHECK here would encode one country's
-- rules into a column shared by all of them, and would reject a legitimate
-- number the day a company signs up from a country nobody thought about. The
-- app validates only when settings.country says which rules apply, and accepts
-- anything otherwise — see the note on that column below.
--
-- NOT UNIQUE, ALSO DELIBERATELY. A household can hold one number across several
-- service addresses, a landlord can hold one across several tenants' accounts,
-- and a business can be billed twice under one EIN. A UNIQUE constraint here
-- would block the operator from recording what is true, and the app has no
-- feature that depends on the number being distinct.
--
-- 40 characters: comfortably past the longest national format in use, without
-- being an invitation to paste something else into the field.
-- ---------------------------------------------------------------------------
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS tax_id VARCHAR(40);

-- Looked up when an operator searches by it. Company first because every read
-- of this table is company scoped (RLS, 0001), and partial because the large
-- majority of rows will never carry one.
CREATE INDEX IF NOT EXISTS customers_tax_id_idx
  ON public.customers (company_id, tax_id)
  WHERE tax_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- settings.country — the ISO 3166-1 alpha-2 code, or NULL for "not stated".
--
-- THIS IS WHAT MAKES VALIDATION SAFE TO ADD. The rule is that no country's
-- format is enforced until the company has said which country it is in, and
-- that rule cannot be expressed unless the country is recorded somewhere. NULL
-- is therefore a real and permanent answer, not a value waiting to be filled
-- in: a company that never states its country keeps a tax_id field that accepts
-- anything, for good.
--
-- It is also what the LABEL is derived from, so setting the country once names
-- the field correctly instead of asking the operator to type "TRN" themselves.
--
-- CHECK is on the SHAPE, not on a list of countries. A closed list would need a
-- migration every time the platform reached a new market, which is the failure
-- this whole file is arranged to avoid.
-- ---------------------------------------------------------------------------
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS country CHAR(2);

ALTER TABLE public.settings
  DROP CONSTRAINT IF EXISTS settings_country_shape;

ALTER TABLE public.settings
  ADD CONSTRAINT settings_country_shape
  CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');

-- ---------------------------------------------------------------------------
-- settings.tax_id_label — an override for what the field is called.
--
-- NULL MEANS "USE THE ONE FOR MY COUNTRY", which is the normal case: a Jamaican
-- company gets "TRN" and a US one gets "Tax ID (EIN/SSN)" without anybody
-- typing anything. The override exists for the cases a country code cannot
-- answer — a company that bills across a border, one that wants "VAT number",
-- one whose staff have always called it something else.
--
-- Resolution order, and the app must not invent a fourth step:
--   1. tax_id_label, when set
--   2. the label for `country`, when country is set
--   3. "Tax ID"
--
-- STORED, NOT DERIVED-ONLY, for the same reason 0018 stamps a segment: a label
-- someone chose is a decision, and re-deriving it later from a country that has
-- since been corrected would silently rename the field under them.
-- ---------------------------------------------------------------------------
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS tax_id_label VARCHAR(40);

-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION IS NOT
--
-- It does not decide whether the number is PRINTED. An SSN on a receipt handed
-- across a counter is a different proposition from a TRN on a business invoice,
-- and that is a policy question for the app, not a column. lib/receipt.ts has
-- no field for it and this migration does not add one.
--
-- It also does not make the value safe to log. app/actions/customers.ts records
-- every edited field old-value-to-new in the customer_updated row; tax_id must
-- be treated the way pppoe_password already is — recorded as "(changed)" and
-- never by value — or applying this migration starts writing national
-- identifiers into the audit table. See lib/customer-changes.ts#REDACTED.
-- ---------------------------------------------------------------------------
