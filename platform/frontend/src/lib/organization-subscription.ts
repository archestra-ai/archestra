import { GITHUB_COPILOT_ORGANIZATION_LABEL } from "@archestra/shared";

/**
 * Display helpers for an organization subscription: GitHub Copilot paid by a
 * GitHub organization through a GitHub App key. Pickers list it in its own
 * "Enterprise plans" group, apart from personal sign-ins and
 * provider API keys.
 */
interface OrganizationSubscriptionKey {
  isGithubAppKey?: boolean;
  /** The GitHub organization's login, as in its GitHub address. */
  githubOrganization?: string | null;
  /** The name GitHub shows for the organization, when known. */
  githubOrganizationName?: string | null;
}

export const ORGANIZATION_SUBSCRIPTIONS_HEADING = "Enterprise plans";

export function isOrganizationSubscription(
  key: OrganizationSubscriptionKey,
): boolean {
  return key.isGithubAppKey === true;
}

/**
 * The GitHub organization a plan is billed to, as people know it: the name
 * GitHub shows ("Acme Inc"), else its login ("acme"). Null when unknown.
 */
export function githubOrganizationLabel(
  key: OrganizationSubscriptionKey,
): string | null {
  return key.githubOrganizationName || key.githubOrganization || null;
}

/**
 * How every surface names a connected plan: the Model Providers card, the
 * pickers, Connect and the logs. "GitHub Copilot Acme Inc", after its GitHub
 * organization's name. Without a known organization, `planName`: the name set
 * under Settings → LLM → Model providers (the model provider catalog's
 * `enterprisePlanName`).
 */
export function organizationSubscriptionName(
  key: OrganizationSubscriptionKey,
  planName: string = GITHUB_COPILOT_ORGANIZATION_LABEL,
): string {
  const organization = githubOrganizationLabel(key);
  return organization
    ? `${ORGANIZATION_PLAN_NAME_PREFIX} ${organization}`
    : planName;
}

/** "Billed to Acme Inc on GitHub". */
export function organizationSubscriptionSubtitle(
  key: OrganizationSubscriptionKey,
): string {
  return `Billed to ${githubOrganizationLabel(key) ?? "the organization"} on GitHub`;
}

/**
 * "GitHub Copilot Acme Inc" or "Personal sign-in", for the logs. A plan is
 * named as in every picker.
 */
export function copilotCredentialSourceLabel(
  source:
    | {
        kind: "organization";
        organization: string | null;
        organizationName?: string | null;
      }
    | { kind: "personal" },
  planName?: string,
): string {
  return source.kind === "organization"
    ? organizationSubscriptionName(
        {
          githubOrganization: source.organization,
          githubOrganizationName: source.organizationName,
        },
        planName,
      )
    : "Personal sign-in";
}

const ORGANIZATION_PLAN_NAME_PREFIX = "GitHub Copilot";
