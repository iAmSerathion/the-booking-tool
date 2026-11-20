import de from "@/messages/de.json";
import en from "@/messages/en.json";
import type { Locale } from "@/lib/config";

export type MessageKey = keyof typeof en;

export const messages: Record<Locale, Record<MessageKey, string>> = { de, en };

// Fills {name} placeholders; an unknown placeholder stays visible so a missing value is easy to spot.
export function t(locale: Locale, key: MessageKey, values: Record<string, string | number> = {}): string {
  const text = messages[locale][key] ?? messages.en[key];
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}
