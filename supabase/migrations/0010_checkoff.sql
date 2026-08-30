-- ISPMan: payment checkoff system.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- Until it is applied, the Checkoff page and the "My Collections" panel on
-- /dashboard/payments/new report themselves as unavailable rather than
-- crashing (see lib/schema.ts#checkoff). Recording a payment keeps working
-- throughout; it simply does not record a method or an agent id.

-- ---------------------------------------------------------------------------
-- Checkoff tracking on payments
-- ---------------------------------------------------------------------------
ALTER TABLE payments ADD COLUMN IF NOT EXISTS
  checked_off BOOLEAN DEFAULT FALSE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS
  checked_off_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS
  checked_off_by BIGINT REFERENCES users(id);

-- A DEFAULT does not apply to rows that already exist, so backfill explicitly.
-- Without this, every historical payment has checked_off = NULL, and
-- `.eq('checked_off', false)` would not match them.
UPDATE payments SET checked_off = FALSE WHERE checked_off IS NULL;
ALTER TABLE payments ALTER COLUMN checked_off SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Payment method
-- ---------------------------------------------------------------------------
-- NOTE: `payments.payment_type` already exists and holds cash/card/online.
-- This adds the wider list (bank transfer, cheque, PayPal, ...) as a separate
-- column rather than widening the old one, because existing rows and existing
-- reads depend on payment_type. Both are written on insert and the UI prefers
-- payment_method, falling back to payment_type for historical rows.
--
-- Worth consolidating onto one column later; see the report accompanying this
-- migration.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS
  payment_method VARCHAR(50) DEFAULT 'cash';

-- Backfill so historical rows show a method rather than an empty badge.
UPDATE payments SET payment_method = payment_type
 WHERE payment_method IS NULL AND payment_type IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Agent identity on payments
-- ---------------------------------------------------------------------------
-- ADDITION BEYOND THE SUPPLIED SQL, and it is required.
--
-- The "My Collections" panel and the per-agent checkoff both have to answer
-- "which payments did THIS user take?". `payments.agent` is a free-text name
-- that the cashier can edit on the form, so it cannot answer that reliably:
-- two staff can share a name, and an edited value silently detaches the row
-- from its collector. This stores the actual user id.
--
-- Historical rows stay NULL and are matched by agent name as a fallback.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS
  user_id BIGINT REFERENCES users(id);

-- ---------------------------------------------------------------------------
-- Checkoff records
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS checkoff_records (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  agent_id BIGINT REFERENCES users(id),
  agent_name VARCHAR(255),
  checked_off_by BIGINT REFERENCES users(id),
  system_total DECIMAL(10,2) NOT NULL DEFAULT 0,
  amount_received DECIMAL(10,2),
  discrepancy DECIMAL(10,2),
  customers_count INT DEFAULT 0,
  is_all_agents BOOLEAN DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- The collections panel and checkoff both filter payments by company + agent +
-- checked_off on every page load; without this they sequentially scan.
CREATE INDEX IF NOT EXISTS payments_checkoff_idx
  ON payments (company_id, user_id, checked_off);

CREATE INDEX IF NOT EXISTS checkoff_records_company_idx
  ON checkoff_records (company_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE checkoff_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checkoff_records_company ON checkoff_records;
CREATE POLICY checkoff_records_company
  ON checkoff_records FOR ALL TO authenticated
  USING (company_id = current_company_id())
  WITH CHECK (company_id = current_company_id());

-- Verify afterwards — all four should return rows:
--
--   SELECT checked_off, checked_off_at, checked_off_by, payment_method, user_id
--     FROM payments LIMIT 1;
--   SELECT * FROM checkoff_records LIMIT 1;
