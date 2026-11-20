// What /app/settings shows after Google sends the member back (?google=…). Only these keys are shown, so the query
// string cannot inject text. Admin UI, English only.
export const googleNotices = {
  cancelled: "Connecting Google Calendar was cancelled.",
  "wrong-account": "The chosen Google account does not match your sign-in email. Connect the calendar of that account.",
  "missing-scopes": "Google did not grant calendar access. Connect again and allow access to your calendar.",
  error: "Connecting Google Calendar failed. Please try again.",
} as const;

export type GoogleNotice = keyof typeof googleNotices;

export function googleNotice(value: string | string[] | undefined): string | null {
  return typeof value === "string" && Object.hasOwn(googleNotices, value) ? googleNotices[value as GoogleNotice] : null;
}
