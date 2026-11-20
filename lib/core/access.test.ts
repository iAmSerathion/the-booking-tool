import { describe, expect, it } from "vitest";
import { type AccessInput, decideAccess } from "./access";

const base: AccessInput = {
  email: "jane@example.com",
  hostedDomain: null,
  profile: null,
  allowedDomains: [],
  initialAdminEmail: null,
  hasActiveAdmin: true,
};

describe("decideAccess", () => {
  it("lets active members in, with or without a Workspace domain", () => {
    expect(decideAccess({ ...base, profile: { active: true } })).toBe("ok");
    expect(decideAccess({ ...base, profile: { active: true }, hostedDomain: "other.example.org" })).toBe("ok");
  });

  it("keeps deactivated members out, even from an allowed domain or as the initial admin", () => {
    const inactive = { ...base, profile: { active: false } };
    expect(decideAccess(inactive)).toBe("refuse");
    expect(decideAccess({ ...inactive, hostedDomain: "example.com", allowedDomains: ["example.com"] })).toBe("refuse");
    expect(decideAccess({ ...inactive, initialAdminEmail: base.email, hasActiveAdmin: false })).toBe("refuse");
  });

  it("is invite-only when no domains are allowed", () => {
    expect(decideAccess(base)).toBe("refuse");
    expect(decideAccess({ ...base, hostedDomain: "example.com" })).toBe("refuse");
  });

  it("creates members from an allowed Workspace domain only", () => {
    const allowed = { ...base, allowedDomains: ["example.com", "example.org"] };
    expect(decideAccess({ ...allowed, hostedDomain: "example.org" })).toBe("create-member");
    expect(decideAccess({ ...allowed, hostedDomain: "example.net" })).toBe("refuse");
    // A consumer account with a company address has no hd claim.
    expect(decideAccess(allowed)).toBe("refuse");
  });

  it("creates the initial admin only while there is no active admin", () => {
    const initial = { ...base, initialAdminEmail: base.email };
    expect(decideAccess({ ...initial, hasActiveAdmin: false })).toBe("create-admin");
    expect(decideAccess(initial)).toBe("refuse");
    expect(decideAccess({ ...initial, initialAdminEmail: "someone@example.com", hasActiveAdmin: false })).toBe("refuse");
    // Once an admin exists, the initial admin is treated like anyone else.
    expect(decideAccess({ ...initial, hostedDomain: "example.com", allowedDomains: ["example.com"] })).toBe("create-member");
  });
});
