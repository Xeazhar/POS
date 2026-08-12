-- Realtime Authorization policies for CalePOS private Broadcast topics.
--
-- Run AFTER migrate_realtime_broadcast_v1.sql (needs staff_can_subscribe_branch,
-- realtime_pos_topic_branch_id, realtime_pos_is_network_ops).
--
-- Only needed if the main migration printed a NOTICE that it could not create
-- policies on realtime.messages (Supabase locks that table's ownership).
--
-- Do NOT run: ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY
-- (RLS is already on; ALTER fails with "must be owner of table messages").
--
-- Also enable: Dashboard → Realtime → Authorization (private channels).
--
-- No INSERT policy for authenticated — clients must not forge broadcasts;
-- only DB realtime.send (via broadcast_pos_event triggers) publishes.

drop policy if exists "pos branch broadcast receive" on realtime.messages;

create policy "pos branch broadcast receive"
on realtime.messages
for select
to authenticated
using (
  coalesce(realtime.messages.extension, '') = 'broadcast'
  and (
    (
      public.realtime_pos_topic_branch_id() is not null
      and public.staff_can_subscribe_branch(public.realtime_pos_topic_branch_id())
    )
    or (
      public.realtime_pos_is_network_ops()
      and public.is_manager()
    )
  )
);
