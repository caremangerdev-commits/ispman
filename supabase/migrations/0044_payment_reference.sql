-- 0044: the reference a payment arrived with.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR. Safe before or after the deploy: the
-- code probes for the column (lib/schema.ts, `paymentReference`) and, without
-- it, the till shows no reference field and nothing reads one.
--
-- WHY (owner, 29 October 2026). A customer pays by bank transfer and sends in
-- the receipt. The cashier has the transfer's reference in their hand and
-- nowhere to put it, so it goes in the notes if it goes anywhere, and when the
-- bank statement is reconciled a week later there is no way to tie a line on
-- it to a payment in ISPMan except by amount and date — which is exactly the
-- pair that collides when two customers on the same plan pay on the same day.
--
-- NOT A BANK-TRANSFER COLUMN. A cheque number, a Zelle confirmation, a PayPal
-- transaction id and a card authorisation are the same thing wearing different
-- names: the number the other side of the payment knows it by. One column, and
-- the till labels it from the method chosen (lib/data/checkoff.ts).
--
-- 64 characters because the longest real ones are bank wire references in the
-- low thirties; this is room to spare, not an invitation to paste a paragraph.
-- Notes remain the place for a sentence.

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS reference VARCHAR(64);

-- Reconciling a statement means looking a reference up across a company, so it
-- is indexed for that, not for anything the customer page does. Partial: the
-- column is null on every cash payment, which is most of them, and an index
-- over those nulls would be mostly empty rows.
CREATE INDEX IF NOT EXISTS payments_company_reference_idx
  ON public.payments (company_id, reference)
  WHERE reference IS NOT NULL;

-- Verify afterwards:
--   SELECT reference FROM payments LIMIT 1;        -> the column exists
--   SELECT indexname FROM pg_indexes WHERE tablename = 'payments';
