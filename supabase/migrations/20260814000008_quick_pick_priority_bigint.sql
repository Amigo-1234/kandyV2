-- ============================================================================
-- Kandy's Treats V2 — 0008 quick_picks.priority must be bigint
-- ----------------------------------------------------------------------------
-- Found while loading the real data. I had assumed `priority` was a small
-- ordering integer. V1 actually stores Date.now() in it — millisecond epoch
-- values around 1.77e12, well past the 2.1e9 ceiling of int4, so the load
-- failed with "integer out of range".
--
-- Widening is the faithful fix. Rescaling to a 1..n ordinal would silently
-- discard the original timestamps, which are the only record of the order in
-- which Kandy's created these combos.
-- ============================================================================

alter table public.quick_picks
  alter column priority type bigint using priority::bigint;
