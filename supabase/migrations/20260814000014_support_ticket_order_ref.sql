-- ---------------------------------------------------------------------------
-- support_tickets.order_ref
--
-- The account page prints the order a ticket refers to
-- (`ticket.orderId ? " · " + ticket.orderId : ""`), and the Firestore version
-- stored that reference on the ticket. There is no equivalent column yet.
--
-- It is deliberately TEXT holding the human order code (KD-260814-0001), not
-- a uuid foreign key: the UI already carries the code, a ticket may reference
-- an order that was later removed, and a support record should not block or
-- cascade with order deletion.
--
-- ADDITIVE: nullable ADD COLUMN, no default, no rewrite, no data touched.
-- ---------------------------------------------------------------------------

alter table public.support_tickets
  add column if not exists order_ref text;

comment on column public.support_tickets.order_ref is
  'Human order code this ticket refers to (display only, not a foreign key).';

-- Customers already hold INSERT/SELECT on their own tickets; extend the
-- column-level grant so the new column can be written on create.
grant insert (order_ref) on public.support_tickets to authenticated;
