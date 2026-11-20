import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55432/postgres",
  max: 10,
});

export type Client = pg.PoolClient;

// Runs fn in a transaction that is always rolled back, so tests leave no rows behind.
export async function rollback<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

// Switches the transaction to the given Supabase role, like PostgREST does for a request.
export async function actAs(client: Client, role: "anon" | "authenticated" | "service_role", userId?: string) {
  const claims = JSON.stringify({ role, ...(userId ? { sub: userId } : {}) });
  await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
  // The bare Postgres image still has the old auth.uid() that reads request.jwt.claim.sub; GoTrue replaces it.
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
  await client.query(`set local role ${role}`);
}

// Creates an auth user directly in auth.users. Needs the postgres role.
export async function createAuthUser(client: Client, email: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, '{}', '{}', now(), now())
     returning id`,
    [email],
  );
  return rows[0].id;
}
