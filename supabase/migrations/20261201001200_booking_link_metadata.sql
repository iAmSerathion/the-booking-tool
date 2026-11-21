-- Link metadata for the admin Bookings page. Reading it through the booking_links embed checks access to the LINK, but
-- deactivate_profile hands future bookings to a successor without their links, so the successor lost the metadata.
-- This checks access to the BOOKING instead, with the same rule as the bookings read policy.

create function public.booking_link_metadata(p_booking_ids uuid[]) returns table (booking_id uuid, metadata jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, l.metadata
  from public.bookings b
  join public.booking_links l on l.id = b.link_id
  where b.id = any(p_booking_ids)
    and (select public.is_active_profile())
    and (b.host_id = (select auth.uid()) or (select public.is_admin()));
$$;

revoke execute on function public.booking_link_metadata(uuid[]) from public, anon;
grant execute on function public.booking_link_metadata(uuid[]) to authenticated;
