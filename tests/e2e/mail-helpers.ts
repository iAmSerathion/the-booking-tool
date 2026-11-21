import { expect } from "@playwright/test";
import { smtpHttpUrl } from "./env";

// Mails the app sent to one address, as tests/e2e/smtp-sink.mjs received them.
export type SinkMail = { envelopeTo: string[]; from: string | null; replyTo: string | null; subject: string; text: string; html: string; attachments: string[] };

export const mailsTo = async (address: string): Promise<SinkMail[]> => (await fetch(`${smtpHttpUrl}/messages?to=${encodeURIComponent(address)}`)).json();

// Mails go out in after(), so they arrive shortly after the page answered: wait until `count` are there.
export async function waitForMails(address: string, count: number): Promise<SinkMail[]> {
  await expect.poll(async () => (await mailsTo(address)).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(count);
  return mailsTo(address);
}

// The first link in a mail's text that starts with the given prefix.
export function linkIn(mail: SinkMail, prefix: string): string {
  const link = mail.text.split(/\s/).find((word) => word.startsWith(prefix));
  if (!link) throw new Error(`no link starting with ${prefix} in:\n${mail.text}`);
  return link;
}
