/**
 * Display helpers for an organization subscription: GitHub Copilot paid by a
 * GitHub organization through a GitHub App key. Pickers list it in its own
 * "Organization subscriptions" group, apart from personal sign-ins and
 * provider API keys.
 */
interface OrganizationSubscriptionKey {
  isGithubAppKey?: boolean;
  githubOrganization?: string | null;
}

export const ORGANIZATION_SUBSCRIPTIONS_HEADING = "Organization subscriptions";

export function isOrganizationSubscription(
  key: OrganizationSubscriptionKey,
): boolean {
  return key.isGithubAppKey === true;
}

/** "GitHub Copilot · acme". */
export function organizationSubscriptionName(
  key: OrganizationSubscriptionKey,
): string {
  return `GitHub Copilot · ${key.githubOrganization ?? "organization"}`;
}

/** "Billed to acme on GitHub". */
export function organizationSubscriptionSubtitle(
  key: OrganizationSubscriptionKey,
): string {
  return `Billed to ${key.githubOrganization ?? "the organization"} on GitHub`;
}

/** "Organization subscription · acme" or "Personal sign-in", for the logs. */
export function copilotCredentialSourceLabel(
  source:
    | { kind: "organization"; organization: string | null }
    | { kind: "personal" },
): string {
  return source.kind === "organization"
    ? `Organization subscription · ${source.organization ?? "unknown organization"}`
    : "Personal sign-in";
}
