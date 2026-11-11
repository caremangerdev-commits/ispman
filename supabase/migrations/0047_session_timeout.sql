-- 0047: how often a customer's device must re-ask whether it is still paid up.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR. Safe before or after the deploy: the
-- code probes for the column (lib/schema.ts, `sessionTimeout`) and, without it,
-- no Session-Timeout is sent and every router behaves exactly as it does today.
--
-- WHAT THIS REPLACES, AND WHY (owner, 11 November 2026).
--
-- The first version of this migration added a boolean for "immediate
-- disconnection" — tear the live session down the moment a customer is cut
-- off, with a RADIUS Disconnect-Request. That cannot work here, and it is
-- worth writing down so nobody tries it again:
--
--   MIKROTIK DOES NOT SUPPORT CoA OR DISCONNECT FOR DHCP RADIUS. A DHCP lease
--   is not a session there is a session context for; a Disconnect-Request for
--   one comes back Session-Context-Not-Found. 5,432 of our 5,434 customers are
--   DHCP. The whole mechanism applies to PPPoE and hotspot only, and we have
--   one of each, both seed rows on the demo tenant.
--
-- The second idea was to ask tenants to shorten their DHCP lease times. That
-- does nothing on its own: A DHCP RENEWAL DOES NOT RE-QUERY RADIUS. Only a
-- DISCOVER from a client that is not already in the router's lease table
-- produces an Access-Request, so a router with a short lease simply renews
-- from its own table more often, without ever asking us again.
--
-- WHAT DOES WORK is the attribute below, returned in the Access-Accept.
-- RouterOS treats Session-Timeout as the maximum lease time, and when the next
-- renewal would run past the time remaining it re-authenticates instead. It is
-- the only supported way to make a DHCP customer re-ask. PPP honours the same
-- attribute, so one setting covers DHCP, PPPoE and hotspot.
--
-- SECONDS, NULLABLE, PER COMPANY. Null means send nothing, which is today's
-- behaviour: the customer re-asks only when their device next needs a fresh
-- lease, which measured out at about once every day and a half. A value makes
-- that a known interval instead, and the interval is the company's call —
-- it is the difference between "cut off within the hour" and "cut off within
-- the day", and it is theirs to choose.
--
-- IT IS NOT FREE, BUT IT IS CHEAP. Every expiry of it is one more
-- Access-Request. At 3600 seconds that is roughly 130,000 a day across all
-- tenants, against the 2.6 MILLION rejections a day the network is already
-- generating from cut-off devices retrying. Anything above about 900 seconds
-- is lost in the noise of what we already carry.
--
-- NO DEFAULT VALUE ON PURPOSE. A default would change the behaviour of every
-- router the moment this is applied. It starts null everywhere and a company
-- opts in.

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS radius_session_timeout_secs INTEGER;

-- A sane floor and ceiling. Below a minute the router would spend its time
-- re-authenticating; above a day the attribute is not doing anything the old
-- behaviour did not already do.
ALTER TABLE public.settings
  DROP CONSTRAINT IF EXISTS settings_radius_session_timeout_secs_range;
ALTER TABLE public.settings
  ADD CONSTRAINT settings_radius_session_timeout_secs_range
  CHECK (
    radius_session_timeout_secs IS NULL
    OR (radius_session_timeout_secs BETWEEN 60 AND 86400)
  );

-- Verify afterwards:
--   SELECT company_id, radius_session_timeout_secs FROM settings;
