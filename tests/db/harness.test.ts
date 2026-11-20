import { afterAll, expect, it } from "vitest";
import { actAs, createAuthUser, pool, rollback } from "./db";

afterAll(() => pool.end());

it("switches to an authenticated user inside a rolled-back transaction", async () => {
  const seen = await rollback(async (client) => {
    const id = await createAuthUser(client, "harness@example.com");
    await actAs(client, "authenticated", id);
    const { rows } = await client.query("select auth.uid() as uid, current_user as role");
    return { id, ...rows[0] };
  });
  expect(seen.uid).toBe(seen.id);
  expect(seen.role).toBe("authenticated");
});
