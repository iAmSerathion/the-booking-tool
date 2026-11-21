// Test-only host website for the widget e2e tests: a page that loads the tool's widget.js the way an embedding site
// would, with a window button and an empty section for the widget id in ?id=. It listens on two 127.0.0.1 ports: the
// allowed one (E2E_EMBED_PORT, which test widgets list in allowed_origins) and the blocked one (E2E_EMBED_BLOCKED_PORT,
// which no widget lists). The page records the section's events in window.widgetEvents. Playwright starts it.
import { createServer } from "node:http";

const app = process.env.E2E_APP_URL ?? "http://127.0.0.1:3100";
const ports = [Number(process.env.E2E_EMBED_PORT ?? 3101), Number(process.env.E2E_EMBED_BLOCKED_PORT ?? 3102)];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Only a valid uuid ever reaches the HTML; nothing else from the request is echoed.
const page = (id) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Example host site</title>
<style>body { margin: 0; font-family: system-ui, sans-serif; } main { padding: 0 16px; } [data-booking-section] { scroll-margin-top: 16px; }</style>
<script src="${app}/widget.js" data-locale="en" defer></script>
</head>
<body>
<main>
<h1>Example host site</h1>
<p><a href="${app}/widget/${id}" data-booking-widget="${id}">Book a time</a></p>
<div data-booking-section="${id}"></div>
</main>
<script>
window.widgetEvents = [];
for (const type of ["booking-widget:booked", "booking-widget:unavailable"]) {
  document.addEventListener(type, (event) => window.widgetEvents.push({ type: event.type, detail: event.detail }));
}
</script>
</body>
</html>`;

for (const port of ports) {
  createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") return res.end("ok");
    const id = url.searchParams.get("id") ?? "";
    if (!uuid.test(id) || !/^\/[a-z/-]*$/.test(url.pathname)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page(id));
  }).listen(port, "127.0.0.1");
}
