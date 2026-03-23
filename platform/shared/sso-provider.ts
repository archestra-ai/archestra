/**
 * SSO Provider IDs - these are the canonical provider identifiers used for:
 * - Account linking (trustedProviders)
 * - Provider registration
 * - Callback URLs (e.g., /api/auth/sso/callback/{providerId})
 */
export const SSO_PROVIDER_ID = {
  OKTA: "Okta",
  GOOGLE: "Google",
  GITHUB: "GitHub",
  GITLAB: "GitLab",
  ENTRA_ID: "EntraID",
} as const;

export type SsoProviderId =
  (typeof SSO_PROVIDER_ID)[keyof typeof SSO_PROVIDER_ID];

/** List of all predefined SSO provider IDs for account linking */
export const SSO_TRUSTED_PROVIDER_IDS = Object.values(SSO_PROVIDER_ID);
