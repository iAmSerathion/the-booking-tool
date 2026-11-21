import { createHash, timingSafeEqual } from "node:crypto";
import { calendarUpkeep } from "@/lib/calendar/upkeep";
import { getConfig } from "@/lib/config";
import { dispatchOutbox } from "@/lib/events/dispatcher";
import { runJobs } from "@/lib/jobs/scheduler";
import { retryDueMails } from "@/lib/mail/send";

// The scheduler: pg_cron (supabase/optional/scheduler_cron.sql) or any external cron POSTs here every minute with
// "Authorization: Bearer <SCHEDULER_SECRET>". Steps run in order, each isolated: due jobs, mail retries, calendar upkeep, webhooks (outbox).
//
// Test clock (SCHEDULER_TEST_CLOCK=true, which config allows only with a loopback APP_URL): x-test-now sets the clock and
// needs a scope, x-test-booking (jobs, mail retries and webhooks of that booking) or x-test-user (calendar upkeep of that member);
// steps without their scope are skipped (null). Without the flag the headers are ignored and a normal run happens.

// Webhooks stop starting new POSTs after 40 s (dispatchOutbox budgetMs); this caps the whole run on platforms that honour it.
// A run cut off mid-POST loses nothing: the row is retried after its lease, without using an attempt.
export const maxDuration = 60;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Digests are always 32 bytes, so the compare is constant-time and leaks no length.
const digest = (value: string) => createHash("sha256").update(value).digest();

function authorized(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") && timingSafeEqual(digest(header.slice(7)), digest(getConfig().schedulerSecret));
}

type Clock = { now: Date; onlyBooking: string | null; onlyUser: string | null; scoped: boolean };

function clock(request: Request): Clock | string {
  const real = { now: new Date(), onlyBooking: null, onlyUser: null, scoped: false };
  const at = request.headers.get("x-test-now");
  if (!getConfig().schedulerTestClock || at === null) return real;
  const now = new Date(at);
  if (Number.isNaN(now.getTime())) return "x-test-now must be a date";
  const onlyBooking = request.headers.get("x-test-booking");
  const onlyUser = request.headers.get("x-test-user");
  if (!onlyBooking && !onlyUser) return "x-test-now needs x-test-booking or x-test-user";
  if ([onlyBooking, onlyUser].some((id) => id !== null && !uuidPattern.test(id))) return "x-test-booking and x-test-user must be uuids";
  return { now, onlyBooking, onlyUser, scoped: true };
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (cause) {
    console.error(`scheduler: ${name}`, cause);
    return { error: "failed" };
  }
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const c = clock(request);
  if (typeof c === "string") return Response.json({ error: c }, { status: 400 });
  const forBooking = !c.scoped || c.onlyBooking !== null;

  const jobs = forBooking ? await step("jobs", () => runJobs({ now: c.now, onlyBooking: c.onlyBooking })) : null;
  const mails = forBooking ? await step("mails", () => retryDueMails({ now: c.now, onlyBooking: c.onlyBooking })) : null;
  const calendar = !c.scoped || c.onlyUser !== null ? await step("calendar", () => calendarUpkeep({ now: c.now, onlyUser: c.onlyUser })) : null;
  const webhooks = forBooking ? await step("webhooks", () => dispatchOutbox({ now: c.now, onlyBooking: c.onlyBooking })) : null;
  return Response.json({ jobs, mails, calendar, webhooks });
}
