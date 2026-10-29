import { UserModel } from "@/models";

/** Match existing sign-in identities before provisioning from a Teams address. */
export async function resolveMSTeamsUserEmail(identity: {
  email?: string | null;
  userPrincipalName?: string | null;
}): Promise<string | null> {
  const email = identity.email?.trim().toLowerCase() || null;
  const upn = identity.userPrincipalName?.trim().toLowerCase() || null;
  // Entra SSO commonly maps preferred_username (the UPN), while Teams also
  // supplies mail. Prefer that sign-in identity when both accounts exist.
  for (const candidate of new Set([upn, email])) {
    if (!candidate) continue;
    const user = await UserModel.findByEmail(candidate);
    if (user) return user.email;
  }
  // Keep the existing mail-based address for genuinely new users.
  return email ?? upn;
}
