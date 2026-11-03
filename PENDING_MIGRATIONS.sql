-- ISPMan: the migrations not yet applied, in order. Safe to run as one block.
-- Generated 2026-11-03 13:25.


-- ===========================================================================
-- 0045_field_technician_role.sql
-- ===========================================================================

-- A technician who also collects money.
--
-- Identical to 'technician' except that it may see a customer's billing
-- history and record a payment. It exists because removing technician from
-- those two on 21 Oct 2026 was right for a technician and wrong for the people
-- who do both jobs: install in the morning, take cash at the gate in the
-- afternoon.
--
-- A SEPARATE ROLE rather than giving the rights back to 'technician', because
-- that role is shared by every tenant on the platform. Ten technicians exist
-- across five companies, and widening the role would open customer balances
-- inside other operators' businesses without them asking for it. This way the
-- access is granted one person at a time.
--
-- WHY A MIGRATION IS NEEDED AT ALL: 0002_roles.sql put a CHECK constraint on
-- users.role listing the six roles by name. Without widening it, saving a user
-- as 'field_technician' fails in the database, whatever the app allows.
--
-- The role list in the app is lib/permissions.ts. Keep the two in step.

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users ADD CONSTRAINT users_role_check
  CHECK (role IN (
    'super_admin',
    'company_admin',
    'manager',
    'csr',
    'cashier',
    'technician',
    'field_technician'
  ));

-- NOTHING IS MIGRATED ONTO THE NEW ROLE. Every existing technician stays a
-- technician: who collects money is a decision per person, made in the app by
-- whoever runs that company, not something a migration should decide for five
-- tenants at once.

-- Verify afterwards:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.users'::regclass AND contype = 'c';
--   -> the list above, including field_technician

-- ===========================================================================
-- 0046_leads.sql
-- ===========================================================================

-- Door-to-door sales: prospects, and the reps who sign them up.
--
-- WHY A TABLE OF ITS OWN AND NOT A FLAG ON customers.
--
-- A prospect is somebody who answered the door. They have no service, no MAC
-- and, usually, no intention yet. Put them in `customers` and the billing
-- engine starts charging them a monthly rate for service they do not have,
-- they are counted in every customer total on every dashboard, and they
-- receive the next bulk text the company sends. Each of those would then need
-- a "but not the prospects" clause, forever, in code nobody remembers to
-- change. Keeping them apart means the subscriber book stays a book of
-- subscribers.
--
-- A prospect who BUYS becomes a real customer immediately â€” see the note on
-- customer_id below.

CREATE TABLE IF NOT EXISTS public.leads (
  id            BIGSERIAL PRIMARY KEY,
  company_id    BIGINT NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100) NOT NULL,
  phone         VARCHAR(40)  NOT NULL,
  address       TEXT         NOT NULL,

  -- WHERE THE REP WAS STANDING, from the phone's own GPS. The address a rep
  -- types at a gate is often "blue house past the shop" â€” accurate enough for
  -- a human, useless to an installer who has never been there. The fix is a
  -- coordinate.
  --
  -- NUMERIC(9,6) is about 10cm of precision, far finer than any phone, and
  -- avoids float drift on a value that is only ever displayed or handed to a
  -- map. Nullable throughout: GPS fails indoors, under trees, and whenever the
  -- rep declines the browser prompt, and none of that is a reason to lose the
  -- sale.
  latitude      NUMERIC(9,6),
  longitude     NUMERIC(9,6),
  -- The radius the phone claims, in metres. STORED BECAUSE A COORDINATE
  -- WITHOUT IT LIES: a 2,000m fix from a cell tower and a 5m fix from GPS look
  -- identical on a map, and only one of them will find the house.
  gps_accuracy_m NUMERIC(8,1),
  gps_taken_at  TIMESTAMPTZ,

  -- What the rep quoted for the installation. Typed by the rep (owner, 3 Nov
  -- 2026) rather than fixed by a price list.
  install_fee   NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- The monthly rate they were sold, when the rep quoted one. Carried onto the
  -- customer at conversion so nobody has to remember what was promised.
  monthly_rate  NUMERIC(12,2),
  service_plan_id BIGINT REFERENCES public.service_plans(id) ON DELETE SET NULL,

  notes         TEXT,

  -- new  â€” knocked, interested, nothing agreed
  -- won  â€” bought; customer_id is set
  -- lost â€” not interested, or could not be served
  status        VARCHAR(20) NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'won', 'lost')),
  lost_reason   TEXT,

  -- WHO SOLD IT. The rep's user row, plus their name as it stood that day:
  -- the same reason payments stamp an agent string rather than joining one.
  -- A rep who leaves the company must not take their sales history with them.
  created_by    BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  agent         VARCHAR(120),

  -- THE CUSTOMER THIS BECAME, once it is won.
  --
  -- Set the moment a prospect buys, which is also when money may be taken from
  -- them. A customer with no MAC resolves to 'unprovisioned', and the billing
  -- engine skips that verdict (lib/billing-engine.ts), so creating the row
  -- early does NOT start their monthly billing â€” that begins when somebody
  -- puts them on the network. Meanwhile the installation money sits in the
  -- payments book and in the collector's checkoff on the day it was handed
  -- over, which is the only way it can be accounted for at all.
  customer_id   BIGINT REFERENCES public.customers(id) ON DELETE SET NULL,
  converted_at  TIMESTAMPTZ,
  converted_by  BIGINT REFERENCES public.users(id) ON DELETE SET NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The office list: this company's prospects, newest first, filtered by status.
CREATE INDEX IF NOT EXISTS leads_company_status_idx
  ON public.leads (company_id, status, created_at DESC);

-- A rep's own list â€” the only list they are shown.
CREATE INDEX IF NOT EXISTS leads_company_rep_idx
  ON public.leads (company_id, created_by, created_at DESC);

-- Finding a prospect again by the number they gave at the door, and catching
-- the same house being signed up twice by two reps.
CREATE INDEX IF NOT EXISTS leads_company_phone_idx
  ON public.leads (company_id, phone);

COMMENT ON TABLE public.leads IS
  'Door-to-door prospects. NOT customers: no service, and never seen by the billing engine. A prospect who buys gets a customers row and is linked here by customer_id.';

-- ---------------------------------------------------------------------------
-- The sales rep role.
-- ---------------------------------------------------------------------------
--
-- Rewritten in full rather than added to, because this constraint is the one
-- list of roles the database will accept. It includes field_technician from
-- 0045 â€” run that first, or this replaces it anyway and both are present.
--
-- A sales rep sees their own prospects and nothing else: no customer book, no
-- payments screen, no tickets, no network. The app's list is lib/permissions.ts
-- and the two must agree.

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users ADD CONSTRAINT users_role_check
  CHECK (role IN (
    'super_admin',
    'company_admin',
    'manager',
    'csr',
    'cashier',
    'technician',
    'field_technician',
    'sales_rep'
  ));

-- Verify afterwards:
--   SELECT count(*) FROM leads;                       -> 0, the table exists
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.users'::regclass AND contype = 'c';
--   -> the eight roles above
