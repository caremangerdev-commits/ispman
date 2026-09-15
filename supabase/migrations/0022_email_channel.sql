-- ISPMan: email as a second messaging channel.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR. Requires 0021_sms.sql.
--
-- ===========================================================================
-- NOT YET APPLIED. WRITTEN FOR REVIEW.
-- ===========================================================================
--
-- WHAT THIS DOES. The outbox built by 0021 was shaped around SMS: a mandatory
-- phone column, no notion of channel, and the relay module as the only sender.
-- This makes the queue channel-neutral and leaves everything else shared —
-- one queue, one dispatcher, one batch table, one messaging page, one set of
-- templates. Email is the second channel; a third is a new adapter in
-- lib/messaging/adapters and one line in the registry, and no migration.
--
-- WHAT IT DOES NOT DO. Nothing is enabled. Every company's email switch stays
-- off, every route defaults to SMS, and existing rows are backfilled as SMS
-- rows. A company that never opens the Notifications page sends exactly what
-- it sent yesterday.
--
-- Table names are kept. `sms_outbox` and `sms_batches` are no longer only
-- SMS, but the name is not the abstraction — the channel column is — and a
-- rename would churn every policy, index and reader for no behaviour.

-- ---------------------------------------------------------------------------
-- 1. The outbox: channel, recipient, subject, attachment
-- ---------------------------------------------------------------------------
ALTER TABLE public.sms_outbox
  -- 'sms' | 'email'. Checked, so a typo in an adapter cannot create a channel
  -- the dispatcher will never drain.
  ADD COLUMN IF NOT EXISTS channel VARCHAR(16) NOT NULL DEFAULT 'sms',

  -- The address on the wire, whatever the channel: "18761234567" for SMS,
  -- "someone@example.com" for email. Stamped at enqueue time from the customer
  -- record AS IT THEN WAS, for the same reason `phone` was.
  ADD COLUMN IF NOT EXISTS recipient TEXT,

  -- Email only. NULL for SMS, which has no subject.
  ADD COLUMN IF NOT EXISTS subject TEXT,

  -- Email only. A REFERENCE, never the bytes: '{"kind":"receipt","id":8123}'.
  -- The adapter renders the document at send time through
  -- lib/messaging/attachments.ts, so a PDF is generated from the record it
  -- describes rather than stored twice. Bills (0014) are the next kind.
  ADD COLUMN IF NOT EXISTS attachment TEXT;

ALTER TABLE public.sms_outbox DROP CONSTRAINT IF EXISTS sms_outbox_channel_check;
ALTER TABLE public.sms_outbox ADD CONSTRAINT sms_outbox_channel_check
  CHECK (channel IN ('sms', 'email'));

-- Every existing row is an SMS row and its recipient is its phone.
UPDATE public.sms_outbox SET recipient = phone WHERE recipient IS NULL;

ALTER TABLE public.sms_outbox ALTER COLUMN recipient SET NOT NULL;

