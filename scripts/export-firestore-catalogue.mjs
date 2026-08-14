/* ============================================================================
   Kandy's Treats — Phase 2 catalogue export: Firestore -> SQL
   ----------------------------------------------------------------------------
   STRICTLY READ-ONLY against Firebase. This script issues GET requests to the
   Firestore REST API and nothing else. It cannot write, modify or delete.

   It emits a .sql file which is then applied with the Supabase CLI, so no
   Supabase service_role key is ever needed or stored.

       node scripts/export-firestore-catalogue.mjs > supabase/seed/catalogue.sql

   Only PUBLIC collections are read (menus, quickPicks, announcements) — all
   three are `allow read: if true` in firestore.rules, so no auth is required.
   ============================================================================ */

import { readFileSync } from "node:fs";

const cfg = readFileSync("js/config/app.js", "utf8");
const pick = (k) => cfg.match(new RegExp(k + ':\\s*"([^"]+)"'))[1];
const PROJECT = pick("projectId");
const API_KEY = pick("apiKey");

const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

/** Firestore REST wraps every value in a type tag; unwrap it. */
function val(v) {
  if (v == null) return null;
  if ("stringValue"    in v) return v.stringValue;
  if ("integerValue"   in v) return Number(v.integerValue);
  if ("doubleValue"    in v) return Number(v.doubleValue);
  if ("booleanValue"   in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue"      in v) return null;
  if ("mapValue"       in v) return fields(v.mapValue.fields || {});
  if ("arrayValue"     in v) return (v.arrayValue.values || []).map(val);
  return null;
}
const fields = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, val(v)]));

