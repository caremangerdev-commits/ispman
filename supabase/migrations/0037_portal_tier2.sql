-- ISPMan: portal tier-2 — support-ticket threads, outage incidents, and the
-- two per-company SMS switches they need (both OFF by default).
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- Everything here is gated in code by the `portalTier2` capability
-- (lib/schema.ts): until this file is applied, the portal's support and the
-- staff incidents UI hide themselves and nothing reads or writes these tables.

-- ---------------------------------------------------------------------------
-- ticket_messages — the back-and-forth on a support ticket.
--
-- support_tickets already exists (one row per ticket, with customer_id,
-- status, resolution_notes). It had no conversation, so a customer could not
-- open one from the portal and read staff replies. This adds the thread: one
-- row per message, from the customer or from staff, optionally with one photo
-- (a router's lights, a dish, a cut cable) stored in the company-assets bucket
-- under tickets/<ticket_id>/.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ticket_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  ticket_id BIGINT NOT NULL REFERENCES public.support_tickets (id) ON DELETE CASCADE,
  -- Who wrote it. 'customer' rows carry no user; 'staff' rows carry author_user_id.
  author VARCHAR(10) NOT NULL CHECK (author IN ('customer', 'staff')),
  author_user_id BIGINT,
  author_name TEXT,
  body TEXT,
  -- Storage path in the company-assets bucket, or null for a text-only message.
  photo_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ticket_messages_thread_idx
  ON public.ticket_messages (company_id, ticket_id, created_at);

-- Marks a ticket as opened by the customer from the portal, so the staff queue
-- can tell those apart from ones staff raised. Default keeps every existing row
-- as a staff ticket.
ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'staff';

-- ---------------------------------------------------------------------------
-- incidents — an outage or maintenance window the staff declare.
--
-- Scope decides who sees the portal banner and who gets the SMS: the whole
-- company, or one access point (customers.access_point — the AP/sector a
-- customer is on, the only location the schema stores reliably). A global
-- banner shown to unaffected customers generates calls, so scope is the point.
--
-- next_update_at is "we will say more by" rather than a promised fix time — a
-- missed restoration promise just makes a second call (docs/research/features.md).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incidents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  -- The customer-facing sentence shown on the banner and texted.
  message TEXT,
  scope VARCHAR(20) NOT NULL DEFAULT 'company' CHECK (scope IN ('company', 'access_point')),
  -- The access_point value when scope = 'access_point'; null for company-wide.
  scope_value TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'restored')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_at TIMESTAMPTZ,
  -- "Next update by" — shown on the banner instead of an ETR.
  next_update_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT,
  created_by_name TEXT
);

CREATE INDEX IF NOT EXISTS incidents_company_status_idx
  ON public.incidents (company_id, status);

-- ---------------------------------------------------------------------------
-- Two per-company SMS switches, OFF by default (new SMS is never on by default).
-- Read directly where the message is sent; there is no routed template for
-- these — a ticket reply and an outage notice go straight out as SMS, the way
-- the login code does, respecting the SMS master switch and the customer's
-- opt-out.
-- ---------------------------------------------------------------------------
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS notify_ticket_reply_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notify_outage_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------------------
-- Row level security, same shape as every other tenant table.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_messages', 'incidents'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_select ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_select ON public.%I FOR SELECT TO authenticated
         USING (company_id = public.current_company_id())', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_insert ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_insert ON public.%I FOR INSERT TO authenticated
         WITH CHECK (company_id = public.current_company_id())', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_update ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_update ON public.%I FOR UPDATE TO authenticated
         USING (company_id = public.current_company_id())
         WITH CHECK (company_id = public.current_company_id())', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_delete ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_delete ON public.%I FOR DELETE TO authenticated
         USING (company_id = public.current_company_id())', t);
  END LOOP;
END
$$;
