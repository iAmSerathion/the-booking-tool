import { createHash, createHmac, randomBytes } from "node:crypto";

// Tokens in invitee links (confirmation now; reschedule and cancel in M5): 256 random bits, stored only as a SHA-256 hash.
// No salt or key: the token itself is high-entropy, and a key would break every sent link when it changes. Server code only.

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

// 64 hex characters, the shape bookings.token_hash and booking_links.token_hash expect.
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Only characters newToken produces and a sane length; anything else is not looked up at all.
export function plausibleToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(token);
}

// The rate limit key of a client address. Keyed with an instance secret, so the stored hashes cannot be reversed by
// hashing all IPv4 addresses. Rows live an hour, so a changed secret costs nothing.
export function hashClient(client: string, secret: string): string {
  return createHmac("sha256", secret).update(`booking-attempt:${client}`).digest("hex");
}
