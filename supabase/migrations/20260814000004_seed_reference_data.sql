-- ============================================================================
-- Kandy's Treats V2 — 0004 reference data
-- ----------------------------------------------------------------------------
-- Categories, coupons and pricing settings only. NO customer data and NO menu
-- items: those are copied from Firestore by the Phase 2 script, which is
-- read-only against Firebase.
--
-- Every statement is idempotent, so re-running this migration is safe.
-- Values are transcribed from the current source of truth:
--   categories  -> js/data/menu.js  CATEGORIES
--   coupons     -> js/lib/rules.js  COUPONS   (mirrored in functions/index.js)
--   settings    -> js/lib/rules.js  DELIVERY_FEE / PROCESSING_FEE_RATE
-- ============================================================================

insert into public.categories (id, name, section, blurb, image_key, sort_order) values
  ('foods',    'Foods',    'Foods',    'Sold per scoop — build your plate', 'jollof-rice',    1),
  ('proteins', 'Proteins', 'Proteins', 'Chicken, turkey, beef, fish',       'big-turkey',     2),
  ('specials', 'Specials', 'Specials', 'The Kandy''s signatures',           'chicken-chips',  3),
  ('shawarma', 'Shawarma', 'Shawarma', 'Rolled to order',                   'beef-shawarma',  4),
  ('soups',    'Soups',    'Soups',    'Fresh catfish pepper soup',         'catfish-soup',   5),
  ('sides',    'Sides',    'Sides',    'Plantain, salad, packaging',        'plantain',       6),
  ('drinks',   'Drinks',   'Drinks',   'Chilled and bottled',               'parfait',        7)
on conflict (id) do update
  set name       = excluded.name,
      section    = excluded.section,
      blurb      = excluded.blurb,
      image_key  = excluded.image_key,
      sort_order = excluded.sort_order;

insert into public.coupons (code, label, type, value, min_subtotal, active) values
  ('WELCOME5', 'Welcome discount',        'percent',  5, 1000, true),
  ('KANDY10',  'Kandys customer reward',  'percent', 10, 5000, true)
on conflict (code) do update
  set label        = excluded.label,
      type         = excluded.type,
      value        = excluded.value,
      min_subtotal = excluded.min_subtotal,
      active       = excluded.active;

-- Pricing knobs the checkout RPC will read in Phase 5. Kept as rows so a fee
-- change is an UPDATE, not a code deploy across two codebases.
--
-- takeaway_fee encodes the existing rule from js/lib/rules.js takeawayFee():
-- a basket containing any packable dish costs `standard`; one containing ofada,
-- or rice and beans together, costs `combined`.
insert into public.app_settings (key, value) values
  ('delivery_fee',        '500'::jsonb),
  ('processing_fee_rate', '0.02'::jsonb),
  ('takeaway_fee',        '{"standard": 200, "combined": 300}'::jsonb),
  ('service_area',        '{"state": "Lagos", "country": "Nigeria", "label": "Lagos State only"}'::jsonb),
  ('eta_minutes',         '{"delivery": 45, "pickup": 25}'::jsonb),
  ('ordering_enabled',    'true'::jsonb)
on conflict (key) do nothing;   -- never clobber a value Kandy's has since tuned
