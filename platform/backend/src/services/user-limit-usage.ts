import { createPaginatedResult } from "@/database/utils/pagination";
import {
  EnvironmentDefaultUserLimitModel,
  EnvironmentModel,
  LimitModel,
  MemberModel,
  UserLimitUsageResetModel,
} from "@/models";
import type {
  EnvironmentDefaultUserLimit,
  Limit,
  LimitCleanupInterval,
  UserLimitStatus,
  UserLimitUsage,
  UserLimitUsageQuery,
  UserLimitUsageSummary,
} from "@/types";
import { limitReadCleanup } from "./limit";

/**
 * Every organization member's spend against the limit that applies to them,
 * ranked by how close they are to it. Mirrors enforcement
 * (`LimitValidationService.checkDefaultUserLimit`): a hard custom per-user limit
 * wins; otherwise each environment override caps spend in its environment and
 * the organization default caps spend everywhere. Without an environment
 * filter a user is shown against whichever of those is closest to blocking
 * them.
 */
export async function listUserLimitUsage(params: {
  organizationId: string;
  query: UserLimitUsageQuery;
  now?: Date;
}) {
  const { organizationId, query } = params;
  const now = params.now ?? new Date();

  const [, defaults, environments, customLimits] = await Promise.all([
    // Custom limits are counters; reset any elapsed window before their
    // totals are read below.
    limitReadCleanup.run({
      organizationId,
      entityType: "user",
      limitType: "token_cost",
    }),
    EnvironmentDefaultUserLimitModel.findAllForOrganization(organizationId),
    EnvironmentModel.listForOrganization(organizationId),
    LimitModel.findAll("user", undefined, "token_cost", organizationId),
  ]);

  const globalDefault = defaults.find((d) => d.environmentId === null) ?? null;
  const overrides = defaults.filter((d) => d.environmentId !== null);
  const environmentNames = new Map(environments.map((e) => [e.id, e.name]));
  // Minute spend limits are throughput caps, not custom user limits (the
  // default-limit check ignores them too).
  const customByUser = groupBy(
    customLimits.filter(
      (limit) =>
        limit.cleanupInterval !== "minute" && limit.behavior !== "soft",
    ),
    (limit) => limit.entityId,
  );
  const filterOverride = query.environmentId
    ? (overrides.find((d) => d.environmentId === query.environmentId) ?? null)
    : null;

  const organizationScope = {
    models: globalDefault?.model ?? null,
    cleanupInterval: globalDefault?.cleanupInterval ?? "calendar_month",
  } as const;
  const [
    customTotals,
    organizationSpend,
    overrideSpend,
    environmentSpend,
    resets,
    environmentUsers,
  ] = await Promise.all([
    LimitModel.getTokenCostTotals(
      [...customByUser.values()].flat().map((limit) => limit.id),
    ),
    LimitModel.getDefaultUserLimitUsageByUser({
      organizationId,
      ...organizationScope,
    }),
    Promise.all(
      overrides.map(async (override) => ({
        override,
        spend: await LimitModel.getDefaultUserLimitUsageByUser({
          organizationId,
          environmentId: override.environmentId,
          models: override.model ?? null,
          cleanupInterval: override.cleanupInterval,
        }),
      })),
    ),
    // Who spent in the filtered environment, in the window of the limit that
    // governs it there.
    query.environmentId
      ? LimitModel.getDefaultUserLimitUsageByUser({
          organizationId,
          environmentId: query.environmentId,
          models: (filterOverride ?? globalDefault)?.model ?? null,
          cleanupInterval:
            (filterOverride ?? globalDefault)?.cleanupInterval ??
            "calendar_month",
        })
      : Promise.resolve(null),
    UserLimitUsageResetModel.findResets({ organizationId }),
    query.environmentId
      ? Promise.resolve(new Map<string, number>())
      : LimitModel.countUsersWithSpendByEnvironment({
          organizationId,
          cleanupInterval: organizationScope.cleanupInterval,
        }),
  ]);

  // Only members who spent this window or hold a custom limit can differ from
  // the idle row (no spend against the organization default, or no limit), so
  // only they are ranked here. Every other member is counted, and paged by name
  // from the database when a page reaches past the ranked rows.
  const rankedUserIds = new Set<string>([
    ...customByUser.keys(),
    ...organizationSpend.keys(),
    ...overrideSpend.flatMap(({ spend }) => [...spend.keys()]),
    ...(environmentSpend?.keys() ?? []),
  ]);
  const [users, memberCount] = await Promise.all([
    MemberModel.findUsersInOrganization({
      organizationId,
      userIds: [...rankedUserIds],
      search: query.search,
    }),
    // An environment filter lists only who spent there.
    query.environmentId
      ? Promise.resolve(0)
      : MemberModel.countUsersInOrganization({
          organizationId,
          search: query.search,
        }),
  ]);
  const memberIds = new Set(users.map((user) => user.userId));

  const toRow = (user: MemberUser): UserLimitUsage => {
    const base = {
      userId: user.userId,
      name: user.name,
      email: user.email,
      image: user.image,
      lastResetAt: resets.get(user.userId)?.resetAt.toISOString() ?? null,
      lastResetByName: resets.get(user.userId)?.resetByName ?? null,
    };

    const custom = customByUser.get(user.userId);
    if (custom?.length) {
      const fallback = organizationSpend.get(user.userId)?.cost ?? 0;
      return {
        ...base,
        ...closestCustomLimit({ limits: custom, totals: customTotals, now }),
        fallbackSpent: roundCents(Number.isFinite(fallback) ? fallback : 0),
      };
    }

    const candidates: Candidate[] = [];
    if (query.environmentId) {
      // The limit that applies to this user's requests in that environment.
      if (filterOverride) {
        candidates.push(
          defaultCandidate({
            limit: filterOverride,
            usage: environmentSpend?.get(user.userId),
            environmentName: environmentNames.get(query.environmentId) ?? null,
          }),
        );
      } else if (globalDefault) {
        candidates.push(
          defaultCandidate({
            limit: globalDefault,
            usage: organizationSpend.get(user.userId),
            environmentName: null,
          }),
        );
      }
    } else {
      if (globalDefault) {
        candidates.push(
          defaultCandidate({
            limit: globalDefault,
            usage: organizationSpend.get(user.userId),
            environmentName: null,
          }),
        );
      }
      for (const { override, spend } of overrideSpend) {
        const usage = spend.get(user.userId);
        if (!usage) continue;
        candidates.push(
          defaultCandidate({
            limit: override,
            usage,
            environmentName:
              environmentNames.get(override.environmentId as string) ?? null,
          }),
        );
      }
    }

    const closest = candidates.sort(byPercentDesc)[0];
    if (closest) {
      return {
        ...base,
        ...describeLimit({ ...closest, now }),
        fallbackSpent: null,
      };
    }

    const usage = (environmentSpend ?? organizationSpend).get(user.userId);
    return {
      ...base,
      source: "none",
      environmentId: null,
      environmentName: null,
      limitValue: null,
      cleanupInterval: null,
      models: null,
      spent: usage?.cost ?? 0,
      estimatedUsage: usage?.estimated ?? false,
      percent: null,
      status: "ok",
      customLimitId: null,
      customReason: null,
      resetsAt: null,
      projectedSpend: null,
      fallbackSpent: null,
    };
  };

  const rows = users
    .filter((user) => !environmentSpend || environmentSpend.has(user.userId))
    .map(toRow);
  // Members outside `rows` all look alike: no spend against the organization
  // default when there is one, otherwise no limit at all.
  const idleCount = Math.max(0, memberCount - rows.length);
  const idleSource = globalDefault ? "organization_default" : "none";

  const summary: UserLimitUsageSummary = {
    total: rows.length + idleCount,
    at: rows.filter((row) => row.status === "at").length,
    near: rows.filter((row) => row.status === "near").length,
    custom: rows.filter((row) => row.source === "custom").length,
    none:
      rows.filter((row) => row.source === "none").length +
      (idleSource === "none" ? idleCount : 0),
    organizationDefault:
      rows.filter((row) => row.source === "organization_default").length +
      (idleSource === "organization_default" ? idleCount : 0),
    environmentDefault: rows.filter(
      (row) => row.source === "environment_default",
    ).length,
    flaggedCustom: rows.filter(
      (row) => row.source === "custom" && row.status !== "ok",
    ).length,
    spent: roundCents(rows.reduce((sum, row) => sum + row.spent, 0)),
    spenders: rows.filter((row) => row.spent > 0).length,
    resetsAt: globalDefault
      ? (calendarWindow(
          globalDefault.cleanupInterval,
          now,
        )?.end.toISOString() ?? null)
      : null,
    environments: environments.map((environment) => {
      const users = environmentUsers.get(environment.id) ?? 0;
      const override = overrideSpend.find(
        (entry) => entry.override.environmentId === environment.id,
      );
      if (!override) {
        return { environmentId: environment.id, users, at: 0, near: 0 };
      }
      // Members the override governs: they spent there with no custom limit.
      const statuses = [...override.spend]
        .filter(
          ([userId]) => !customByUser.has(userId) && memberIds.has(userId),
        )
        .map(([, usage]) =>
          statusFor((usage.cost / override.override.limitValue) * 100),
        );
      return {
        environmentId: environment.id,
        users,
        at: statuses.filter((status) => status === "at").length,
        near: statuses.filter((status) => status === "near").length,
      };
    }),
  };

  const matching = rows.filter((row) => matchesStatus(row, query.status));
  const idleMatches =
    idleCount > 0 &&
    (query.status === undefined ||
      (query.status === "none" && idleSource === "none"));
  // Rows that rank like an idle member (nothing spent, same percent) sort among
  // them by name; everyone else ranks above them.
  const idlePercent = idleSource === "none" ? -1 : 0;
  const ranksAsIdle = (row: UserLimitUsage) =>
    row.spent === 0 && (row.percent ?? -1) === idlePercent;
  const ranked = matching
    .filter((row) => !ranksAsIdle(row))
    .sort(
      (a, b) =>
        (b.percent ?? -1) - (a.percent ?? -1) ||
        b.spent - a.spent ||
        a.name.localeCompare(b.name),
    );
  const idleLike = matching.filter(ranksAsIdle);

  const { limit, offset } = query;
  const pagination = { limit, offset };
  if (!idleMatches) {
    const all = [
      ...ranked,
      ...idleLike.sort((a, b) => a.name.localeCompare(b.name)),
    ];
    return {
      ...createPaginatedResult(
        all.slice(offset, offset + limit),
        all.length,
        pagination,
      ),
      summary,
    };
  }

  // The name-ordered tail is every matching member not ranked above it: idle
  // members plus `idleLike` rows. Exclude the rest, which either ranked above
  // or did not match the status filter.
  const tailRows = new Map(idleLike.map((row) => [row.userId, row]));
  const page = ranked.slice(offset, offset + limit);
  if (page.length < limit) {
    const tailUsers = await MemberModel.findUsersInOrganizationPage({
      organizationId,
      search: query.search,
      excludeUserIds: rows
        .filter((row) => !tailRows.has(row.userId))
        .map((row) => row.userId),
      limit: limit - page.length,
      offset: Math.max(0, offset - ranked.length),
    });
    page.push(
      ...tailUsers.map((user) => tailRows.get(user.userId) ?? toRow(user)),
    );
  }
  return {
    ...createPaginatedResult(
      page,
      ranked.length + idleLike.length + idleCount,
      pagination,
    ),
    summary,
  };
}

