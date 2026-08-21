/* ==========================================================================
   Phase 11 (3/4) — Settings
   --------------------------------------------------------------------------
   app_settings already existed as six key/value rows with no editor. This
   migration gives it the three things it was missing before an interface
   could be trusted to write to it: a per-key permission tier, per-key
   validation, and an audit trail.

   NOTHING NEW IS INVENTED. The six keys below are the six rows that are
   already in the table and already read by the pricing code:

     delivery_fee         read by create_checkout_order()
     takeaway_fee         read by create_checkout_order()
     processing_fee_rate  reserved by the payments code
     eta_minutes          promised delivery/pickup times
     service_area         the coverage label shown to customers
     ordering_enabled     ...was read by nothing at all. See below.

   THE PER-KEY TIER, AND WHY A POLICY COULD NOT DO IT
   --------------------------------------------------
   Migration 0037 reduced the UPDATE policy to a plain is_manager(), because a
   policy can only see the row, not the field, and cannot compare OLD to NEW.
   The split between "an admin may change this" and "only the owner may
   change this" therefore lives in a trigger, which is also where the value is
   validated and the change is recorded. One place, three jobs, no way past
   it — a policy grants the verb, the trigger judges the edit.

     manager (admin + owner)   ordering_enabled, eta_minutes
     owner only                delivery_fee, takeaway_fee,
                               processing_fee_rate, service_area

   Money and coverage stay with the owner. Operations move with the admin.
   Staff and supervisor get neither: Phase 11 §8. Note this REMOVES a
   capability that existed before — 0019 let any is_admin() caller, including
   plain staff, flip ordering_enabled and take the whole store offline.

   VALIDATION IS NOT A NICETY HERE
   -------------------------------
   delivery_fee is cast with (value #>> '{}')::integer inside
   create_checkout_order(). A browser writing "free" into that row would not
   break Settings; it would break checkout, for everyone, at the moment of
   payment. So each key's shape is asserted before the row lands.

   ORDERING_ENABLED NOW MEANS SOMETHING
   ------------------------------------
   The row has existed since 0004 and no code has ever read it. Shipping a
   Settings screen with a switch that silently does nothing is worse than
   shipping no switch, so a BEFORE INSERT trigger on orders enforces it.

   That trigger deliberately does NOT touch create_checkout_order: not one
   line of the pricing function changes, no total is recalculated, and no
   payment path is altered. It is a precondition on the customer's own insert,
   nothing more, and staff placing an order on a customer's behalf are exempt
   so a paused storefront does not also stop the kitchen.
   ========================================================================== */

begin;

/* ---- Which tier owns which key ----------------------------------------- */

/* Fails closed: a key nobody has classified is owner-only. */
create or replace function public.setting_tier(p_key text)
returns text language sql immutable as $$
  select case p_key
           when 'ordering_enabled' then 'manager'
           when 'eta_minutes'      then 'manager'
           else 'owner'
         end;
$$;

/* Human wording for the audit summary and the Settings screen. */
create or replace function public.setting_label(p_key text)
returns text language sql immutable as $$
  select case p_key
           when 'ordering_enabled'    then 'Ordering'
           when 'eta_minutes'         then 'Estimated times'
           when 'delivery_fee'        then 'Delivery fee'
           when 'takeaway_fee'        then 'Takeaway packaging'
           when 'processing_fee_rate' then 'Processing fee rate'
           when 'service_area'        then 'Service area'
           else p_key
         end;
$$;

/* ---- Validation, permission and stamping ------------------------------- */

create or replace function public.validate_app_setting()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_tier text := public.setting_tier(new.key);
  v_v    jsonb := new.value;
