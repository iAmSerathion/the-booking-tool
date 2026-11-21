# Webhooks

Set `WEBHOOK_URL` and `WEBHOOK_SECRET` (at least 32 characters) and every booking change is POSTed there as JSON. The
change and its event are written in one database transaction (`booking_outbox`); the scheduler sends the events.
`WEBHOOK_URL` must be https (plain http only for localhost, 127.0.0.1 or [::1]) and must not contain a username or
password.

| Event | When |
|---|---|
| `booking.created` | An invitee booked (page, person link, booking link or widget). |
| `booking.rescheduled` | The invitee moved it (`changed_by: "invitee"`) or the host moved the Google event (`"calendar"`). |
| `booking.cancelled` | The invitee cancelled or declined the invitation (`"invitee"`), the host cancelled in the admin (`"host"`) or deleted the Google event (`"calendar"`). |
| `booking.host_changed` | A deactivated member's future bookings were handed to a successor (`"admin"`, with `previous_host_id`). |

Example body (headers: `X-Webhook-Id` = `id`, `X-Webhook-Event` = `type`, `X-Signature`, `User-Agent: the-booking-tool`):

```json
{
  "id": "6f1c2a52-0d4e-4c3b-9b7a-2f0e8c1d5a10",
  "type": "booking.rescheduled",
  "created_at": "2026-12-01T09:12:44.381234+00:00",
  "booking": {
    "id": "0b8e4f3c-7a21-4d6e-8f55-1c2d3e4f5a6b",
    "state": "booked",
    "cancelled_by": null,
    "starts_at": "2026-12-03T14:00:00+00:00",
    "ends_at": "2026-12-03T14:30:00+00:00",
    "host": { "id": "c3d4e5f6-0000-4000-8000-000000000001", "name": "Avery Host", "email": "avery@example.com" },
    "attendee": { "name": "Sam Invitee", "email": "sam@example.com", "company": "Example Inc", "phone": null, "timezone": "Europe/Berlin" },
    "topic": "Pricing",
    "answers": [{ "id": "goal", "question": "What is your goal?", "answer": "Growth" }],
    "event_type": { "id": "d4e5f6a7-0000-4000-8000-000000000002", "slug": "meeting", "title": "Meeting" },
    "booked_via": "widget",
    "widget_id": "e5f6a7b8-0000-4000-8000-000000000003",
    "booking_page": "https://www.example.com/contact",
    "link": null,
    "meet_url": "https://meet.google.com/abc-defg-hij",
    "reschedule_count": 1,
    "created_at": "2026-12-01T09:00:02+00:00",
    "previous": { "starts_at": "2026-12-03T09:00:00+00:00", "ends_at": "2026-12-03T09:30:00+00:00" },
    "changed_by": "invitee"
  }
}
```

Timestamps are ISO 8601 with an offset (Postgres format, e.g. `2026-12-01T09:12:44.381234+00:00`); parse them, do not
compare them as strings. `booking` is a snapshot taken when the change happened. `link` is `{id, metadata}` for bookings made through a booking
link. Cancel events add `reason` (or null) and `changed_by`.

Verify `X-Signature` (`sha256=` + hex HMAC-SHA256 of the raw body with `WEBHOOK_SECRET`) before parsing the body:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the request body exactly as received (a Buffer or string), not re-serialized JSON.
export function verifyWebhook(rawBody, signatureHeader, secret) {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(signatureHeader ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Replay protection, after the signature check. seen: ids kept for at least 72 hours (a store shared by your instances).
// On false, answer 2xx without processing again. Call seen.add(event.id) only after you processed the event, so a
// failed attempt (your 5xx) is processed when it comes again.
export function shouldProcess(event, seen) {
  if (Date.now() - Date.parse(event.created_at) > 72 * 60 * 60 * 1000) return false;
  return !seen.has(event.id);
}
```

- **Replay protection:** the signature covers the body, which carries `id` (= `X-Webhook-Id`) and `created_at`, so a
  captured request can only be replayed unchanged. Reject events whose `created_at` is older than 72 hours and remember
  seen ids for at least 72 hours. An event's own retries span about 21 hours, but it may first wait behind older events of
  the same booking; 72 hours after creation is the hard cap for every event.

- **Delivery** counts on any 2xx answer within 10 seconds. Redirects are not followed and count as failures.
- **Retries** after 1, 5 and 30 minutes, 2, 6 and 12 hours; then the event is given up. `last_error` in
  `booking_outbox` keeps only a short reason (`http 500`, `timeout`, `network error`), never the response body.
- **Order:** a booking's next event is not sent while an older one of the same booking is still pending, so you see
  created, rescheduled and cancelled in that order. A given-up event no longer holds the next ones back.
- **At least once:** if your 2xx answer gets lost, the same event comes again with the same `X-Webhook-Id` and body.
  Dedupe by `X-Webhook-Id`.
- **Without `WEBHOOK_URL`** due events are given up (`not configured`), so turning webhooks on later does not replay the
  history. Events still pending after 72 hours are given up (`expired`).
- **Retention:** delivered and given-up events are deleted after 30 days, since they hold the invitee's personal data.

