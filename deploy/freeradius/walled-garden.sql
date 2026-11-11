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
  note      VARCHAR(255) NULL,
  added_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- THE PILOT, when its router is ready. Left commented out on purpose: running
-- this file creates the table and changes nothing.
--
-- UNTIY is the pilot because it is the smallest thing on the network — 10
-- customers, 2 of them currently expired. Santa Cruz (22 and 4) is the
-- fallback. WCN's CCR1036 (179 and 37) goes last.
--
--   INSERT INTO ispman_walled_garden (nasname, pool, enabled, note)
--   VALUES ('10.250.0.14', 'walled', 1, 'UNTIY - pilot');
--
-- To pull it back out, without deleting anything:
--
--   UPDATE ispman_walled_garden SET enabled = 0 WHERE nasname = '10.250.0.14';