begin
  /* Server-side callers (migrations, seeds) have no JWT and are trusted by
     virtue of their database role. */
  if auth.uid() is not null then
    if v_tier = 'owner' and not public.is_owner() then
      raise exception '% is an owner-only setting', public.setting_label(new.key)
        using errcode = '42501',
              hint = 'Fees and service area are the owner''s to change.';
    end if;
    if not public.is_manager() then
      raise exception 'Settings are available to admins and the owner only'
        using errcode = '42501';
    end if;
  end if;

  /* The key identifies the row; it is not editable. There is no column grant
     for it either, so this is the second lock on the same door. */
  if new.key is distinct from old.key then
    raise exception 'A setting cannot be renamed' using errcode = '42501';
  end if;

  /* Shape. Each branch asserts exactly what the reading code assumes. */
  if new.key = 'ordering_enabled' then
    if jsonb_typeof(v_v) <> 'boolean' then
      raise exception 'Ordering must be true or false' using errcode = '22023';
    end if;

  elsif new.key = 'delivery_fee' then
    if jsonb_typeof(v_v) <> 'number' or (v_v #>> '{}')::numeric < 0
       or (v_v #>> '{}')::numeric > 100000
       or (v_v #>> '{}')::numeric <> floor((v_v #>> '{}')::numeric) then
      raise exception 'Delivery fee must be a whole number of naira between 0 and 100,000'
        using errcode = '22023';
    end if;

  elsif new.key = 'processing_fee_rate' then
    if jsonb_typeof(v_v) <> 'number'
       or (v_v #>> '{}')::numeric < 0 or (v_v #>> '{}')::numeric > 0.2 then
      raise exception 'Processing fee rate must be between 0 and 0.2'
        using errcode = '22023';
    end if;

  elsif new.key = 'takeaway_fee' then
    if jsonb_typeof(v_v) <> 'object'
       or jsonb_typeof(v_v -> 'standard') <> 'number'
       or jsonb_typeof(v_v -> 'combined') <> 'number'
       or (v_v ->> 'standard')::numeric < 0 or (v_v ->> 'standard')::numeric > 100000
       or (v_v ->> 'combined')::numeric < 0 or (v_v ->> 'combined')::numeric > 100000 then
      raise exception 'Takeaway packaging needs a standard and a combined amount in naira'
        using errcode = '22023';
    end if;

  elsif new.key = 'eta_minutes' then
    if jsonb_typeof(v_v) <> 'object'
       or jsonb_typeof(v_v -> 'pickup') <> 'number'
       or jsonb_typeof(v_v -> 'delivery') <> 'number'
       or (v_v ->> 'pickup')::numeric < 1 or (v_v ->> 'pickup')::numeric > 240
       or (v_v ->> 'delivery')::numeric < 1 or (v_v ->> 'delivery')::numeric > 240 then
      raise exception 'Estimated times need a pickup and a delivery figure between 1 and 240 minutes'
        using errcode = '22023';
    end if;

  elsif new.key = 'service_area' then
    if jsonb_typeof(v_v) <> 'object'
       or btrim(coalesce(v_v ->> 'label', '')) = ''
       or btrim(coalesce(v_v ->> 'state', '')) = ''
       or btrim(coalesce(v_v ->> 'country', '')) = '' then
      raise exception 'Service area needs a label, a state and a country'
        using errcode = '22023';
    end if;
  end if;

  /* updated_at is in the column grant, so a client could otherwise backdate
     a change it had just made. */
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists app_settings_validate on public.app_settings;
create trigger app_settings_validate
  before update on public.app_settings
  for each row execute function public.validate_app_setting();

/* ---- Audit ------------------------------------------------------------- */

create or replace function public.audit_app_setting_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  /* Only a real change by a real person. Re-saving an unchanged form is not
     an event, and a migration writing a seed value is not an admin action. */
  if new.value is not distinct from old.value then return new; end if;
  if auth.uid() is null then return new; end if;

  perform public.log_admin_action(
    'settings.' || new.key || '_change',
    'app_settings', new.key,
    public.setting_label(new.key) || ': ' || (old.value #>> '{}') ||
      ' -> ' || (new.value #>> '{}'),
    jsonb_build_object('key', new.key, 'from', old.value, 'to', new.value));
  return new;
end;
$$;

drop trigger if exists app_settings_audit on public.app_settings;
create trigger app_settings_audit
  after update on public.app_settings
  for each row execute function public.audit_app_setting_change();

/* ---- The Settings screen's one read ------------------------------------ */

create or replace function public.admin_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_rows  jsonb;
  v_owner boolean := public.is_owner();
begin
  if not public.is_manager() then
    raise exception 'Settings are available to admins and the owner only'
      using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'key', s.key,
           'label', public.setting_label(s.key),
           'value', s.value,
           'tier', public.setting_tier(s.key),
           /* Computed here so the form's disabled state and the trigger's
              refusal can never disagree. */
           'editable', (public.setting_tier(s.key) = 'manager' or v_owner),
           'updated_at', s.updated_at) order by s.key), '[]'::jsonb)
    into v_rows
    from public.app_settings s;

  return jsonb_build_object(
    'rows', v_rows,
    'viewer_role', public.auth_role(),
    'is_owner', v_owner);
end;
$$;

revoke all on function public.admin_settings() from public;
revoke all on function public.setting_tier(text) from public;
revoke all on function public.setting_label(text) from public;
grant execute on function public.admin_settings() to authenticated;
grant execute on function public.setting_tier(text) to authenticated;
grant execute on function public.setting_label(text) to authenticated;

/* ---- Make ordering_enabled mean something ------------------------------ */

create or replace function public.enforce_ordering_enabled()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  /* No JWT: create_checkout_order runs as the caller, so this is a genuine
     server-side or migration insert. */
  if auth.uid() is null then return new; end if;
  /* Pausing the storefront must not also stop the kitchen taking an order
     over the phone. */
  if public.is_admin() then return new; end if;

  if not coalesce(
       (select (value #>> '{}')::boolean
          from public.app_settings where key = 'ordering_enabled'), true) then
    raise exception 'Ordering is paused right now. Please try again shortly.'
      using errcode = '42501',
            hint = 'The kitchen has paused new orders from the admin settings.';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_ordering_enabled on public.orders;
create trigger orders_ordering_enabled
  before insert on public.orders
  for each row execute function public.enforce_ordering_enabled();

commit;
