/* ==========================================================================
   Kandy's Treats — Job applications
   --------------------------------------------------------------------------
   Open to signed-out visitors: `anon` holds INSERT on job_applications, and
   the policy pins status = 'new', so nobody can file an application already
   marked reviewed. Reading them back is is_manager() only, which is why this
   module has no list function — the storefront never needs one.
   ========================================================================== */

import { supabase, errorMessage } from "./supabase.js";

const TABLE = "job_applications";

export const ROLES = [
  { slug: "chef",              label: "Become a Chef",
    blurb: "Cook on the line — jollof, proteins, soups and specials." },
  { slug: "rider",             label: "Become a Rider",
    blurb: "Deliver across Ado-Ekiti, Iworoko, Ifaki and Oye-Ekiti." },
  { slug: "kitchen-assistant", label: "Become a Kitchen Assistant",
    blurb: "Prep, packaging and keeping the kitchen moving." }
];

export const careersService = {
  ROLES,

  roleBySlug(slug) {
    return ROLES.filter((r) => r.slug === slug)[0] || null;
  },

  async apply({ roleSlug, name, phone, email, about }) {
    const KT = window.KT;

    const payload = {
      role_slug: String(roleSlug || "").trim(),
      name: KT.rules.cleanString(name, 120),
      phone: KT.rules.normalizePhone(phone),
      email: KT.rules.cleanString(email, 160).toLowerCase(),
      about: KT.rules.cleanString(about, 2000),
      status: "new"
    };

    if (!careersService.roleBySlug(payload.role_slug)) {
      throw new Error("Choose the role you are applying for.");
    }
    if (!payload.name) throw new Error("Tell us your name.");
    if (!KT.rules.isValidPhone(payload.phone)) {
      throw new Error("Enter a valid Nigerian phone number so we can reach you.");
    }
    if (payload.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email)) {
      throw new Error("That email address does not look right.");
    }
    if (payload.about.length < 10) {
      throw new Error("Add a sentence or two about yourself.");
    }

    const { error } = await supabase.from(TABLE).insert(payload);
    if (error) throw error;
    return true;
  }
};

export { errorMessage };
