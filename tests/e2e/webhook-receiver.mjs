// Test-only webhook receiver for the e2e tests, on 127.0.0.1 (E2E_WEBHOOK_PORT); the app's WEBHOOK_URL is POST /hook.
// It keeps every request in memory: raw body, headers and the status it answered. Tests read them with
// GET /requests?match=<booking id or attendee email>, and make the next N deliveries fail with 500 through
// POST /control/fail?count=N&match=<booking id or attendee email> (without match: any delivery). Each test matches its
// own booking or example.com invitee, so parallel tests never see each other's requests. Playwright starts it.
import { createServer } from "node:http";

const port = Number(process.env.E2E_WEBHOOK_PORT ?? 2527);
const requests = [];
// match ("" = any) -> how many more deliveries answer 500.
const failures = new Map();

const keysOf = (body) => {
  try {
    const { booking } = JSON.parse(body);
    return [String(booking?.id ?? ""), String(booking?.attendee?.email ?? "").toLowerCase()];
  } catch {
    return [];
  }
};

function takeFailure(keys) {
  for (const key of [...keys, ""]) {
    const left = failures.get(key) ?? 0;
    if (left > 0) {
      failures.set(key, left - 1);
      return true;
    }
  }
  return false;
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") return res.end("ok");
  if (url.pathname === "/requests" && req.method === "GET") {
    const match = (url.searchParams.get("match") ?? "").toLowerCase();
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(match ? requests.filter((r) => r.keys.includes(match)) : []));
  }
  if (url.pathname === "/control/fail" && req.method === "POST") {
    failures.set((url.searchParams.get("match") ?? "").toLowerCase(), Number(url.searchParams.get("count") ?? 1));
    return res.end("ok");
  }
  if (url.pathname === "/hook" && req.method === "POST") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const keys = keysOf(body);
      const status = takeFailure(keys) ? 500 : 200;
      requests.push({ at: new Date().toISOString(), headers: req.headers, body, keys, status });
      if (requests.length > 5000) requests.shift();
      res.statusCode = status;
      res.end(status === 200 ? "ok" : "receiver error");
    });
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(port, "127.0.0.1");
