--
-- RUN THIS IN THE SUPABASE SQL EDITOR.
--
-- Safe before or after the deploy. Until it is applied, Dime cannot be turned
-- on: lib/data/payment-gateways.ts reads the new column through a fallback
-- select, so a missing column reads as "no webhook secret on record", and
-- lib/payments/gateways/dime.ts refuses to verify a webhook without one. Fygaro
-- is untouched either way.
--
-- WHY A NEW COLUMN
-- 0034 was written around Fygaro, where ONE secret does two jobs: it signs the
-- outbound checkout link and it verifies the inbound webhook. Dime splits them:
--
--   public_key      the client key, sent as the X-Dime-Client header
--   secret_key      the API secret, sent as Authorization: Bearer — this is
--                   what authorises POST /payments/hosted-page
--   webhook_secret  the signing_secret of ONE webhook endpoint, handed back
--                   once by POST /webhook-endpoints and used to verify
--                   X-Dime-Signature
--
-- They are different secrets with different lifetimes — Dime can rotate the
-- webhook secret (POST /webhook-endpoints/{token}/rotate-secret) without
-- touching the API key — so they cannot share a column.
--
-- Nullable, no default, no backfill: Fygaro rows leave it NULL for ever, and
-- fygaro.ts never reads it.

ALTER TABLE public.payment_gateways
  ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

COMMENT ON COLUMN public.payment_gateways.webhook_secret IS
  'The webhook signing secret, when the provider uses a different one from its API secret. Dime: the signing_secret of its webhook endpoint, verifying X-Dime-Signature. NULL for Fygaro, whose single secret_key does both jobs.';

COMMENT ON COLUMN public.payment_gateways.public_key IS
  'Non-secret key id. Fygaro: the API public key, which is the JWT `kid` and the Fygaro-Key-ID on inbound webhooks. Dime: the client key, sent as X-Dime-Client.';

COMMENT ON COLUMN public.payment_gateways.secret_key IS
  'Fygaro: the HMAC secret that both signs the checkout JWT and verifies the webhook. Dime: the API secret sent as Authorization: Bearer; its webhook is verified with webhook_secret instead.';

COMMENT ON COLUMN public.payment_gateways.checkout_url IS
  'The hosted checkout URL, for providers that have a fixed per-company one. Fygaro: the Variable-Amount payment button, to which a signed ?jwt= is appended. Dime: has no standing checkout URL (one is minted per payment from the order token), so this instead holds an optional API base override — blank for live, or https://sandbox.api.dimepay.app/dapi/v2 for sandbox. Checked against an allowlist of Dime''s two hosts in lib/payments/gateways/dime.ts.';