/**
 * Start a user's limit usage over from $0 now. Custom limits are counters, so
 * they are zeroed; default user limits are summed from interactions, so a
 * marker makes enforcement count only spend after now. The next scheduled
 * reset is unchanged. Returns null when the user is not in the organization.
 */
export async function resetUserLimitUsage(params: {
  organizationId: string;
  userId: string;
  resetByUserId: string;
}): Promise<{ userId: string; resetAt: string } | null> {
  const member = await MemberModel.getByUserId(
    params.userId,
    params.organizationId,
  );
  if (!member) return null;

  const customLimits = await LimitModel.findAll(
    "user",
    params.userId,
    "token_cost",
    params.organizationId,
  );
  const resetAt = new Date();
  await LimitModel.resetLimitsUsage(
    customLimits.map((limit) => limit.id),
    resetAt,
  );
  await UserLimitUsageResetModel.recordReset({
    organizationId: params.organizationId,
    userId: params.userId,
    resetByUserId: params.resetByUserId,
    resetAt,
  });
  return { userId: params.userId, resetAt: resetAt.toISOString() };
}

// ===
// Internal helpers

type Usage = { cost: number; estimated: boolean };

type Candidate = {
  source: "custom" | "environment_default" | "organization_default";
  limitValue: number;
  cleanupInterval: LimitCleanupInterval;
  models: string[] | null;
  usage: Usage;
  environmentId: string | null;
  environmentName: string | null;
  customLimitId: string | null;
  customReason: string | null;
};

