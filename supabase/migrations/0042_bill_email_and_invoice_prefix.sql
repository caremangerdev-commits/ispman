-- 0042: staff may email a customer their bill (off by default per company),
-- and a company may put its own prefix on invoice numbers.
--
-- Apply in the Supabase dashboard (SQL Editor). Safe before or after the
-- deploy: until these columns exist the customer record offers no "Email bill",
-- invoices carry no prefix, and Settings > Bill Design shows both as not set up.
--
-- ---------------------------------------------------------------------------
-- notify_bill_enabled
--
-- ONE SWITCH, like the other messages added since 0037 (ticket replies,
-- outages): off until a company turns it on under Settings > Bill Design. The
-- email itself goes through the same path as every other notification — the
-- outbox, the email master switch, the customer's email opt-out, the
-- dispatcher — with the bill as a PDF attachment rendered at send time by the
-- same code that draws the portal's download and the staff "Bill (PDF)" link
-- (lib/bill/pdf.ts#billPdf), in the company's chosen template.
--
-- No route column: a bill goes by email only. An SMS cannot carry the
-- document, and a text saying "your bill is ready" with no bill is a call to
-- the office.
--
-- invoice_prefix
--
-- Put in front of every invoice number: "INV-" makes 001403-202610 read
-- INV-001403-202610. Invoices only — a receipt is numbered by its payment and
-- a statement of account by its date. Letters, digits and - / . only, ten at
-- most (lib/bill/settings.ts#normaliseInvoicePrefix); NULL for none, which is
-- every company until it sets one, so no number already issued changes.
-- ---------------------------------------------------------------------------

alter table public.settings
  add column if not exists notify_bill_enabled boolean not null default false,
  add column if not exists invoice_prefix varchar(10);
