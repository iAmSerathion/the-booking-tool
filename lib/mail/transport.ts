import nodemailer, { type Transporter } from "nodemailer";
import { getConfig } from "@/lib/config";

// One SMTP transport per process, from SMTP_URL (smtp:// or smtps://, credentials in the URL). Short timeouts: a server
// that hangs must not hold a request's after() or a scheduler run; a failed attempt is retried by the scheduler.
let cached: Transporter | undefined;

export function mailTransport(): Transporter {
  return (cached ??= nodemailer.createTransport({
    url: getConfig().mail.smtpUrl,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  }));
}
