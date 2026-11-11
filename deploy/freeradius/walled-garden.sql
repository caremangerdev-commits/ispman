-- Which routers have a walled garden, and the pool to put expired customers in.
--
-- Runs in the RADIUS MySQL database (the one holding radcheck), NOT Supabase.
--
-- THE TABLE BEING EMPTY IS THE SAFE STATE, and it starts empty. The policy in
-- ispman-walled-garden returns nothing for a router with no row here, so that
-- router keeps today's behaviour exactly: an expired customer is rejected.
--
-- A ROW HERE IS A PROMISE ABOUT THE ROUTER. It says the restricted pool exists
-- on that router and the firewall rules that keep it restricted are in place.
-- Add the row only after both are true, because an expired customer accepted
-- onto a router without them gets an ordinary address and full internet for
-- nothing.
--
-- The address plan is 10.99.<last octet of the tunnel address>.0/24 — chosen
-- because 10.99.x appears nowhere in the network: the live customer space is
-- 173.168, 10.10, 192.168, 10.30, 175.16, 172.16, 100.100, 172.168, 10.9 and
-- 10.11, and radacct has never held a single 10.99 address. The tunnel octet
-- keeps the pool named after the router everyone already knows it by.
--
-- A /24 is 253 usable, against a worst case of 37 simultaneously expired
-- customers on any one router (WCN's CCR1036, 10 Nov 2026). Room to spare.

CREATE TABLE IF NOT EXISTS ispman_walled_garden (
  nasname   VARCHAR(128) NOT NULL PRIMARY KEY
            COMMENT 'The router, as Packet-Src-IP-Address sees it — its tunnel address, matching nas.nasname',
  pool      VARCHAR(64)  NOT NULL
            COMMENT 'The /ip pool name on that router holding the restricted range',
  enabled   TINYINT(1)   NOT NULL DEFAULT 0
            COMMENT '0 disables without deleting the row, so a router can be pulled out of the garden instantly',
  session_timeout_secs INT NOT NULL DEFAULT 120
            COMMENT 'Returned as Session-Timeout: how soon a restricted customer re-asks, which is how fast they come back after paying. A DHCP renewal does not re-query RADIUS, so this is the only lever - see migration 0047',
  note      VARCHAR(255) NULL,
  added_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Added after the table was first created, so it is safe to re-run.
ALTER TABLE ispman_walled_garden
  ADD COLUMN IF NOT EXISTS session_timeout_secs INT NOT NULL DEFAULT 120;

-- TRY IT ON ONE DEVICE BEFORE ALL OF THEM.
--
-- Empty means every expired customer on that router. A comma-separated list of
-- identities means only those, and everyone else on the router keeps being
-- turned away exactly as before.
--
-- This exists because the owner chose to pilot on his own CCR1036 rather than
-- the smallest router on the network - he can walk up to that one, which beats
-- being small. But it carries 179 customers with 37 currently expired, so
-- without this the first attempt would reach all 37 at once.
--
-- No spaces, and the same spelling radcheck uses: uppercase, colon-separated.
--   UPDATE ispman_walled_garden
--      SET only_macs = 'AA:BB:CC:DD:EE:FF,11:22:33:44:55:66'
--    WHERE nasname = '10.250.0.3';
ALTER TABLE ispman_walled_garden
  ADD COLUMN IF NOT EXISTS only_macs TEXT NULL
  COMMENT 'Empty = every expired customer on this router. Otherwise only these identities, for trying it on one device first';

-- THE PILOT. Left commented out on purpose: running this file creates the
-- table and changes nothing.
--
-- WCN's CCR1036 (10.250.0.3), by the owner's choice. I had suggested UNTIY
-- (10 customers) or Santa Cruz (22) because they are the smallest things on
-- the network, but he picked the 1036 because he can physically reach it —
-- being able to recover beats being small, which is the better argument.
-- It carries 179 customers and 37 currently expired, hence only_macs.
--
-- Step 1, one device. Replace the MAC with a real one:
--
--   INSERT INTO ispman_walled_garden (nasname, pool, enabled, note, only_macs)
--   VALUES ('10.250.0.3', 'SUSPENDED', 1, 'WCN CCR1036 - pilot', 'AA:BB:CC:DD:EE:FF');
--
-- Step 2, once that device sees the page and comes back after paying, open it
-- to all 37:
--
--   UPDATE ispman_walled_garden SET only_macs = NULL WHERE nasname = '10.250.0.3';
--
-- To pull it back out at any point, without deleting anything:
--
--   UPDATE ispman_walled_garden SET enabled = 0 WHERE nasname = '10.250.0.3';
