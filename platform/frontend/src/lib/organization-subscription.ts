/**
 * Display helpers for an organization subscription: GitHub Copilot paid by a
 * GitHub organization through a GitHub App key. Pickers list it in its own
 * "Enterprise plans" group, apart from personal sign-ins and
 * provider API keys.
 */
interface OrganizationSubscriptionKey {
  name?: string | null;
  isGithubAppKey?: boolean;
  githubOrganization?: string | null;
}

export const ORGANIZATION_SUBSCRIPTIONS_HEADING = "Enterprise plans";

export function isOrganizationSubscription(
  key: OrganizationSubscriptionKey,
): boolean {
  return key.isGithubAppKey === true;
}

/**
 * The plan's own name, as set when it was connected. A plan still named by
 * default reads "GitHub Copilot · acme".
 */
export function organizationSubscriptionName(
  key: OrganizationSubscriptionKey,
): string {
  const name = key.name?.trim();
  const organization = key.githubOrganization ?? "organization";
  return name && name !== `GitHub Copilot (${organization})`
    ? name
    : `GitHub Copilot · ${organization}`;
}

/** "Billed to acme on GitHub". */
export function organizationSubscriptionSubtitle(
  key: OrganizationSubscriptionKey,
): string {
  return `Billed to ${key.githubOrganization ?? "the organization"} on GitHub`;
}

/** "Enterprise plan · acme" or "Personal sign-in", for the logs. */
export function copilotCredentialSourceLabel(
  source:
    | { kind: "organization"; organization: string | null }
    | { kind: "personal" },
): string {
  return source.kind === "organization"
    ? `Enterprise plan · ${source.organization ?? "unknown organization"}`
    : "Personal sign-in";
}
