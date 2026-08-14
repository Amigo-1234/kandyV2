/* ==========================================================================
   Kandy's Treats — Menu service (Supabase)
   --------------------------------------------------------------------------
   Loads public.menu_items (public SELECT under RLS) plus the quick-pick flags,
   then hands them to KT.menu.hydrate().

   The local snapshot in js/data/menu.js paints instantly; this replaces it as
   soon as Supabase answers. Until it does, KT.menu.live stays false and
   checkout refuses to run — create_checkout_order() prices against these rows,
   so ordering from a stale snapshot is never allowed.

   Prices here are for DISPLAY ONLY. The server re-reads every price during
   checkout, so a stale or tampered value in this cache is a display bug, never
   a pricing exploit.
   ========================================================================== */

import { supabase, TABLES } from "./supabase.js";

const CACHE_KEY = window.KT.config.storage.menuCache;
const CACHE_TTL = 10 * 60 * 1000;

/** menu_items row → the shape the UI components already expect. */
function normalise(row) {
  const KT = window.KT;
  const section = row.section || "";
  /* The section mapping is authoritative, NOT category_id. menu_items carries
     a real 8th category ("chicken-chips", 10 dishes) that V1's Firestore also
     had, but the approved category rail in js/data/menu.js only renders seven.
     categoryForSection() folds any unrecognised section into "specials",
     exactly as the Firebase implementation did — so those dishes stay
     browsable instead of disappearing from every filter. Giving them their own
     rail is a UI decision, not a migration one. */
  const category = KT.menu.categoryForSection(section) || row.category_id;
  /* Falls back to the bundled copy/photo for this dish when the row has none. */
  const snapshot = KT.menu.snapshotFor(row.legacy_firestore_id || row.id, row.name);

  return {
    id: row.id,
    legacyId: row.legacy_firestore_id || null,
    name: KT.rules.cleanString(row.name, 120),
    price: Math.max(0, Math.round(Number(row.price) || 0)),
    category,
    section,
    status: String(row.status || "available").toLowerCase(),
    imageUrl: row.image_url || "",
    image: row.image_key || (snapshot && snapshot.image) || null,
    gallery: [],
    blurb: row.blurb || (snapshot && snapshot.blurb) || "",
    description: row.description || (snapshot && snapshot.description) || "",
    rating: Number(row.rating) || 0,
    tags: Array.isArray(row.tags) ? row.tags.slice() : []
  };
}

function readCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (!raw || Date.now() - raw.at > CACHE_TTL) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(items, quickPicks) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), items, quickPicks }));
  } catch { /* quota — the snapshot still covers first paint */ }
}

function announce(source) {
  window.KT.cart.reconcile();
  document.dispatchEvent(new CustomEvent("kt:menu", {
    detail: { live: window.KT.menu.live, count: window.KT.menu.items.length, source }
  }));
}

const SELECT = "id, legacy_firestore_id, slug, name, blurb, description, price, " +
               "category_id, section, status, image_key, image_url, rating, tags, is_quick_pick";

async function fetchMenu() {
  const { data, error } = await supabase
    .from(TABLES.menuItems)
    .select(SELECT)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw error;

  const rows = data || [];
  const items = rows.map(normalise).filter((i) => i.name && i.price > 0);
  const quickPicks = rows.filter((r) => r.is_quick_pick).map((r) => r.id);
  return { items, quickPicks };
}

export const menuService = {
  /** Load the live menu. Falls back to cache, then to the bundled snapshot. */
  async load() {
    const cached = readCache();
    if (cached) {
      window.KT.menu.hydrate(cached.items, cached.quickPicks);
      announce("cache");
    }

    try {
      const { items, quickPicks } = await fetchMenu();
      if (!items.length) throw new Error("empty menu");

      window.KT.menu.hydrate(items, quickPicks);
      writeCache(items, quickPicks);
      announce("supabase");
      return items;
    } catch (error) {
      if (!cached) {
        console.warn("[Kandy's] live menu unavailable — showing the bundled snapshot.", error);
        announce("snapshot");
      }
      return window.KT.menu.items;
    }
  },

  /** Live updates while the customer browses (sold-out flips, price changes). */
  watch() {
    const channel = supabase
      .channel("kt-menu")
      .on("postgres_changes",
        { event: "*", schema: "public", table: TABLES.menuItems },
        async () => {
          try {
            const { items, quickPicks } = await fetchMenu();
            if (!items.length) return;
            window.KT.menu.hydrate(items, quickPicks);
            writeCache(items, quickPicks);
            announce("live");
          } catch { /* network drop — keep whatever we have */ }
        })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  },

  /** Categories, for the storefront rails. Public read. */
  async categories() {
    const { data, error } = await supabase
      .from(TABLES.categories)
      .select("id, name, section, blurb, image_key, sort_order")
      .eq("active", true)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    return data || [];
  }
};
