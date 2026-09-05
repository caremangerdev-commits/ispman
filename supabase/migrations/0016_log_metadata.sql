-- ISPMan: reportable columns on the activity log.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- NOT YET APPLIED. lib/audit.ts#logEvent probes for these columns and DROPS the
-- metadata (keeping the row, warning on the console) until they exist — see
-- lib/schema.ts#logMetadata — so applying this is what turns them on. Nothing
-- below drops or rewrites existing data, and every column is nullable, so every
-- row written before today stays exactly as it is.
--
-- WHY COLUMNS AND NOT MORE `details` TEXT
-- `log.details` already carries structured `| name=value` fields, and the
-- payment reversal written by app/actions/payments.ts#reversalDetails carries a
-- dozen of them. That is the right shape for the human account of what
-- happened, and the wrong shape for a question like "how much did we reverse
-- last quarter": answering it off `details` means a regex over a sentence that
-- any later edit is free to reword, run over every row in the table. These
-- three are the machine's copy of the facts most likely to be asked for in
-- aggregate. The prose stays; it stops being the only source.

-- ---------------------------------------------------------------------------
-- log.amount — the money a row is about.
--
-- SIGNED, AND SIGNED THE SAME WAY `amount_removed` IS IN `details`: positive
-- took money out of the books (a deleted payment, an edit revising an amount
-- down), negative put it back. That is what makes SUM(amount) over a period
-- the net movement rather than a total of unrelated magnitudes.
--
-- Deliberately NO non-negative CHECK, unlike payments.credit_applied in 0015.
-- A negative value here is not a bug, it is the other direction.
--
-- NULL means "this row is not about an amount", which is most of them — a
-- provision, a ticket, a login. NULL is not zero and must not be read as it:
-- rows written before this migration are about amounts nobody recorded here.
-- ---------------------------------------------------------------------------
ALTER TABLE public.log
  ADD COLUMN IF NOT EXISTS amount NUMERIC(10,2);

-- ---------------------------------------------------------------------------
-- log.correlation_id — ties the rows of one operator action together.
--
-- A correction is rarely one row. Reversing a payment writes one; correcting
-- the expiry that payment bought is a SEPARATE action that writes another, and
-- nothing in the log says the two belong to each other. Today the only way to
-- pair them is to guess from timestamps and hope nobody else was working.
--
-- TEXT rather than UUID so the writer can put a readable scheme in it if one
-- turns out to be wanted; the column does not care, and a wrong guess here is
-- expensive to undo once rows carry values.
--
-- Not unique: sharing the value is the entire point.
-- ---------------------------------------------------------------------------
ALTER TABLE public.log
  ADD COLUMN IF NOT EXISTS correlation_id TEXT;

-- Partial: the overwhelming majority of rows will never have one, and there is
-- no reason to index a column that is null for all of them. Company-scoped to
-- match how every read of this table is filtered (RLS, migration 0001).
CREATE INDEX IF NOT EXISTS log_correlation_idx
  ON public.log (company_id, correlation_id)
  WHERE correlation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- log.related_customer_id — the OTHER customer in an action involving two.
--
-- `customer_id` says whose record the row is filed against. A payment taken off
-- the wrong customer and put onto the right one is ONE action touching TWO
-- accounts, and at present the second is named only in prose, so it cannot be
-- found by querying.
--
-- BIGINT, not INT, to match customers.id and bills.customer_id (0014). An INT
-- referencing a BIGINT key is legal but mismatched, and mismatched types are
-- what stops a planner using the index on the other side of the join.
--
-- ON DELETE SET NULL IS LOAD-BEARING, NOT TIDINESS.
-- app/actions/customers.ts#deleteCustomer clears dependent rows by hand before
-- deleting a customer, and it clears `log` by `customer_id` ONLY. A row where
-- the deleted customer is the RELATED party is filed against somebody else, so
-- it is not in that sweep. Under the default NO ACTION the delete would fail
-- with a foreign key violation, and it would fail for a reason nobody would
-- connect to a payment reassignment done months earlier. SET NULL keeps the
-- audit row — which is about the other customer, and still true — and drops
-- only the pointer that no longer resolves. CASCADE would be worse than either:
-- it would delete an unrelated customer's audit history.
-- ---------------------------------------------------------------------------
ALTER TABLE public.log
  ADD COLUMN IF NOT EXISTS related_customer_id BIGINT;

ALTER TABLE public.log DROP CONSTRAINT IF EXISTS log_related_customer_id_fkey;
ALTER TABLE public.log
  ADD CONSTRAINT log_related_customer_id_fkey
  FOREIGN KEY (related_customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- AFTER APPLYING
--
-- Nothing passes these fields yet. logEvent accepts them (`amount`,
-- `correlationId`, `relatedCustomerId`) and writes them the moment this lands,
-- but no call site sets one, so applying this changes no behaviour on its own.
-- The callers come next:
--
--   - app/actions/payments.ts#updatePayment / #deletePayment already compute a
--     signed delta for `amount_removed`; pass the same number as `amount`.
--   - the expiry correction should share a `correlationId` with the reversal it
--     follows, which is what makes the pairing a join instead of a guess.
--   - the wrong-customer reassignment sequence is the caller for
--     `relatedCustomerId`. It stays a manual sequence for now.
-- ---------------------------------------------------------------------------