-- `phone` was the recipient. It stays, nullable, so nothing that still reads
-- it breaks on an old row; new rows are written with `recipient` and, for SMS,
-- the same value in `phone` until every reader has moved. Do not write it for
-- email rows.
ALTER TABLE public.sms_outbox ALTER COLUMN phone DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Indexes that now include the channel
-- ---------------------------------------------------------------------------
-- The dedupe key is per channel. A company routing receipts to BOTH channels
-- gets one row per channel for one payment — still one per channel per event,
-- which is the guarantee the key exists for.
DROP INDEX IF EXISTS public.sms_outbox_dedupe_key;
CREATE UNIQUE INDEX IF NOT EXISTS sms_outbox_dedupe_key
  ON public.sms_outbox (company_id, channel, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- The dispatcher drains one channel at a time, each at its own throttle.
DROP INDEX IF EXISTS public.sms_outbox_pending_idx;
CREATE INDEX IF NOT EXISTS sms_outbox_pending_idx
  ON public.sms_outbox (company_id, channel, created_at)
  WHERE status IN ('queued', 'sending');

-- ---------------------------------------------------------------------------
-- 3. Settings: the email sender, and WHICH CHANNEL FOR WHICH MESSAGE
-- ---------------------------------------------------------------------------
-- email_enabled ALREADY EXISTS (migration 0007) and has never gated anything.
-- It now becomes the email master switch, exactly as sms_enabled became the
-- SMS one in 0021. It is false everywhere.
ALTER TABLE public.settings
  -- The sender. One platform domain sends for every tenant (EMAIL_FROM_DOMAIN
  -- on the server); the company supplies the display name and where replies
  -- go. NULL name falls back to the company name; NULL reply-to falls back to
  -- the company's email.
  ADD COLUMN IF NOT EXISTS email_from_name TEXT,
  ADD COLUMN IF NOT EXISTS email_reply_to TEXT,

  -- A tenant's own sending domain, LATER. Both null until the domain flow
  -- exists; the adapter uses the platform domain whenever verified is false.
  -- Here now so that flow is a form and an API call, not a migration.
  ADD COLUMN IF NOT EXISTS email_from_domain TEXT,
  ADD COLUMN IF NOT EXISTS email_from_domain_verified BOOLEAN NOT NULL DEFAULT false,

  -- THE ROUTES. One per message kind, the company's decision:
  --   sms             SMS only; a customer with no usable number is skipped
  --   email           email only; no usable address is skipped
  --   email_then_sms  email if they have one, otherwise SMS
  --   sms_then_email  SMS if they have one, otherwise email
  --   both            every channel they have
  -- Default SMS, so applying this changes nobody's behaviour.
  ADD COLUMN IF NOT EXISTS route_payment_receipt VARCHAR(16) NOT NULL DEFAULT 'sms',
  ADD COLUMN IF NOT EXISTS route_expiry_warning VARCHAR(16) NOT NULL DEFAULT 'sms',
  ADD COLUMN IF NOT EXISTS route_disconnection_notice VARCHAR(16) NOT NULL DEFAULT 'sms',
  -- The preselected choice on the messaging page; the operator may override it
  -- per send.
  ADD COLUMN IF NOT EXISTS route_bulk VARCHAR(16) NOT NULL DEFAULT 'sms',

  -- Email templates, separate from the SMS ones: 160 characters is the wrong
  -- shape for an email and a subject has no SMS meaning. NULL means the
  -- built-in default (lib/sms/templates.ts), as for SMS.
  ADD COLUMN IF NOT EXISTS email_payment_receipt_subject TEXT,
  ADD COLUMN IF NOT EXISTS email_payment_receipt_body TEXT,
  ADD COLUMN IF NOT EXISTS email_expiry_warning_subject TEXT,
  ADD COLUMN IF NOT EXISTS email_expiry_warning_body TEXT,
  ADD COLUMN IF NOT EXISTS email_disconnection_subject TEXT,
  ADD COLUMN IF NOT EXISTS email_disconnection_body TEXT;

DO $$
DECLARE
  c text;
BEGIN
  FOREACH c IN ARRAY ARRAY[
    'route_payment_receipt', 'route_expiry_warning', 'route_disconnection_notice', 'route_bulk'
  ] LOOP
    EXECUTE format('ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_%s_check', c);
    EXECUTE format(
      'ALTER TABLE public.settings ADD CONSTRAINT settings_%s_check
         CHECK (%I IN (''sms'', ''email'', ''email_then_sms'', ''sms_then_email'', ''both''))',
      c, c);
  END LOOP;
END
$$;

-- The per-type switches lose their sms_ prefix: they say whether a KIND of
-- message is on at all, and the route says by which channel. Renamed rather
-- than duplicated so there is one switch per kind and not two that can
-- disagree. Guarded, so re-running this file is harmless.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'settings'
               AND column_name = 'sms_payment_receipt_enabled') THEN
    ALTER TABLE public.settings RENAME COLUMN sms_payment_receipt_enabled TO notify_payment_receipt_enabled;
    ALTER TABLE public.settings RENAME COLUMN sms_expiry_warning_enabled TO notify_expiry_warning_enabled;
    ALTER TABLE public.settings RENAME COLUMN sms_disconnection_enabled TO notify_disconnection_enabled;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. customers.email_opted_out — the customer's own choice, per channel
-- ---------------------------------------------------------------------------
-- Separate from sms_opted_out and from a blank address, for the reasons 0021
-- gives: "stop texting me" is not "stop emailing me", and neither is "we have
-- no address for them".
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS email_opted_out BOOLEAN NOT NULL DEFAULT false;

-- No RLS changes: the tables are the ones 0021 already scoped.

-- ===========================================================================
-- SERVER CONFIGURATION (not SQL)
-- ===========================================================================
-- RESEND_API_KEY       the platform's Resend key
-- EMAIL_FROM_DOMAIN    the platform sending domain verified in Resend, e.g.
--                      mail.ispman.example. Every tenant sends as
--                      "<From name> <notifications@that-domain>" until it has
--                      a verified domain of its own.
-- Without both, the email adapter reports "not configured" and the
-- Notifications page says so; nothing is queued for email.
