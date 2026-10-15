-- ISPMan: the customer portal — a subdomain per tenant where a customer signs
-- in with their phone number and an SMS code to see their balance, expiry and
-- payments, and pay online.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- NOT YET APPLIED. Two independent pieces:
--   * companies.slug   — the subdomain a tenant's portal answers on. Absent,
--                        lib/data/portal.ts#companyBySlug finds nobody and every
--                        portal host 404s, which is the correct closed default.
--   * customer_otp     — the one-time codes the phone login issues and checks.
--
-- Nothing about the staff app changes when this is applied: the slug column is
-- unused by it, and the portal only answers on a configured subdomain
-- (PORTAL_HOST_SUFFIX) that does not exist until DNS is pointed at it.

-- ---------------------------------------------------------------------------
-- companies.slug — the tenant's subdomain label.
--
-- A URL-safe handle: 'ezmze' in ezmze.<PORTAL_HOST_SUFFIX>. Backfilled from the
-- display name, which the owner can correct afterwards. UNIQUE, because the slug
-- IS the tenant selector for an unauthenticated portal request — two companies
-- sharing one would hand a customer the wrong ISP.
-- ---------------------------------------------------------------------------
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS slug VARCHAR(63);

UPDATE public.companies
SET slug = trim(both '-' from lower(regexp_replace(trim(name), '[^a-zA-Z0-9]+', '-', 'g')))
WHERE slug IS NULL AND name IS NOT NULL AND trim(name) <> '';

-- Unique only where present: a company with no derivable slug (blank name) is
-- left null and simply has no portal until the owner sets one, rather than
-- blocking the migration.
CREATE UNIQUE INDEX IF NOT EXISTS companies_slug_key
  ON public.companies (slug) WHERE slug IS NOT NULL;

-- ---------------------------------------------------------------------------
-- customer_otp — one row per code issued to a phone for a company.
--
-- The code is stored HASHED, never in the clear: a login code is a bearer
-- secret for the few minutes it lives, and the staff who can read this table
-- must not be able to read it and sign in as a customer. Verification hashes the
-- submitted code the same way and compares.
--
-- Rate limiting reads this table (recent rows per company+phone) rather than a
-- separate counter, so there is one source of truth for "how many codes has
-- this number asked for". attempts caps guesses against a single code.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_otp (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  company_id BIGINT NOT NULL
    REFERENCES public.companies (id) ON DELETE CASCADE,

  -- The number the code was sent to, E.164 without the plus (lib/phone.ts),
  -- so a lookup matches regardless of how the customer typed it.
  phone VARCHAR(20) NOT NULL,

  -- sha256 hex of company:phone:code. Never the code itself.
  code_hash TEXT NOT NULL,

  expires_at TIMESTAMPTZ NOT NULL,
  -- Guesses made against this code; the verifier stops honouring it past a cap.
  attempts SMALLINT NOT NULL DEFAULT 0,
  -- Set when a code is spent, so it cannot be replayed.
  consumed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_otp_lookup_idx
  ON public.customer_otp (company_id, phone, created_at DESC);

-- ---------------------------------------------------------------------------
-- Row level security, same shape as every other tenant table. The portal reads
-- and writes these through the service-role client (it has no staff session),
-- which bypasses RLS; the policies gate the authenticated role, which has no
-- reason to touch either and is held to its own company if it ever does.
-- ---------------------------------------------------------------------------
ALTER TABLE public.customer_otp ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS tenant_select ON public.customer_otp;
  CREATE POLICY tenant_select ON public.customer_otp FOR SELECT TO authenticated
    USING (company_id = public.current_company_id());

  DROP POLICY IF EXISTS tenant_insert ON public.customer_otp;
  CREATE POLICY tenant_insert ON public.customer_otp FOR INSERT TO authenticated
    WITH CHECK (company_id = public.current_company_id());

  DROP POLICY IF EXISTS tenant_update ON public.customer_otp;
  CREATE POLICY tenant_update ON public.customer_otp FOR UPDATE TO authenticated
    USING (company_id = public.current_company_id())
    WITH CHECK (company_id = public.current_company_id());

  DROP POLICY IF EXISTS tenant_delete ON public.customer_otp;
  CREATE POLICY tenant_delete ON public.customer_otp FOR DELETE TO authenticated
    USING (company_id = public.current_company_id());
END
$$;
