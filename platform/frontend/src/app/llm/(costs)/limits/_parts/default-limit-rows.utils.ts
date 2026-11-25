import type { DefaultUserLimit } from "@/lib/default-user-limit.query";

/**
 * Default user limits shown as rows of the limits table and created from the
 * same form as every other limit. They live in their own table and API, so
 * this module holds the glue: row merging, filtering, the scopes still free
 * to pick, and the texts that depend on which default is touched.
 */

/** The "Apply to" value for a default user limit. Never sent to the API. */
export const DEFAULT_USER_LIMIT_SCOPE = "default_user_limit";

/** The second picker's value for the organization-wide default. */
export const ALL_ENVIRONMENTS_SCOPE = "__all__";

const ALL_ENVIRONMENTS_LABEL = "All environments";

export type LimitTableRow<TLimit> =
  | { kind: "limit"; id: string; limit: TLimit }
  | { kind: "default"; id: string; limit: DefaultUserLimit };

type Environment = { id: string; name: string };

/** Default ids are namespaced so a row id never collides with a limit id. */
function defaultLimitRowId(id: string) {
  return `default:${id}`;
}

/**
 * One list, oldest first. Neither API promises an order the two lists share,
 * so the merged rows are sorted here; the id breaks ties so equal timestamps
 * cannot move a row between pages.
 */
export function mergeLimitRows<
  TLimit extends { id: string; createdAt: string },
>(params: {
  limits: TLimit[];
  defaults: DefaultUserLimit[];
}): LimitTableRow<TLimit>[] {
  const rows: Array<LimitTableRow<TLimit> & { at: number }> = [
    ...params.limits.map((limit) => ({
      kind: "limit" as const,
      id: limit.id,
      limit,
      at: timestamp(limit.createdAt),
    })),
    ...params.defaults.map((limit) => ({
      kind: "default" as const,
      id: defaultLimitRowId(limit.id),
      limit,
      at: timestamp(limit.createdAt),
    })),
  ];
  return rows
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .map(({ at: _at, ...row }) => row);
}

/**
 * Whether a default user limit passes the table's filters. It is a spend
 * limit with no single usage figure, no labels and no entity id.
 */
export function matchesDefaultLimitFilters(
  limit: DefaultUserLimit,
  filters: {
    status: string;
    units: string;
    appliedTo: string;
    entityId: string | null;
    model: string;
    hasLabelFilter: boolean;
  },
) {
  const models = limit.model ?? [];
  return (
    filters.status === "all" &&
    (filters.units === "all" || filters.units === "token_cost") &&
    (filters.appliedTo === "all" ||
      filters.appliedTo === DEFAULT_USER_LIMIT_SCOPE) &&
    !filters.entityId &&
    (filters.model === "all" ||
      models.length === 0 ||
      models.includes(filters.model)) &&
    !filters.hasLabelFilter
  );
}

/** The scopes with no default yet: all environments first, then each one. */
export function availableDefaultLimitScopes(params: {
  defaults: DefaultUserLimit[];
  environments: Environment[];
}): Array<{ value: string; label: string }> {
  const taken = new Set(params.defaults.map((limit) => limit.environmentId));
  return [
    ...(taken.has(null)
      ? []
      : [{ value: ALL_ENVIRONMENTS_SCOPE, label: ALL_ENVIRONMENTS_LABEL }]),
    ...params.environments
      .filter((environment) => !taken.has(environment.id))
      .map((environment) => ({
        value: environment.id,
        label: environment.name,
      })),
  ];
}

export function defaultLimitScope(
  limit: Pick<DefaultUserLimit, "environmentId">,
) {
  return limit.environmentId ?? ALL_ENVIRONMENTS_SCOPE;
}

/** The API takes null for the organization-wide default. */
export function defaultLimitEnvironmentId(scope: string) {
  return scope === ALL_ENVIRONMENTS_SCOPE ? null : scope;
}

export function defaultLimitScopeName(
  limit: Pick<DefaultUserLimit, "environmentId">,
  environments: Environment[],
) {
  if (limit.environmentId === null) return ALL_ENVIRONMENTS_LABEL;
  return (
    environments.find((environment) => environment.id === limit.environmentId)
      ?.name ?? "Unknown environment"
  );
}

/** The second line of a default's table row: who the limit is for. */
export function defaultLimitWhoIsLimited(
  limit: Pick<DefaultUserLimit, "environmentId">,
) {
  return limit.environmentId === null
    ? "Limit for every user"
    : "Limit for every user in this environment";
}

/** Who gets the limit being created or edited, for the form's notice. */
export function defaultLimitNotice(params: {
  scope: string;
  /** The picked environment's name; undefined until one is picked. */
  environmentName: string | undefined;
  /** The organization-wide default's amount, e.g. "$50". */
  organizationDefaultAmount: string | undefined;
}) {
  if (params.scope === ALL_ENVIRONMENTS_SCOPE) {
    return "Every user gets this spend limit, unless a default user limit for their environment or a custom user limit applies to them.";
  }
  const who = params.environmentName
    ? `Users in ${params.environmentName}`
    : "Users in the environment you pick";
  return params.organizationDefaultAmount
    ? `${who} get this limit instead of the ${params.organizationDefaultAmount} default user limit.`
    : `${who} get this limit. Users in other environments have no default user limit.`;
}

/** What deleting a default user limit leaves its users with. */
export function defaultLimitDeleteDescription(params: {
  target: Pick<DefaultUserLimit, "environmentId">;
  environmentName: string;
  organizationDefaultAmount: string | undefined;
}) {
  if (params.target.environmentId === null) {
    return "Users without a default user limit for their environment or a custom limit will have no spend limit.";
  }
  return params.organizationDefaultAmount
    ? `Users in ${params.environmentName} will get the ${params.organizationDefaultAmount} default user limit instead.`
    : `Users in ${params.environmentName} will have no default user limit.`;
}

// ===
// Internal helpers

function timestamp(value: string) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}
