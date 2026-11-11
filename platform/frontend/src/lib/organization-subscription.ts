import { GITHUB_COPILOT_ORGANIZATION_LABEL } from "@archestra/shared";

/**
 * Display helpers for an organization subscription: GitHub Copilot paid by a
 * GitHub organization through a GitHub App key. Pickers list it in its own
 * "Enterprise plans" group, apart from personal sign-ins and
 * provider API keys.
 */
interface OrganizationSubscriptionKey {
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
 * How every surface names a connected plan: the Model Providers card, the
 * pickers, Connect and the logs. "GitHub Copilot acme", after its GitHub
 * organization. Without a known organization, `planName`: the name set under
 * Settings → LLM → Model providers (the model provider catalog's
 * `enterprisePlanName`).
 */
export function organizationSubscriptionName(
  key: OrganizationSubscriptionKey,
  planName: string = GITHUB_COPILOT_ORGANIZATION_LABEL,
): string {
  return key.githubOrganization
    ? `${ORGANIZATION_PLAN_NAME_PREFIX} ${key.githubOrganization}`
    : planName;
}

/** "Billed to acme on GitHub". */
export function organizationSubscriptionSubtitle(
  key: OrganizationSubscriptionKey,
): string {
  return `Billed to ${key.githubOrganization ?? "the organization"} on GitHub`;
}

/**
 * "GitHub Copilot acme" or "Personal sign-in", for the logs. A plan is named
 * as in every picker.
 */
export function copilotCredentialSourceLabel(
  source:
    | { kind: "organization"; organization: string | null }
    | { kind: "personal" },
  planName?: string,
): string {
  return source.kind === "organization"
    ? organizationSubscriptionName(
        { githubOrganization: source.organization },
        planName,
      )
    : "Personal sign-in";
}

const ORGANIZATION_PLAN_NAME_PREFIX = "GitHub Copilot";
