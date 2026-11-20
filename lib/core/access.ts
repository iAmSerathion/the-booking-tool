// Who may use the app after signing in with Google. Pure; /auth/callback gathers the inputs.
export type AccessInput = {
  email: string; // verified by Google, lowercase
  hostedDomain: string | null; // Google's "hd" claim: the Workspace domain, absent for consumer accounts
  profile: { active: boolean } | null;
  allowedDomains: string[]; // ALLOWED_GOOGLE_DOMAINS, lowercase
  initialAdminEmail: string | null; // INITIAL_ADMIN_EMAIL, lowercase
  hasActiveAdmin: boolean;
};

export type Access = "ok" | "create-member" | "create-admin" | "refuse";

export function decideAccess(input: AccessInput): Access {
  // A deactivated member stays out; only an admin can bring them back.
  if (input.profile) return input.profile.active ? "ok" : "refuse";
  if (input.initialAdminEmail === input.email && !input.hasActiveAdmin) return "create-admin";
  // The hd claim, not the email domain: a consumer Google account can carry a company address (e.g. a former employee's).
  if (input.hostedDomain && input.allowedDomains.includes(input.hostedDomain)) return "create-member";
  return "refuse";
}
