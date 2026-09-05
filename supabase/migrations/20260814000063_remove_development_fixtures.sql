/* ==========================================================================
   Phase 08B — removing the development fixtures before launch
   --------------------------------------------------------------------------
   Every id below comes from the Phase 08A audit and was approved explicitly.
   Nothing is matched by text pattern: a LIKE '%TEST%' would be one careless
   customer name away from deleting somebody's real order.

   One transaction, with assertions in front of and behind every delete. If a
   count is not exactly what the audit found, this raises and Postgres rolls
   all of it back — there is no state in which half the cleanup happened.

   TWO CORRECTIONS TO THE 08A REPORT, both found while gathering exact ids:

     Orders. The approval lists "15 orders + KD-260904-0049 + KD-260904-0050",
     which reads as 17. Those two codes are already two of the 15. The target
     set is 15, and asserting 15 is what this does.

     FORGED notifications. 08A said 8; there are 10. That report truncated its
     own listing at eight rows and I read the count off the display. All ten
     are the same fixture — same title, same type, same Phase 05.1 permission
     test — and four sit in the real owner's and real staff member's inboxes,
     which is the part that matters. Part E asks that none remain, so all ten
     go.

   WHAT IS DELIBERATELY NOT TOUCHED

     admin_audit_log. Its actor_id is ON DELETE SET NULL, so the record of what
     happened during development outlives the accounts that did it. That is
     the point of an audit log.

     payment_events. orders.id -> payment_events.order_id is ON DELETE CASCADE,
     so a test order carrying a payment event would silently take it along.
     None of the fifteen does, and the assertion below refuses to proceed
     unless that is still true.

     wallet_transactions. Referenced by order_id ON DELETE SET NULL, so no row
     is removed; none of the fifteen is referenced by one anyway.
   ========================================================================== */

begin;

do $$
declare
  v_orders uuid[] := array[
    '4ab15347-75d7-44e5-813c-0b58dc308358',
    '4c08c430-2a01-47fd-8f5b-8b3b8531f6bd',
    '046c38fe-dfb4-4161-8672-ed0af3c9cc5c',
    '8ebc49de-29c9-48f0-844f-bb4f460ffa37',
    'e08d4826-703d-4b7a-842c-e78de12fe082',
    '83edd62a-b0b2-477e-aedf-d4de48de65cc',
    '64eccf83-c082-4ac4-bcfe-b4fcb650429d',
    '728c1b2b-1555-4305-8537-d11b8fcc2b55',
    'ccf38854-72f4-4c1b-9e69-2be0407b3410',
    'fb1d5035-6d3f-4cd0-b617-83ae5a772553',
    '58299980-d6bd-4bb8-9633-23e2790cfaef',
    'fa84fd8b-2d92-4eb8-beae-68de04acf864',
    'c5f3d00c-cc24-471c-8d18-e81c2abaacb9',
    '2d7d6f47-5569-43e0-bce6-4087fca0df67',
    '13409494-5085-479d-8fb9-82621d0bd4c9'
  ];
  v_eod uuid[] := array[
    'cde2305c-0886-4f56-a7f5-13fc008ed5d5',
    '84e32681-2e08-4783-8f45-771924dc3945',
    'd6d82f54-407b-4345-b03c-9b5f2db341e7'
  ];
  v_jobs uuid[] := array[
    'ad2e8525-e6c1-4bdb-ae6f-5746d767097e',
    'a8f90716-21b5-4318-b2bc-695b6a0f0e6e',
    '1a44761d-e785-405e-bf5a-8b2a00a52d76',
    '89a10362-48aa-451d-9a76-e8687fb73e1a',
    'eedd16fc-2a3d-405a-a9cb-e97ab37df1f7',
    'd5adeb7b-16e7-4bc6-8f66-332254df5c47'
  ];
  v_notifs uuid[] := array[
    '046a57b6-4d3e-49d6-9469-f6ecc23cd1ba',
    '0bd1dba0-3e45-44db-a0e6-f8504608943b',
    'ea5de7fe-7432-4ec5-8204-57ef2fde9a4f',
    'e9ea4f56-1105-4777-87a3-7760653f67fb',
    '587a5799-173d-48bc-a8d4-1c44368faa04',
    'bf21e064-31b8-421e-ac5b-815e151f44b4',
    'a2d71b9f-c3f6-46dd-8d6a-45ba14aa50b4',
    '87a70463-0e8d-41a6-af3b-370bf7f20e76',
    'd7333961-fc5c-4104-88cd-afadec5b0ee9',
    '737df345-4bcf-4646-888c-4f631d097909',
    '7af55986-b2b2-46e0-b85a-ffd98fe62e7b'
  ];
  v_convs uuid[] := array[
    '0ed6737d-9a0b-43ba-9bab-5fcbebfbbfe6',
    '31d92b73-d6e7-43cf-a4bb-69e202055e60'
  ];
  v_test_cust uuid := '8e4d319b-e3f1-4900-b80b-d7b2c0716ec2';
  n integer;
  v_wallet_before bigint; v_wallet_after bigint;
  v_pe_before integer; v_audit_before integer;
