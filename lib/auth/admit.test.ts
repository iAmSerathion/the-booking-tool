import type { SupabaseClient, User } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { admitUser } from "./admit";

// Just enough of the service-role client: two profile reads (own row, active admins) and the admit_profile rpc.
function stub(rpcError: { code: string } | null): SupabaseClient {
  const read = (result: object) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = () => Promise.resolve(result);
    chain.then = (resolve: (value: object) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  };
  let reads = 0;
  return {
    from: () => read(reads++ === 0 ? { data: null, error: null } : { count: 1, error: null }),
    rpc: () => Promise.resolve({ error: rpcError }),
  } as unknown as SupabaseClient;
}

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "new@example.com",
  identities: [{ provider: "google", identity_data: { email_verified: true, custom_claims: { hd: "example.com" } } }],
} as unknown as User;
const rules = { allowedDomains: ["example.com"], initialAdminEmail: null };

describe("admitUser when admit_profile fails", () => {
  it.each(["42501", "23505"])("treats %s as a refusal", async (code) => {
    expect(await admitUser(stub({ code }), user, rules)).toBe("stranger");
  });

  it("throws on any other error, so the callback reports a failure and keeps the user", async () => {
    await expect(admitUser(stub({ code: "57014" }), user, rules)).rejects.toMatchObject({ code: "57014" });
  });

  it("admits when admit_profile succeeds", async () => {
    expect(await admitUser(stub(null), user, rules)).toBe("in");
  });
});
