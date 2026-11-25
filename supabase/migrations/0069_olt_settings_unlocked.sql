-- 0069: running untested settings commands, switched on per OLT by its owner.
--
-- Apply with ispman-migrate. Until it runs, untested brands stay preview-only.
--
-- ISPMan's Settings commands for some brands come from the maker's manual and
-- have not yet been run on a real unit. They are shown either way; this lets
-- an owner send them on one OLT they choose (a spare, or a quiet one) to try
-- them, without switching them on for every company's production OLTs.

alter table public.olts add column if not exists settings_unlocked BOOLEAN NOT NULL DEFAULT false;
