-- ISPMan: bill documents — three templates, the company's tax and payment
-- details, and an uploaded letterhead.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- Until it is applied the app behaves exactly as before it existed (see
-- lib/schema.ts#billDocuments): every bill uses the Statement template, the
-- tax line is omitted, the currency symbol comes from settings.currency, and
-- Settings > Bills and the letterhead upload say this migration is needed.
--
-- Deploy order: code, then this file. Either order is safe.
--
-- ---------------------------------------------------------------------------
-- 1. What a bill says about the company
-- ---------------------------------------------------------------------------
-- NOTHING HERE IS JAMAICA-SPECIFIC. The tax line's label ("GCT", "VAT",
-- "Sales tax"), its rate, the currency symbol and the tax ID's label are all
-- per company. The tax ID's LABEL is not added here: it is settings.tax_id_label
-- and settings.country from migration 0019, the same words the customer form
-- uses (lib/tax-id.ts#taxIdLabel). The RATE is not added either: it is
-- settings.tax_rate from migration 0007, which until now nothing read.
--
-- PRICES ARE TAX-INCLUSIVE. A plan's rate is what the customer pays. A
-- tax-registered company's bill backs the tax out of it (3,500 at 15% is
-- 3,043.48 + 456.52); it never adds tax on top. A company that is not
-- tax-registered gets no tax line at all, whatever tax_rate holds.

ALTER TABLE public.settings
  -- Which of the three layouts this company's bills use. See lib/bill/.
  ADD COLUMN IF NOT EXISTS bill_template TEXT NOT NULL DEFAULT 'statement',

  -- The registered business address printed on bills. NULL means "use
  -- companies.address", the contact address the letterhead already prints.
  ADD COLUMN IF NOT EXISTS registered_address TEXT,

  -- The company's own tax identifier and its tax registration number. Two
  -- columns because they are two numbers in most places that have either
  -- (Jamaica: a TRN and a GCT registration number).
  ADD COLUMN IF NOT EXISTS company_tax_id VARCHAR(40),
  ADD COLUMN IF NOT EXISTS tax_registration_number VARCHAR(40),

  -- Whether the bill shows a tax line. FALSE by default: a company that has
  -- never said it is registered must not start printing tax invoices because a
  -- rate was typed into the old Billing form.
  ADD COLUMN IF NOT EXISTS tax_registered BOOLEAN NOT NULL DEFAULT FALSE,

  -- The tax line's name. NULL prints "Tax".
  ADD COLUMN IF NOT EXISTS tax_label VARCHAR(24),

  -- What goes in front of an amount. NULL derives it from settings.currency
  -- (JMD -> J$; lib/format.ts#currencySymbol).
  ADD COLUMN IF NOT EXISTS currency_symbol VARCHAR(8),

  -- Free text for the "Bank transfer" column of the how-to-pay block.
  ADD COLUMN IF NOT EXISTS bank_details TEXT,

  -- The uploaded letterhead, in the company-assets bucket beside the logo.
  -- Timestamped path, written only by lib/data/brand.ts#storeLetterhead, the
  -- same new-object-then-pointer order as logo_path (migration 0023).
  ADD COLUMN IF NOT EXISTS letterhead_path TEXT;

ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_bill_template_check;
ALTER TABLE public.settings ADD CONSTRAINT settings_bill_template_check
  CHECK (bill_template IN ('statement', 'ledger', 'receipt'));

-- ---------------------------------------------------------------------------
-- 2. The bucket takes a letterhead
-- ---------------------------------------------------------------------------
-- A letterhead is stored at up to 2400 pixels wide so it prints sharply across
-- the page, which is several times the logo's size. Still PNG only: the PDF
-- writer passes PNG scanlines straight through (lib/letterhead-pdf.ts).
UPDATE storage.buckets
   SET file_size_limit = 2097152
 WHERE id = 'company-assets'
   AND (file_size_limit IS NULL OR file_size_limit < 2097152);
