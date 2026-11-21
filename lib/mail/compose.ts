// Mail bodies as paragraphs of lines: a missing value gives a null line, which is dropped (no Meet link, no Meet line).
// The same lines become the plain text and a simple HTML version. Everything is escaped, and only the URLs the caller
// passes as trusted links (its own APP_URL links, the Meet link) become <a> elements, so text an invitee typed (name,
// topic, answers, reason) can never become markup or a link, even when it contains a URL. Pure.

export type Paragraph = (string | null | undefined | false)[];

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Only http(s) URLs that exactly match a trusted link, on already escaped text: a quote inside the match is &quot; and
// cannot end the href attribute.
const linkify = (escaped: string, trusted: Set<string>) =>
  escaped.replace(/https?:\/\/[^\s<]+/g, (url) => (trusted.has(url) ? `<a href="${url}">${url}</a>` : url));

export function composeMail(paragraphs: Paragraph[], links: string[] = []): { text: string; html: string } {
  const kept = paragraphs.map((p) => p.filter((line): line is string => typeof line === "string" && line !== "")).filter((p) => p.length);
  const text = kept.map((p) => p.join("\n")).join("\n\n");
  const trusted = new Set(links.map(escapeHtml));
  const body = kept.map((p) => `<p>${p.map((line) => linkify(escapeHtml(line), trusted).replace(/\n/g, "<br>")).join("<br>")}</p>`).join("\n");
  return { text, html: `<div style="font-family: sans-serif; font-size: 15px; line-height: 1.5; color: #222">\n${body}\n</div>` };
}

// Subjects carry invitee names: no line breaks, so nothing can pose as another header.
export const oneLine = (text: string) => text.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