type MemberUser = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
};

const NEAR_LIMIT_PERCENT = 75;

function matchesStatus(
  row: UserLimitUsage,
  status: UserLimitUsageQuery["status"],
) {
  switch (status) {
    case "at":
    case "near":
      return row.status === status;
    case "custom":
      return row.source === "custom";
    case "none":
      return row.source === "none";
    default:
      return true;
  }
}

function defaultCandidate(params: {
  limit: EnvironmentDefaultUserLimit;
  usage: Usage | undefined;
  environmentName: string | null;
}): Candidate {
  return {
    source: params.limit.environmentId
      ? "environment_default"
      : "organization_default",
    limitValue: params.limit.limitValue,
    cleanupInterval: params.limit.cleanupInterval,
    models: params.limit.model ?? null,
    usage: params.usage ?? { cost: 0, estimated: false },
    environmentId: params.limit.environmentId,
    environmentName: params.environmentName,
    customLimitId: null,
    customReason: null,
  };
}

/** A user can hold several custom limits (e.g. per model); show the tightest. */
function closestCustomLimit(params: {
  limits: Limit[];
  totals: Map<string, Usage>;
  now: Date;
}) {
  const candidates = params.limits.map(
    (limit): Candidate => ({
      source: "custom",
      limitValue: limit.limitValue,
      cleanupInterval: limit.cleanupInterval ?? "calendar_month",
      models: limit.model ?? null,
      usage: params.totals.get(limit.id) ?? { cost: 0, estimated: false },
      environmentId: null,
      environmentName: null,
      customLimitId: limit.id,
      customReason: limit.reason ?? null,
    }),
  );
  return describeLimit({
    ...candidates.sort(byPercentDesc)[0],
    now: params.now,
  });
}

