import { after } from "next/server";
import { channelUser } from "@/lib/calendar/channel";
import { syncCalendar } from "@/lib/calendar/sync";

// Push notifications from Google (events.watch): a POST on every change in a member's primary calendar, with no body,
// only the channel id, our secret and the resource state in the headers. Answers at once and syncs afterwards with the
// sync token (after), so Google never waits. Always 200, unknown channels and wrong secrets included, or Google retries.
export async function POST(request: Request) {
  const channelId = request.headers.get("x-goog-channel-id");
  const token = request.headers.get("x-goog-channel-token");
  // "sync" comes once right after a channel is created and reports no change.
  if (channelId && token && request.headers.get("x-goog-resource-state") !== "sync") {
    const userId = await channelUser(channelId, token).catch((cause) => (console.error("calendar webhook", cause), null));
    if (userId) after(() => syncCalendar(userId).catch((cause) => console.error("calendar sync after notification", userId, cause)));
  }
  return new Response(null, { status: 200 });
}
