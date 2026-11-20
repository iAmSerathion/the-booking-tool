import { headers } from "next/headers";
import { getConfig } from "@/lib/config";
import { createAdminSupabase } from "@/lib/db/admin";
import { hashClient } from "./token";

// Rate limit for the public booking actions: BOOKING_ATTEMPTS_PER_MINUTE per client (default 10). Server code only.

// The client address, only from a proxy the instance trusts (TRUST_PROXY_HEADERS=true): the rightmost X-Forwarded-For
// hop, which that proxy appended; hops further left are whatever the client sent. Server actions see no socket address,
// so without a trusted proxy every invitee shares one bucket ("direct"): safe, but one busy client slows everyone down.
export function clientKey(list: Headers, trustProxyHeaders: boolean): string {
  if (!trustProxyHeaders) return "direct";
  const hops = (list.get("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops.at(-1) ?? "direct";
}

// Counts this attempt. Fails closed: a database error counts as over the limit.
export async function withinLimit(): Promise<boolean> {
  const config = getConfig();
  const { data, error } = await createAdminSupabase().rpc("booking_attempt", {
    p_ip_hash: hashClient(clientKey(await headers(), config.trustProxyHeaders), config.schedulerSecret),
    p_limit: config.bookingAttemptsPerMinute,
  });
  return !error && data === true;
}