function describeLimit(candidate: Candidate & { now: Date }) {
  const percent =
    candidate.limitValue > 0
      ? (candidate.usage.cost / candidate.limitValue) * 100
      : 100;
  const window = calendarWindow(candidate.cleanupInterval, candidate.now);
  const spent = roundCents(candidate.usage.cost);
  return {
    source: candidate.source,
    environmentId: candidate.environmentId,
    environmentName: candidate.environmentName,
    limitValue: candidate.limitValue,
    cleanupInterval: candidate.cleanupInterval,
    models: candidate.models,
    spent,
    estimatedUsage: candidate.usage.estimated,
    percent: Math.round(percent * 10) / 10,
    status: statusFor(percent),
    customLimitId: candidate.customLimitId,
    customReason: candidate.customReason,
    resetsAt: window?.end.toISOString() ?? null,
    projectedSpend: window
      ? projectSpend({ spent, window, now: candidate.now })
      : null,
  };
}

function byPercentDesc(a: Candidate, b: Candidate) {
  return percentOf(b) - percentOf(a);
}

function percentOf(candidate: Candidate) {
  return candidate.limitValue > 0
    ? candidate.usage.cost / candidate.limitValue
    : Number.POSITIVE_INFINITY;
}

function statusFor(percent: number): UserLimitStatus {
  if (percent >= 100) return "at";
  if (percent >= NEAR_LIMIT_PERCENT) return "near";
  return "ok";
}

/**
 * Bounds of the current window for calendar intervals, in UTC like the
 * `date_trunc` periods enforcement uses. Rolling windows have no fixed end.
 */
function calendarWindow(
  interval: LimitCleanupInterval,
  now: Date,
): { start: Date; end: Date } | null {
  const day = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const dayMs = 24 * 60 * 60 * 1000;
  switch (interval) {
    case "calendar_day":
      return { start: new Date(day), end: new Date(day + dayMs) };
    case "calendar_week_monday":
    case "calendar_week_sunday": {
      const firstDay = interval === "calendar_week_monday" ? 1 : 0;
      const sinceStart = (now.getUTCDay() - firstDay + 7) % 7;
      const start = day - sinceStart * dayMs;
      return { start: new Date(start), end: new Date(start + 7 * dayMs) };
    }
    case "calendar_month":
      return {
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
      };
    default:
      return null;
  }
}

/** Linear projection to window end; skipped in a window's first hour. */
function projectSpend(params: {
  spent: number;
  window: { start: Date; end: Date };
  now: Date;
}): number | null {
  const elapsed = params.now.getTime() - params.window.start.getTime();
  const total = params.window.end.getTime() - params.window.start.getTime();
  if (elapsed < 60 * 60 * 1000 || params.spent <= 0) return null;
  return roundCents((params.spent / elapsed) * total);
}

function roundCents(value: number) {
  return Math.round(value * 100) / 100;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(key(item)) ?? [];
    list.push(item);
    groups.set(key(item), list);
  }
  return groups;
}
