-- ISPMan: SMS notifications and bulk messaging.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- NOT YET APPLIED. lib/schema.ts probes for `sms_outbox`; until it exists the
-- SMS settings page and the messaging page are hidden and nothing enqueues.
-- A company with no device paired sends nothing, silently — the same pattern
-- the income panel uses.
--
-- WHAT THIS IS
-- Each tenant runs an Android phone with their own SIM, so the sender number is
-- theirs. The phone connects OUTBOUND to an SMSGate relay on the EC2 box (see
-- docs/sms-relay-setup.md), which sidesteps the dynamic-IP problem entirely.
-- ISPMan never talks to a phone; it queues a row here and a worker posts it to
-- the relay.
--
-- WHAT THIS IS NOT
-- `notifications_queue` ALREADY EXISTS AND IS NOT THIS. That table looks like a
-- send queue — it has `channel`, `recipient` and a pending/sent status — but it
-- is the staff notification bell, where `pending` means UNREAD BY STAFF and
-- `sent` means READ. Nothing has ever delivered from it. Reusing it would have
-- made the bell start texting customers. It is left completely alone.

-- ---------------------------------------------------------------------------
-- sms_devices — the phone a tenant has paired, one row per company.
--
-- ONE DEVICE PER COMPANY, enforced by the primary key. A second phone would
-- mean two SIMs, two sender numbers and a throttle that has to be split between
-- them, and no tenant has asked for that. Making company_id the key means the
-- question cannot be answered wrongly by accident later.
--
-- CREDENTIALS ARE THE RELAY'S, NOT THE PHONE'S. On first connect the relay
-- generates a username and password for the device and shows them in the app.
-- That pair is what the third-party API takes as HTTP Basic. The relay's
-- `private_token` — the thing that lets a phone register at all — is NOT stored
-- here and never reaches ISPMan; it lives on the box and on the phones.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sms_devices (
  company_id BIGINT PRIMARY KEY
    REFERENCES public.companies (id) ON DELETE CASCADE,

  -- What the operator calls it: "Front desk Samsung", "Office phone".
  label VARCHAR(80),

  -- The relay's own id for the device, returned when it registers. Used to
  -- address a message at a specific device; null until the first pairing.
  device_id VARCHAR(128),

  -- HTTP Basic against the relay's 3rd-party API.
  api_username VARCHAR(128),
  api_password TEXT,

  -- Multi-SIM handsets: 1-3, or null for "whichever the phone prefers".
  sim_number SMALLINT CHECK (sim_number BETWEEN 1 AND 3),

  -- Filled from the relay's health/device endpoint by the dispatcher, so the
  -- settings page can show online status without calling out on page load.
  last_seen_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- sms_batches — one row per thing a human pressed send on.
--
-- Automated messages do NOT get a batch. A payment receipt is one message
-- caused by one event; inventing a batch of one for it would put 40,000 rows a
-- year in here to describe nothing.
--
-- The counts are DENORMALISED ON PURPOSE. They are what the batch list shows,
-- and recomputing five aggregates over sms_outbox for every row of a history
-- page is how a page that was fast in testing becomes slow in production. The
-- outbox rows remain the truth; these are a running tally the dispatcher keeps.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sms_batches (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL
    REFERENCES public.companies (id) ON DELETE CASCADE,

  -- Who pressed send. NOT NULL: a batch with no author is not a record of
  -- anything. ON DELETE SET NULL would be wrong here for the same reason —
  -- see the note on sent_by_name below.
  sent_by BIGINT REFERENCES public.users (id) ON DELETE SET NULL,

  -- The name AS IT WAS, stamped at send time, for the same reason payments
  -- stamp their category in 0018: a staff member who leaves and is deleted must
  -- not erase who sent a message to 400 customers.
  sent_by_name VARCHAR(120) NOT NULL,

  -- The composed message, before per-customer placeholders are filled.
  body TEXT NOT NULL,

  -- A human-readable summary of the filters used, so the batch can be explained
  -- a month later: "Active · Residential · owing over 5,000".
  audience TEXT,

  total INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_batches_company_created_idx
  ON public.sms_batches (company_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- sms_outbox — THE queue. One queue, not two.
--
-- Both the automated notifications and the bulk messaging page write here. That
-- is not tidiness, it is the throttle: the rate limit is a property of the SIM,
-- not of the feature. Two queues would mean a 400-recipient blast and a payment
-- receipt each independently believing they may send 10 a minute, the SIM
-- sending 20, and the carrier flagging exactly what the throttle exists to
-- prevent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sms_outbox (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL
    REFERENCES public.companies (id) ON DELETE CASCADE,

  -- Null for a message not about a particular customer. ON DELETE SET NULL and
  -- not CASCADE: deleting a customer must not silently rewrite the history of
  -- what was already sent to them.
  customer_id BIGINT REFERENCES public.customers (id) ON DELETE SET NULL,

  -- Null for automated messages; set for anything a human sent.
  batch_id BIGINT REFERENCES public.sms_batches (id) ON DELETE CASCADE,

  -- 'payment_receipt' | 'expiry_warning' | 'disconnection_notice' | 'bulk'
  kind VARCHAR(32) NOT NULL,

  -- E.164 without the plus, as lib/phone.ts produces: "18761234567". Stamped
  -- at enqueue time from the customer's phone AS IT THEN WAS, so editing a
  -- customer's number does not retroactively change who a sent message went to.
  phone VARCHAR(20) NOT NULL,

  -- Placeholders already substituted. What actually goes out.
  body TEXT NOT NULL,

  -- queued -> sending -> sent -> delivered
  --                   \-> failed
  -- 'sending' is a CLAIM, not a state the relay knows about. See the note on
  -- claiming below.
  status VARCHAR(16) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'failed', 'cancelled')),

  -- Bounded by the dispatcher, not by this column; here so a row that keeps
  -- failing can be given up on and made visible rather than retried forever.
  attempts SMALLINT NOT NULL DEFAULT 0,

  -- The relay's id for the message, so a delivery report can be matched back.
  provider_message_id VARCHAR(128),

  error TEXT,

  -- ------------------------------------------------------------------------
  -- THE DEDUPE KEY. This is what makes "no customer gets a message twice for
  -- the same event" a guarantee rather than a hope.
  --
  -- 'payment:8123', 'expiry:4471:2026-09-14', 'disconnect:4471:2026-09-14'.
  -- The unique index below then makes a re-run of the daily sweep, a
  -- double-clicked button and a second dispatcher all fail the INSERT instead
  -- of sending a second message. Application-side "have we sent this already"
  -- checks lose that race; a unique index cannot.
  --
  -- NULL for bulk sends, where sending the same customer two different messages
  -- on the same day is the operator's business and not a bug.
  -- ------------------------------------------------------------------------
  dedupe_key VARCHAR(128),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

-- Partial, so the many bulk rows with a null key do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS sms_outbox_dedupe_key
  ON public.sms_outbox (company_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- The dispatcher's read: the oldest queued rows for a company. Partial, because
-- it only ever asks about work still to do, and the table is expected to be
-- almost entirely finished rows within a month.
CREATE INDEX IF NOT EXISTS sms_outbox_pending_idx
  ON public.sms_outbox (company_id, created_at)
  WHERE status IN ('queued', 'sending');

CREATE INDEX IF NOT EXISTS sms_outbox_batch_idx
  ON public.sms_outbox (batch_id) WHERE batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sms_outbox_customer_idx
  ON public.sms_outbox (customer_id) WHERE customer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- HOW A ROW IS CLAIMED, and why there is no advisory lock or job runner here.
--
-- PostgREST cannot express SELECT ... FOR UPDATE SKIP LOCKED, so the dispatcher
-- claims with a conditional update and checks whether a row came back:
--
--   UPDATE public.sms_outbox
--      SET status = 'sending', attempts = attempts + 1
--    WHERE id = $1 AND status = 'queued'
--   RETURNING *;
--
-- Two workers racing the same row: one gets it, the other gets nothing and
-- moves on. This is the same compare-and-swap shape as bumpCounter() in
-- lib/data/account-numbers.ts, and it exists for the same reason — the
-- alternative failure is silent and duplicated.
--
-- A row stuck in 'sending' because a worker died is recovered by age: the
-- dispatcher returns anything 'sending' for more than a few minutes to
-- 'queued'. Bounded by `attempts`, so a row that genuinely crashes the sender
-- is given up on rather than looping.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- settings — the per-company SMS configuration.
--
-- sms_enabled ALREADY EXISTS (migration 0007) and has never gated anything: it
-- is on the General Settings form and the super-admin view, and no code has
-- ever read it to decide whether to send. It now becomes the MASTER SWITCH.
-- Off kills every message for that tenant regardless of the per-type toggles
-- below — the switch to reach for when a SIM starts getting flagged.
-- ---------------------------------------------------------------------------
ALTER TABLE public.settings
  -- Per-type switches. ALL DEFAULT FALSE. A tenant that applies this migration
  -- and pairs a phone still sends nothing until they deliberately turn a
  -- message type on. Nothing about installing a feature should start texting a
  -- customer base.
  ADD COLUMN IF NOT EXISTS sms_payment_receipt_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_expiry_warning_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_disconnection_enabled BOOLEAN NOT NULL DEFAULT false,

  -- Templates. NULL means "use the built-in default" rather than "send an empty
  -- message" — see lib/sms/templates.ts, which owns the defaults and the
  -- placeholder vocabulary.
  ADD COLUMN IF NOT EXISTS sms_payment_receipt_template TEXT,
  ADD COLUMN IF NOT EXISTS sms_expiry_warning_template TEXT,
  ADD COLUMN IF NOT EXISTS sms_disconnection_template TEXT,

  -- How many days before cut-off the warning goes out.
  ADD COLUMN IF NOT EXISTS sms_expiry_warning_days SMALLINT NOT NULL DEFAULT 3
    CHECK (sms_expiry_warning_days BETWEEN 1 AND 30),

  -- The throttle, in seconds between messages. 6s is 10 a minute, which is
  -- comfortably inside what a consumer SIM does without attracting attention.
  -- The floor of 1 is a guard rail: a tenant who types 0 should not be able to
  -- turn their own SIM into a spam source.
  ADD COLUMN IF NOT EXISTS sms_throttle_seconds SMALLINT NOT NULL DEFAULT 6
    CHECK (sms_throttle_seconds BETWEEN 1 AND 600),

  -- Overseas numbers. OFF by default: 189 customers across the platform carry a
  -- plausible non-Jamaican number — overseas relatives paying a bill, which is
  -- a real case — but texting them from a consumer SIM is charged at
  -- international rates, and that is not a cost to opt a tenant into.
  ADD COLUMN IF NOT EXISTS sms_allow_foreign BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- customers.sms_opted_out — the customer's own choice, and it outranks
-- everything above.
--
-- Separate from a blank phone on purpose. "We have no way to reach them" and
-- "they asked us to stop" are different facts, they are fixed differently, and
-- conflating them means a tenant who cleans up their phone data starts texting
-- people who opted out.
-- ---------------------------------------------------------------------------
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS sms_opted_out BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Tenant isolation, same as every other table here — see 0001. These three are
-- read and written by the server, but they are company data and are scoped like
-- company data.
-- ---------------------------------------------------------------------------
ALTER TABLE public.sms_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_outbox  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sms_devices', 'sms_batches', 'sms_outbox'] LOOP
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

-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION IS NOT
--
-- It does not enable SMS for anybody. Every switch above defaults to false and
-- no company has a device row, so applying this file changes the behaviour of
-- the running app in exactly one way: the SMS settings page becomes reachable.
--
-- It does not touch notifications_queue. See the note at the top.
--
-- It does not store the relay's private token. That is the credential that lets
-- a phone register, it is the same for every tenant on the box, and putting it
-- in a per-tenant row that a company admin's session can read would hand any
-- one tenant the ability to register a device against another tenant's relay.
-- ---------------------------------------------------------------------------