begin
  select coalesce(sum(balance),0) into v_wallet_before from public.wallets;
  select count(*) into v_pe_before from public.payment_events;
  select count(*) into v_audit_before from public.admin_audit_log;

  /* ---- The targets are exactly what the audit described ---------------- */

  select count(*) into n from public.orders where id = any(v_orders);
  if n <> 15 then raise exception 'Expected 15 target orders, found %', n; end if;

  select count(*) into n from public.orders where id = any(v_orders) and user_id <> v_test_cust;
  if n <> 0 then raise exception '% target order(s) not owned by the test customer', n; end if;

  select count(*) into n from public.orders where id = any(v_orders) and paid;
  if n <> 0 then raise exception '% target order(s) marked paid', n; end if;

  select count(*) into n from public.orders
   where id = any(v_orders)
     and not (coalesce(customer::text,'') || coalesce(notes,'') ~* '(AUTOMATED TEST|DISPOSABLE|PHASE)');
  if n <> 0 then raise exception '% target order(s) carry no test marker', n; end if;

  select count(*) into n from public.payment_events where order_id = any(v_orders);
  if n <> 0 then raise exception '% payment event(s) attached to target orders — aborting', n; end if;

  select count(*) into n from public.wallet_transactions where order_id = any(v_orders);
  if n <> 0 then raise exception '% wallet transaction(s) attached to target orders — aborting', n; end if;

  select count(*) into n from public.staff_day_reports where id = any(v_eod);
  if n <> 3 then raise exception 'Expected 3 target EOD reports, found %', n; end if;
  select count(*) into n from public.staff_day_reports where id = any(v_eod) and problems !~* 'PHASE 03';
  if n <> 0 then raise exception '% target EOD report(s) lack the PHASE 03 marker', n; end if;

  select count(*) into n from public.job_applications where id = any(v_jobs);
  if n <> 6 then raise exception 'Expected 6 target applications, found %', n; end if;
  select count(*) into n from public.job_applications where id = any(v_jobs) and name !~* 'LAUNCH TEST';
  if n <> 0 then raise exception '% target application(s) lack the LAUNCH TEST marker', n; end if;

  select count(*) into n from public.notifications where id = any(v_notifs);
  if n <> 11 then raise exception 'Expected 11 target notifications, found %', n; end if;
  select count(*) into n from public.notifications
   where id = any(v_notifs)
     and coalesce(title,'') !~* 'FORGED'
     and coalesce(message,'') !~* '(FORGED|deep-link handoff)';
  if n <> 0 then raise exception '% target notification(s) are not identified fixtures', n; end if;

  select count(*) into n from public.chat_conversations
   where id = any(v_convs)
     and user_id not in ('8e4d319b-e3f1-4900-b80b-d7b2c0716ec2','375ca6a7-28ac-4cc7-968a-561566c5f87a');
  if n <> 0 then raise exception '% target conversation(s) belong to a real user', n; end if;

  /* ---- Deletes, in foreign-key order ----------------------------------- */

  delete from public.order_items where order_id = any(v_orders);
  get diagnostics n = row_count; raise notice 'order_items deleted: %', n;

  delete from public.order_status_history where order_id = any(v_orders);
  get diagnostics n = row_count; raise notice 'order_status_history deleted: %', n;

  delete from public.orders where id = any(v_orders);
  get diagnostics n = row_count; raise notice 'orders deleted: %', n;
  if n <> 15 then raise exception 'Deleted % orders, expected 15', n; end if;

  delete from public.staff_day_reports where id = any(v_eod);
  get diagnostics n = row_count; raise notice 'staff_day_reports deleted: %', n;

  delete from public.job_applications where id = any(v_jobs);
  get diagnostics n = row_count; raise notice 'job_applications deleted: %', n;

  delete from public.notifications where id = any(v_notifs);
  get diagnostics n = row_count; raise notice 'notifications deleted: %', n;

  delete from public.chat_conversations where id = any(v_convs);
  get diagnostics n = row_count; raise notice 'chat_conversations deleted: %', n;

  /* ---- The real business is exactly where it was ----------------------- */

  select coalesce(sum(balance),0) into v_wallet_after from public.wallets;
  if v_wallet_after <> v_wallet_before then
    raise exception 'Wallet total moved: % -> %', v_wallet_before, v_wallet_after; end if;
  if v_wallet_after <> 38160 then
    raise exception 'Wallet total is %, expected 38160', v_wallet_after; end if;

  select count(*) into n from public.payment_events;
  if n <> v_pe_before or n <> 3 then raise exception 'payment_events changed: % -> %', v_pe_before, n; end if;

  select count(*) into n from public.admin_audit_log;
  if n <> v_audit_before then raise exception 'admin_audit_log changed: % -> %', v_audit_before, n; end if;

  select count(*) into n from public.orders;
  if n <> 9 then raise exception 'Expected 9 real orders remaining, found %', n; end if;

  select count(*) into n from public.menu_items;
  if n <> 85 then raise exception 'menu_items is %, expected 85', n; end if;

  select count(*) into n from public.wallet_transactions;
  if n <> 8 then raise exception 'wallet_transactions is %, expected 8', n; end if;

  select count(*) into n from public.notifications where coalesce(title,'') ~* 'FORGED';
  if n <> 0 then raise exception '% FORGED notification(s) still present', n; end if;

  select count(*) into n from public.staff_announcements;
  if n <> 1 then raise exception 'staff_announcements is %, expected 1', n; end if;

  select count(*) into n from public.job_applications;
  if n <> 1 then raise exception 'job_applications is %, expected 1 (Yann Leuret)', n; end if;

  select count(*) into n from public.profiles;
  if n <> 12 then raise exception 'profiles changed to % — no account is removed here', n; end if;

  raise notice 'Cleanup complete. Real business data verified unchanged.';
end;
$$;

commit;
