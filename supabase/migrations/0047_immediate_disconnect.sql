-- 0047: cut a customer off the moment their time runs out, per company.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR. Safe before or after the deploy: the
-- code probes for the column (lib/schema.ts, `immediateDisconnect`) and,
-- without it, nothing offers the setting and no session is ever torn down.
--
-- WHAT IT CHANGES, AND WHY IT IS OFF BY DEFAULT (owner, 11 November 2026).
--
-- Today expiry is enforced ONLY at authentication. The radcheck Expiration
-- date passes, and the customer carries on browsing until their session or
-- lease next re-authenticates. Nobody designed that grace period, but every
-- one of the 5,432 live customers currently has it, and some of them are
-- relying on it without knowing.
--
-- Turning this on sends a RADIUS Disconnect-Request (RFC 5176) the moment a
-- customer is cut off, so the session ends there and then and the re-auth that
-- follows is refused. That is a real change in what a subscriber experiences:
-- mid-video, mid-call, mid-upload. So it is per company and it starts off, and
-- a company turns it on when they have decided that is what they want.
--
-- IT IS A SWITCH, NOT A PROMISE. Three things have to be true for a session to
-- actually drop: this column, the RADIUS_COA_ENABLED environment flag on the
-- server, and `/radius incoming set accept=yes` on the router itself. Any one
-- of them missing and the cut-off behaves exactly as it does now — the expiry
-- is written and the session lives until it re-auths. lib/radius/coa.ts never
-- throws, so a router that cannot be reached can never undo a cut-off.

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS immediate_disconnect_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Verify afterwards:
--   SELECT company_id, immediate_disconnect_enabled FROM settings;
