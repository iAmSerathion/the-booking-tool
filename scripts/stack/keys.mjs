// Prints a fresh local JWT secret and the anon and service_role keys signed with it (HS256), as shell assignments.
// Local test stack only: the secret is random per `npm run stack:up`, so nothing secret lives in the repo.
import { createHmac, randomBytes } from "node:crypto";

const secret = randomBytes(32).toString("hex");
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const sign = (role) => {
  const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase-local", role, iat: 1767225600, exp: 4102444800 })}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
};

console.log(`JWT_SECRET=${secret}`);
console.log(`ANON_KEY=${sign("anon")}`);
console.log(`SERVICE_ROLE_KEY=${sign("service_role")}`);
