import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanInvite, inviteError, reservedSlugs, slugError, slugFromName } from "./team";

describe("slugs", () => {
  it("keeps the reserved list in sync with profiles_slug_check", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/20261201000100_base.sql", import.meta.url), "utf8");
    const list = /slug not in \(([^)]*)\)/.exec(sql)![1];
    expect([...list.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...reservedSlugs]);
  });

  it("makes a slug from a name", () => {
    expect(slugFromName("Ada Lovelace-Byron")).toBe("ada-lovelace-byron");
    expect(slugFromName("  Jürgen Groß ")).toBe("juergen-gross");
    expect(slugFromName("José Ñúñez!")).toBe("jose-nunez");
    expect(slugFromName("---")).toBe("");
    expect(slugFromName("a ".repeat(40))).toHaveLength(59);
  });

  it("refuses empty, long, malformed and reserved slugs", () => {
    expect(slugError("ada-l")).toBeNull();
    expect(slugError("")).toBe("Enter a link name.");
    expect(slugError("a".repeat(61))).toBe("A link name has at most 60 characters.");
    expect(slugError("a".repeat(60))).toBeNull();
    expect(slugError("Ada")).toBe("A link name uses only lowercase letters, digits and dashes.");
    expect(slugError("ada lovelace")).toBe("A link name uses only lowercase letters, digits and dashes.");
    expect(slugError("login")).toBe('"login" is reserved for the app. Choose another link name.');
  });
});

describe("invites", () => {
  const input = (fields: Record<string, string>) => cleanInvite({ name: "Ada Lovelace", email: "Ada@Example.com", ...fields });

  it("cleans the input and suggests a slug from the name", () => {
    expect(input({ is_admin: "on" })).toEqual({ name: "Ada Lovelace", email: "ada@example.com", slug: "ada-lovelace", isAdmin: true, bookable: false });
    expect(input({ slug: " Ada ", bookable: "on" })).toMatchObject({ slug: "ada", isAdmin: false, bookable: true });
  });

  it("checks name, email, the hosted domain and the slug", () => {
    expect(inviteError(input({}), null)).toBeNull();
    expect(inviteError(input({ name: " " }), null)).toBe("Enter a name.");
    expect(inviteError(input({ email: "ada@" }), null)).toBe("Enter the email address of their Google account.");
    expect(inviteError(input({ slug: "login" }), null)).toBe('"login" is reserved for the app. Choose another link name.');
    expect(inviteError(input({}), "example.com")).toBeNull();
    expect(inviteError(input({ email: "ada@example.org" }), "example.com")).toBe("This instance only signs in accounts from example.com.");
  });
});
