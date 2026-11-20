import { headers } from "next/headers";
import { getConfig } from "@/lib/config";
import { createAdminSupabase } from "@/lib/db/admin";
import { hashClient } from "./token";

// Rate limit for the public booking actions. Server code only.
//
// With a trusted proxy (TRUST_PROXY_HEADERS=true) a client is its address: BOOKING_ATTEMPTS_PER_MINUTE per address
// (default 10). Server actions see no socket address, so without a trusted proxy there is no trustworthy client
// identity. Then one shared bucket would let a single script lock every invitee out, so the limit is per invitee
// email, with a global ceiling GLOBAL_FACTOR times higher that only protects Google and the database from a flood.
// shortcut: a flood of many different emails can still reach the ceiling; set TRUST_PROXY_HEADERS behind a proxy.
const GLOBAL_FACTOR = 20;

// The client address, only from a proxy the instance trusts: the rightmost X-Forwarded-For hop, which that proxy
// appended; hops further left are whatever the client sent. Null when there is none.
export function clientAddress(list: Headers, trustProxyHeaders: boolean): string | null {
  if (!trustProxyHeaders) return null;
  const hops = (list.get("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops.at(-1) ?? null;
}

// The buckets one attempt counts against, each with its limit per minute.
export function limitBuckets(address: string | null, email: unknown, limit: number): { key: string; limit: number }[] {
  if (address) return [{ key: `ip:${address}`, limit }];
  const normalised = (typeof email === "string" ? email : "").trim().toLowerCase().slice(0, 254);
  return [
    { key: `email:${normalised}`, limit },
    { key: "global", limit: limit * GLOBAL_FACTOR },
  ];
}

// Counts this attempt. Fails closed: a database error counts as over the limit.
export async function withinLimit(email: unknown): Promise<boolean> {
  const config = getConfig();
  const db = createAdminSupabase();
  const buckets = limitBuckets(clientAddress(await headers(), config.trustProxyHeaders), email, config.bookingAttemptsPerMinute);
  for (const { key, limit } of buckets) {
    const { data, error } = await db.rpc("booking_attempt", { p_ip_hash: hashClient(key, config.schedulerSecret), p_limit: limit });
    if (error || data !== true) return false;
  }
  return true;
}
