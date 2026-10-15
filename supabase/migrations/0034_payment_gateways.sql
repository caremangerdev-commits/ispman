-- ISPMan: online payment gateways (Fygaro first).
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- NOT YET APPLIED. lib/data/payment-gateways.ts treats a missing table as
-- "no gateway configured": the webhook route answers 503 and the portal shows
-- no online-pay button. Applying this file changes the running app in exactly
-- one way — the gateway settings become storable; nothing goes live until a
-- company has an enabled row with real credentials.
--
-- WHAT THIS IS
-- A customer pays online through a hosted checkout (Fygaro's payment button),
-- and a server-to-server webhook records the payment through the SAME core the
-- till uses (lib/payments/service-payment.ts). This migration stores two things:
--   * payment_gateways  — a company's credentials for one provider, one row per
--                         (company, provider), the same shape as sms_devices.
--   * gateway_payments  — one row per inbound webhook, keyed on the provider's
--                         immutable transaction id, so a redelivered webhook is
--                         recorded once and only once.
--
-- The gateway is behind an interface (lib/payments/gateways): Fygaro is the
-- first implementation; another provider is a new row's `provider` value and a
-- new implementation, no schema change.

-- ---------------------------------------------------------------------------
-- payment_gateways — a company's credentials for one gateway.
--
-- SECRETS ARE STORED AS PLAINTEXT, exactly as sms_devices.api_password is. The
-- service-role reader is the only thing that sees them; the authenticated role
-- is held to the tenant policies below, and the anon role has no access at all.
-- The secret both signs the outbound checkout link and verifies the inbound
-- webhook — one key pair does both (Fygaro's model).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_gateways (
  company_id BIGINT NOT NULL
    REFERENCES public.companies (id) ON DELETE CASCADE,

  -- The gateway's stable id: 'fygaro'. Also the {provider} in the webhook URL.
  provider VARCHAR(40) NOT NULL,

  -- Non-secret key id. Fygaro: the API public key, which is the JWT `kid` and
  -- the Fygaro-Key-ID on inbound webhooks.
  public_key TEXT,

  -- The HMAC secret. Signs the checkout JWT and verifies the webhook signature.
  secret_key TEXT,

  -- The hosted checkout URL a customer is sent to. Fygaro: the Variable-Amount
  -- payment button's URL, to which a signed ?jwt= is appended per payment.
  checkout_url TEXT,

  -- Off until an operator has pasted real credentials and turned it on. A row
  -- with enabled = false is ignored everywhere.
  enabled BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (company_id, provider)
);

-- ---------------------------------------------------------------------------
-- gateway_payments — one row per inbound webhook, the idempotency ledger.
--
-- THE UNIQUE KEY IS THE IDEMPOTENCY GUARANTEE. Fygaro's retry policy is not
-- documented, so a webhook may arrive more than once; (company, provider,
-- reference) is unique, and `reference` is Fygaro's immutable transaction id.
-- The first delivery inserts the row and records the payment; a redelivery
-- collides on the key, finds the row already 'recorded', and is acknowledged
-- without recording again. A row left at 'failed' is reclaimed so a later
-- delivery — or a reprocess — can retry it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gateway_payments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  company_id BIGINT NOT NULL
    REFERENCES public.companies (id) ON DELETE CASCADE,
  provider VARCHAR(40) NOT NULL,

  -- The provider's immutable transaction id (Fygaro's "reference").
  reference TEXT NOT NULL,
  -- What we round-tripped through the gateway: "companyId:customerId".
  custom_reference TEXT,

  amount NUMERIC(12, 2),
  currency VARCHAR(8),

  -- received  — claimed, not yet recorded (or being recorded now)
  -- recorded  — a payments row was written; payment_id points at it
  -- failed    — recording errored; error holds why; eligible for retry
  status VARCHAR(16) NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'recorded', 'failed')),

  -- The payments row this webhook produced, once recorded. No FK: deleting a
  -- payment must not delete the evidence that the money arrived.
  payment_id BIGINT,
  error TEXT,

  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at TIMESTAMPTZ,

  UNIQUE (company_id, provider, reference)
);

CREATE INDEX IF NOT EXISTS gateway_payments_company_status_idx
  ON public.gateway_payments (company_id, status);

-- ---------------------------------------------------------------------------
-- Row level security, same shape as every other tenant table (0001, 0021).
-- The service-role reader bypasses these; they gate the authenticated role for
-- when a settings UI reads credentials through the cookie-bound client.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_gateways ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gateway_payments ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_gateways', 'gateway_payments'] LOOP
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
