import { GITHUB_COPILOT_ORGANIZATION_LABEL } from "@archestra/shared";

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
 * How every picker and the Model Providers card name a connected plan:
 * "Github Copilot acme", after its GitHub organization. Without a known
 * organization, the plan's own name.
 */
export function organizationSubscriptionName(
  key: OrganizationSubscriptionKey,
): string {
  if (key.githubOrganization) {
    return `${ORGANIZATION_PLAN_NAME_PREFIX} ${key.githubOrganization}`;
  }
  return key.name?.trim() || GITHUB_COPILOT_ORGANIZATION_LABEL;
}

/** "Billed to acme on GitHub". */
export function organizationSubscriptionSubtitle(
  key: OrganizationSubscriptionKey,
): string {
  return `Billed to ${key.githubOrganization ?? "the organization"} on GitHub`;
}

/**
 * "Github Copilot acme" or "Personal sign-in", for the logs. A plan is named
 * as in every picker.
 */
export function copilotCredentialSourceLabel(
  source:
    | { kind: "organization"; organization: string | null }
    | { kind: "personal" },
): string {
  return source.kind === "organization"
    ? organizationSubscriptionName({ githubOrganization: source.organization })
    : "Personal sign-in";
}

const ORGANIZATION_PLAN_NAME_PREFIX = "Github Copilot";
