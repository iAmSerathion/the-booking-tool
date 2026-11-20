import { describe, expect, it } from "vitest";
import { hashClient, hashToken, newToken, plausibleToken } from "./token";

describe("tokens", () => {
  it("are random, plausible and hash to 64 hex characters", () => {
    const token = newToken();
    expect(token).not.toBe(newToken());
    expect(plausibleToken(token)).toBe(true);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("rejects anything newToken cannot produce", () => {
    for (const value of ["short", "a".repeat(101), "a".repeat(30) + "/", "a".repeat(30) + "=", null, 42]) expect(plausibleToken(value)).toBe(false);
  });
});

describe("hashClient", () => {
  it("depends on the client and the secret", () => {
    const secret = "s".repeat(32);
    expect(hashClient("203.0.113.7", secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashClient("203.0.113.7", secret)).toBe(hashClient("203.0.113.7", secret));
    expect(hashClient("203.0.113.8", secret)).not.toBe(hashClient("203.0.113.7", secret));
    expect(hashClient("203.0.113.7", "t".repeat(32))).not.toBe(hashClient("203.0.113.7", secret));
  });
});
