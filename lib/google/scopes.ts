// What the calendar connection asks Google for. Sign-in itself goes through Supabase and asks for nothing extra.

// "email" must stay: calendar_connections.account_email comes from the id_token.
export const identityScopes = ["openid", "email", "profile"] as const;
export const calendarScope = "https://www.googleapis.com/auth/calendar";

// Google reports granted scopes as one space-separated string; the consent screen lets people untick some.
export function grantedScopes(scope: string | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter(Boolean);
}

// The scopes to store after a connect, or null when the calendar scope was not granted.
export function scopesAfterConnect(granted: readonly string[]): string[] | null {
  return granted.includes(calendarScope) ? [calendarScope] : null;
}
