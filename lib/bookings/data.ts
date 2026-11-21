import { createSupabase } from "@/lib/db/server";

// The admin Bookings page, read through the member's RLS client: members see their own bookings, admins all.

export type UpcomingBooking = {
  id: string;
  starts_at: string;
  ends_at: string;
  invitee_name: string;
  invitee_email: string;
  invitee_company: string | null;
  invitee_phone: string | null;
  topic: string | null;
  answers: { question: string; answer: string | string[] }[] | null;
  host: string;
  eventType: string;
  // From the booking link, if booked through one. Read through booking_link_metadata: a booking handed to a successor
  // host keeps its link, which the successor cannot read under RLS.
  metadata: Record<string, unknown> | null;
};

// Started bookings are left out: cancel_booking refuses them. shortcut: next 200 only, no paging or past bookings.
export async function loadUpcomingBookings(): Promise<UpcomingBooking[]> {
  const supabase = await createSupabase();
  const { data, error } = await supabase
    .from("bookings")
    .select(
      "id, starts_at, ends_at, invitee_name, invitee_email, invitee_company, invitee_phone, topic, answers, profiles(name), event_types(title)",
    )
    .eq("state", "booked")
    .gt("starts_at", new Date().toISOString())
    .order("starts_at")
    .limit(200);
  if (error) throw error;
  const { data: links, error: linkError } = await supabase.rpc("booking_link_metadata", { p_booking_ids: data.map((b) => b.id) });
  if (linkError) throw linkError;
  const metadata = new Map((links as { booking_id: string; metadata: Record<string, unknown> }[]).map((l) => [l.booking_id, l.metadata]));
  // One-to-one joins; supabase-js types them as arrays without generated database types.
  return data.map(({ profiles, event_types, ...row }) => ({
    ...row,
    host: (profiles as unknown as { name: string }).name,
    eventType: (event_types as unknown as { title: string }).title,
    metadata: metadata.get(row.id) ?? null,
  }));
}
