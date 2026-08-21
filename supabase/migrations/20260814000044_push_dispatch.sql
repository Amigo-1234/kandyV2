/* ==========================================================================
   Phase 13 (2/2) — dispatching a notification row to the push sender
   --------------------------------------------------------------------------
   The last link. A row lands in public.notifications; this asks the
   push-send Edge Function to fan it out to that recipient's devices.

   WHY pg_net AND NOT A DIRECT CALL
   --------------------------------
   The trigger runs inside whatever transaction produced the notification —
   which, for a new order, is create_checkout_order(). A synchronous HTTPS
   call there would put a customer's checkout behind a round trip to Google,
   and a push service having a slow minute would become a slow checkout.

   net.http_post() only QUEUES the request: it returns an id immediately and
   pg_net's background worker sends it after the transaction commits. So the
   checkout is never waiting on it, and — importantly — a notification is
   never sent for an order that then rolls back.

   SECRETS
   -------
   The function URL and the dispatch secret live in Vault, not in this file
   and not in any column a client can read. `vault.decrypted_secrets` is
   readable only by roles this migration never grants to anon or
   authenticated, and the trigger reads it as a SECURITY DEFINER.
   ========================================================================== */

begin;

create extension if not exists pg_net with schema extensions;

/* ---- Where the sender lives -------------------------------------------- */

/*
   Two secrets, created only if absent so re-running this migration cannot
   clobber a rotated value. The dispatch secret is written by the deploy step,
   not by this file — there is no secret literal in this repository.
*/
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'push_send_url') then
    perform vault.create_secret(
      'https://opnddlqzdetysqozafko.supabase.co/functions/v1/push-send',
      'push_send_url',
      'Edge Function that fans a notification out to Web Push endpoints');
  end if;
end $$;

/* ---- The dispatcher ---------------------------------------------------- */

create or replace function public.dispatch_push()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_url    text;
  v_secret text;
begin
  /* Already dispatched (a re-insert, or a manual replay): do nothing. The
     Edge Function claims the row again on its side, so this is the first of
     two independent guards against a double send. */
  if new.push_sent_at is not null then return new; end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'push_send_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'push_dispatch_secret';

  /* Push not configured yet: the in-app notification still stands on its own.
     This is the state the site is in until the secrets are set, and it is a
     working state, not a broken one. */
  if v_url is null or v_secret is null then return new; end if;

  /* net.http_post, NOT extensions.net.http_post: pg_net creates its own `net`
     schema for the API regardless of which schema the extension is installed
     into. The wrong qualification raised inside the exception handler below,
     so it failed silently — the notification still arrived, the push never
     left. */
  perform net.http_post(
    url     := v_url,
    body    := jsonb_build_object('notification_id', new.id),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-dispatch-secret', v_secret),
    timeout_milliseconds := 8000);

  return new;
exception when others then
  /* Never let a delivery channel cost the event itself. The notification is
     already committed and the bell will still show it; only the push is
     lost, and it is logged rather than swallowed silently. */
  raise warning 'push dispatch failed for notification %: %', new.id, sqlerrm;
  return new;
end;
$$;

/*
   AFTER INSERT only — see 0043's header. A collapsed repeat updates the row
   rather than inserting, and deliberately does not buzz the phone again.
*/
drop trigger if exists notifications_dispatch_push on public.notifications;
create trigger notifications_dispatch_push
  after insert on public.notifications
  for each row execute function public.dispatch_push();

commit;
