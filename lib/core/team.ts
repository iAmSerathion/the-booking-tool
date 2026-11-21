import { emailPattern } from "./booking";
import { cleanText } from "./questions";

// Pure rules for the team page: booking slugs and invites. They mirror the database checks (profiles_slug_check,
// invite_profile) so admins get a clear message before the database refuses.

// The app's top-level routes. Keep in sync with profiles_slug_check in supabase/migrations/20261201000100_base.sql
// (lib/core/team.test.ts compares the two).
export const reservedSlugs = ["app", "l", "api", "auth", "login", "confirmed", "reschedule", "cancel", "widget", "privacy", "imprint"] as const;

// The public page /<slug> only resolves 1-60 characters (lib/booking/data.ts); the database has no length limit.
export const slugMaxLength = 60;

// "Ada Lovelace-Byron" -> "ada-lovelace-byron"; umlauts become ae/oe/ue, other accents are dropped.
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, slugMaxLength)
    .replace(/-+$/, "");
}

export function slugError(slug: string): string | null {
  if (!slug) return "Enter a link name.";
  if (slug.length > slugMaxLength) return `A link name has at most ${slugMaxLength} characters.`;
  if (!/^[a-z0-9-]+$/.test(slug)) return "A link name uses only lowercase letters, digits and dashes.";
  if ((reservedSlugs as readonly string[]).includes(slug)) return `"${slug}" is reserved for the app. Choose another link name.`;
  return null;
}

export type InviteInput = { name: string; email: string; slug: string; isAdmin: boolean; bookable: boolean };

// An empty slug becomes one made from the name. lowercase email, as invite_profile stores it.
export function cleanInvite(raw: Partial<Record<"name" | "email" | "slug" | "is_admin" | "bookable", unknown>>): InviteInput {
  const name = cleanText(raw.name, 200);
  const slug = cleanText(raw.slug, 200).toLowerCase();
  return {
    name,
    email: cleanText(raw.email, 254).toLowerCase(),
    slug: slug || slugFromName(name),
    isAdmin: raw.is_admin === "on",
    bookable: raw.bookable === "on",
  };
}

// No check against ALLOWED_GOOGLE_DOMAINS: an existing profile signs in regardless of domain, so inviting is exactly how
// people outside those domains get in. Only GOOGLE_HOSTED_DOMAIN limits sign-in to one Workspace, so others cannot use it.
export function inviteError(input: InviteInput, hostedDomain: string | null): string | null {
  if (!input.name) return "Enter a name.";
  if (!emailPattern.test(input.email)) return "Enter the email address of their Google account.";
  if (hostedDomain && input.email.split("@")[1] !== hostedDomain) return `This instance only signs in accounts from ${hostedDomain}.`;
  return slugError(input.slug);
}