async function fetchAll(collection) {
  const out = [];
  let token = "";
  do {
    const url = `${BASE}/${collection}?key=${API_KEY}&pageSize=300` +
                (token ? `&pageToken=${token}` : "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${collection}: ${res.status} ${await res.text()}`);
    const body = await res.json();
    for (const d of body.documents || []) {
      out.push({ id: d.name.split("/").pop(), ...fields(d.fields || {}) });
    }
    token = body.nextPageToken || "";
  } while (token);
  return out;
}

/* Firestore's free tier has a tight read quota and this project has no
   billing, so the default path reads a snapshot captured earlier rather than
   hitting the API again. Pass --live to re-read from Firestore (still
   read-only: GET requests only). */
const SNAPSHOT_PATH = "supabase/seed/firestore-export.json";
const LIVE = process.argv.includes("--live");

let menus, picks, anns;
if (LIVE) {
  [menus, picks, anns] = await Promise.all([
    fetchAll("menus"), fetchAll("quickPicks"), fetchAll("announcements")
  ]);
} else {
  const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  menus = snap.menus; picks = snap.picks; anns = snap.anns;
}

const q = (s) => (s == null ? "null" : "'" + String(s).replace(/'/g, "''") + "'");
const n = (v) => (v == null || Number.isNaN(Number(v)) ? "null" : String(Math.round(Number(v))));
const b = (v) => (v ? "true" : "false");

/* ---- image_key resolution -------------------------------------------------
   Reuses the same three-tier name match the frontend uses, so a live document
   is joined to the Kandy's photography we actually ship. Resolved ONCE here,
   at seed time, instead of on every page load. */
const menuJs = readFileSync("js/data/menu.js", "utf8");
const SNAPSHOT = [...menuJs.matchAll(/\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)"[^}]*?image:\s*"([^"]+)"/g)]
  .map((m) => ({ id: m[1], name: m[2], image: m[3] }));

const NOISE = ["per","scoop","small","big","large","extra","xtra","with","and","the",
               "plate","pack","size","normal","bottle","can"];
const words = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/)
  .filter((w) => w.length > 2 && !NOISE.includes(w));
const nameKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function imageKeyFor(name) {
  const key = nameKey(name);
  const exact = SNAPSHOT.find((i) => nameKey(i.name) === key);
  if (exact) return exact.image;
  const prefix = SNAPSHOT.filter((i) => {
    const k = nameKey(i.name);
    return k.startsWith(key) || key.startsWith(k);
  }).sort((a, x) => nameKey(x.name).length - nameKey(a.name).length);
  if (prefix[0]) return prefix[0].image;
  const theirs = words(name);
  let best = null, score = 0;
  for (const i of SNAPSHOT) {
    const ours = words(i.name);
    if (ours.length && ours.every((w) => theirs.includes(w)) && ours.length > score) {
      best = i; score = ours.length;
    }
  }
  return best ? best.image : null;
}

const SECTION_TO_CATEGORY = {
  "foods": "foods", "proteins": "proteins", "specials": "specials",
  "shawarma": "shawarma", "soups": "soups", "sides": "sides",
  "drinks": "drinks", "chicken & chips": "chicken-chips"
};

/* pack_class drives the takeaway packaging fee the checkout RPC will apply. */
function packClass(name) {
  const s = String(name || "").toLowerCase();
  if (s.includes("ofada")) return "ofada";
  if (/\bbeans\b/.test(s)) return "beans";
  if (/(rice|amala|swallow|semo|eba|spaghetti|pepper soup|pounded yam|ewa agoyin|poundo)/.test(s))
    return "standard";
  return null;
}

const quickIds = new Set(
  picks.filter((p) => p.active).flatMap((p) => (p.items || []).map((i) => i.menuId))
);

const L = [];
L.push("-- GENERATED by scripts/export-firestore-catalogue.mjs — do not hand-edit.");
L.push(`-- Source: Firestore project ${PROJECT} (read-only).`);
L.push(`-- ${menus.length} menu items, ${picks.length} quick picks, ${anns.length} announcements.`);
L.push("begin;");

for (const m of menus) {
  const section = m.section || "";
  const cat = SECTION_TO_CATEGORY[section.toLowerCase()] || null;
  const img = typeof m.image === "string" && /^https?:/.test(m.image) ? m.image : null;
  L.push(
    `insert into public.menu_items (legacy_firestore_id, name, price, category_id, section, ` +
    `status, image_key, image_url, pack_class, is_quick_pick) values (` +
    [q(m.id), q(m.name), n(m.price), q(cat), q(section),
     q(String(m.status || "available").toLowerCase() === "available" ? "available" : "sold_out"),
     q(imageKeyFor(m.name)), q(img), q(packClass(m.name)), b(quickIds.has(m.id))].join(", ") +
    `) on conflict (legacy_firestore_id) do update set ` +
    `name=excluded.name, price=excluded.price, category_id=excluded.category_id, ` +
    `section=excluded.section, status=excluded.status, image_key=excluded.image_key, ` +
    `image_url=excluded.image_url, pack_class=excluded.pack_class, ` +
    `is_quick_pick=excluded.is_quick_pick;`
  );
}

for (const p of picks) {
  const img = typeof p.image === "string" && /^https?:/.test(p.image) ? p.image : null;
  L.push(
    `insert into public.quick_picks (legacy_firestore_id, title, description, image_url, ` +
    `active, priority) values (` +
    [q(p.id), q(p.title || "Quick pick"), q(p.description || ""), q(img),
     b(p.active), n(p.priority || 0)].join(", ") +
    `) on conflict (legacy_firestore_id) do update set title=excluded.title, ` +
    `description=excluded.description, image_url=excluded.image_url, ` +
    `active=excluded.active, priority=excluded.priority;`
  );
  L.push(`delete from public.quick_pick_items where quick_pick_id = ` +
         `(select id from public.quick_picks where legacy_firestore_id = ${q(p.id)});`);
  (p.items || []).forEach((it, idx) => {
    L.push(
      `insert into public.quick_pick_items (quick_pick_id, menu_item_id, name, unit_price, qty, sort_order) ` +
      `select qp.id, mi.id, ${q(it.name)}, ${n(it.price)}, ${n(it.qty || 1)}, ${idx} ` +
      `from public.quick_picks qp ` +
      `left join public.menu_items mi on mi.legacy_firestore_id = ${q(it.menuId)} ` +
      `where qp.legacy_firestore_id = ${q(p.id)};`
    );
  });
}

for (const a of anns) {
  L.push(
    `insert into public.announcements (body, active) values (${q(a.text || "")}, ${b(a.active)}) ` +
    `on conflict do nothing;`
  );
}

L.push("commit;");
console.log(L.join("\n"));

console.error(`read-only export complete: ${menus.length} menus, ${picks.length} quick picks, ` +
              `${anns.length} announcements, ${quickIds.size} items flagged as quick picks`);
