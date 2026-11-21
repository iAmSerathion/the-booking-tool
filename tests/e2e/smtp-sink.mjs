// Test-only SMTP sink for the e2e tests: accepts every mail on 127.0.0.1 (E2E_SMTP_PORT, the app's SMTP_URL) and keeps
// it in memory. Tests read the mails to one address with GET /messages?to=<address> on 127.0.0.1 (E2E_SMTP_HTTP_PORT);
// each test uses its own example.com addresses, so parallel tests never see each other's mails. Playwright starts it.
import { createServer } from "node:http";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";

const smtpPort = Number(process.env.E2E_SMTP_PORT ?? 2525);
const httpPort = Number(process.env.E2E_SMTP_HTTP_PORT ?? 2526);
const messages = [];

const smtp = new SMTPServer({
  authOptional: true,
  // Plain SMTP on loopback: no certificate to manage, and nodemailer would otherwise try STARTTLS.
  disabledCommands: ["STARTTLS", "AUTH"],
  logger: false,
  size: 1024 * 1024,
  async onData(stream, session, callback) {
    try {
      const mail = await simpleParser(stream);
      messages.push({
        envelopeTo: session.envelope.rcptTo.map((r) => r.address.toLowerCase()),
        from: mail.from?.text ?? null,
        replyTo: mail.replyTo?.text ?? null,
        subject: mail.subject ?? "",
        text: mail.text ?? "",
        html: typeof mail.html === "string" ? mail.html : "",
        attachments: mail.attachments.map((a) => a.contentType),
      });
      if (messages.length > 5000) messages.shift();
      callback();
    } catch (error) {
      callback(error);
    }
  },
});
smtp.listen(smtpPort, "127.0.0.1");

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") return res.end("ok");
  if (url.pathname === "/messages") {
    const to = (url.searchParams.get("to") ?? "").toLowerCase();
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(to ? messages.filter((m) => m.envelopeTo.includes(to)) : []));
  }
  res.statusCode = 404;
  res.end();
}).listen(httpPort, "127.0.0.1");
