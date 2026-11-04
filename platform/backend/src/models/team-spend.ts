import {
  getStatisticsBucketIntervalMinutes,
  type StatisticsTimeFrame,
} from "@archestra/shared";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { TeamSpend } from "@/types/team-spend";
import { interactionBelongsToOrganization } from "./log-organization";
import StatisticsModel, {
  billedModel,
  billingModelFacts,
  billingReceiptJoin,
  modelBilledCost,
  modelReportedTokens,
  modelRequests,
  modelSubscriptionCost,
} from "./statistics";

/** Payer attribution only. Membership and resource sharing never rewrite payer history. */
export default class TeamSpendModel {
  static async get(params: {
    organizationId: string;
    teamIds?: string[];
    timeframe: StatisticsTimeFrame;
    includePeople?: boolean;
  }): Promise<TeamSpend[]> {
    const {
      organizationId,
      teamIds,
      timeframe,
      includePeople = false,
    } = params;
    if (teamIds?.length === 0) return [];
    const t = schema.teamsTable;
    const i = schema.interactionsTable;
    const members = db
      .select({
        teamId: schema.teamMembersTable.teamId,
        count: sql<number>`COUNT(*)::int`.as("member_count"),
      })
      .from(schema.teamMembersTable)
      .groupBy(schema.teamMembersTable.teamId)
      .as("member_counts");
    const teams = await db
      .select({
        teamId: t.id,
        teamName: t.name,
        parentId: t.parentId,
        memberCount: sql<number>`COALESCE(${members.count}, 0)::int`,
      })
      .from(t)
      .leftJoin(members, eq(members.teamId, t.id))
      .where(
        and(
          eq(t.organizationId, organizationId),
          teamIds ? inArray(t.id, teamIds) : undefined,
        ),
      )
      .orderBy(t.name);
    if (!teams.length) return [];
    const visibleIds = new Set(teams.map((t) => t.teamId));
    const provider = sql<string>`split_part(${i.type}, ':', 1)`;
    const model = sql<string>`COALESCE(${billedModel}, 'Unknown model')`;
    const u = schema.usersTable;
    const sa = schema.serviceAccountsTable;
    // Only the route-authorized person view groups or returns identities.
    // Service principals take precedence; deleted/unknown identities stay in totals.
    const personId = includePeople
      ? sql<
          string | null
        >`CASE WHEN ${sa.id} IS NOT NULL THEN ${sa.id}::text WHEN ${i.serviceAccountId} IS NULL THEN ${u.id} ELSE NULL END`
      : sql<null>`NULL::text`;
    const personName = includePeople
      ? sql<string>`CASE WHEN ${sa.id} IS NOT NULL THEN ${sa.name} WHEN ${i.serviceAccountId} IS NULL AND ${u.id} IS NOT NULL THEN ${u.name} ELSE 'Unattributed' END`
      : sql<string>`'Unattributed'::text`;
    const personKind = includePeople
      ? sql<
          "person" | "service_account" | "unattributed"
        >`CASE WHEN ${sa.id} IS NOT NULL THEN 'service_account' WHEN ${i.serviceAccountId} IS NULL AND ${u.id} IS NOT NULL THEN 'person' ELSE 'unattributed' END`
      : sql<"unattributed">`'unattributed'::text`;
    const seconds = sql.raw(
      String(getStatisticsBucketIntervalMinutes(timeframe) * 60),
    );
    const timestamp =
      timeframe === "all"
        ? sql<string>`to_char(date_trunc('month', ${i.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`
        : sql<string>`to_char(to_timestamp(floor(extract(epoch from ${i.createdAt}) / ${seconds}) * ${seconds}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
    const rows = await db
      .select({
        teamId: i.billingTeamId,
        model,
        provider,
        timestamp,
        personId,
        personName,
        personKind,
        requests: modelRequests,
        tokens: sql<number>`(${modelReportedTokens})::double precision`,
        billedSpend: modelBilledCost,
        subscriptionValue: modelSubscriptionCost,
        unpricedRequests: sql<number>`COUNT(*) FILTER (WHERE ${i.cost} IS NULL AND (billing_model.model IS NULL OR billing_model.parent_request))::int`,
      })
      .from(i)
      .leftJoin(schema.interactionBillingTable, billingReceiptJoin)
      .leftJoin(billingModelFacts, sql`true`)
      .leftJoin(u, includePeople ? eq(u.id, i.userId) : sql`false`)
      .leftJoin(
        sa,
        includePeople
          ? and(
              eq(sa.id, i.serviceAccountId),
              eq(sa.organizationId, organizationId),
            )
          : sql`false`,
      )
      .where(
        and(
          or(
            interactionBelongsToOrganization(organizationId),
            and(
              isNull(i.profileId),
              isNull(i.appId),
              isNull(i.connectorId),
              eq(schema.interactionBillingTable.organizationId, organizationId),
            ),
          ),
          inArray(i.billingTeamId, [...visibleIds]),
          ...StatisticsModel.timeframeConditions(timeframe),
        ),
      )
      .groupBy(
        i.billingTeamId,
        model,
        provider,
        timestamp,
        personId,
        personName,
        personKind,
      );
    const result: TeamSpend[] = teams.map((team) => {
      const grouped = new Map<string, TeamSpend["models"][number]>();
      const people = new Map<
        string,
        NonNullable<TeamSpend["people"]>[number]
      >();
      for (const row of rows.filter((r) => r.teamId === team.teamId)) {
        const key = JSON.stringify([row.model, row.provider]);
        const current = grouped.get(key) ?? {
          model: row.model,
          provider: row.provider,
          requests: 0,
          tokens: 0,
          billedSpend: 0,
          subscriptionValue: 0,
          unpricedRequests: 0,
          timeSeries: [],
        };
        addUsage(current, row);
        grouped.set(key, current);
        if (includePeople) {
          const personKey = JSON.stringify([row.personKind, row.personId]);
          const person = people.get(personKey) ?? {
            personId: row.personId,
            personName: row.personName,
            kind: row.personKind,
            requests: 0,
            tokens: 0,
            billedSpend: 0,
            subscriptionValue: 0,
            unpricedRequests: 0,
            timeSeries: [],
          };
          addUsage(person, row);
          people.set(personKey, person);
        }
      }
      const models = [...grouped.values()];
      for (const model of models)
        model.timeSeries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const persons = [...people.values()].sort(
        (a, b) => b.billedSpend - a.billedSpend,
      );
      for (const person of persons)
        person.timeSeries.sort((a, b) =>
          a.timestamp.localeCompare(b.timestamp),
        );
      return {
        ...team,
        parentId:
          team.parentId && visibleIds.has(team.parentId) ? team.parentId : null,
        directSpend: costPrecision(
          models.reduce((n, r) => n + r.billedSpend, 0),
        ),
        descendantSpend: 0,
        requests: models.reduce((n, r) => n + r.requests, 0),
        tokens: models.reduce((n, r) => n + r.tokens, 0),
        subscriptionValue: costPrecision(
          models.reduce((n, r) => n + r.subscriptionValue, 0),
        ),
        unpricedRequests: models.reduce((n, r) => n + r.unpricedRequests, 0),
        models,
        ...(includePeople ? { people: persons } : {}),
      };
    });
    const byId = new Map(result.map((team) => [team.teamId, team]));
    for (const team of result) {
      const seen = new Set([team.teamId]);
      let parent = team.parentId;
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        const ancestor = byId.get(parent);
        if (!ancestor) break;
        ancestor.descendantSpend = costPrecision(
          ancestor.descendantSpend + team.directSpend,
        );
        parent = ancestor.parentId;
      }
    }
    return result;
  }
}

type Usage = Pick<
  TeamSpend["models"][number],
  | "requests"
  | "tokens"
  | "billedSpend"
  | "subscriptionValue"
  | "unpricedRequests"
>;
function addUsage(
  target: Usage & { timeSeries: (Usage & { timestamp: string })[] },
  row: Usage & { timestamp: string },
) {
  let point = target.timeSeries.find(
    (point) => point.timestamp === row.timestamp,
  );
  if (!point) {
    point = {
      timestamp: row.timestamp,
      requests: 0,
      tokens: 0,
      billedSpend: 0,
      subscriptionValue: 0,
      unpricedRequests: 0,
    };
    target.timeSeries.push(point);
  }
  for (const metric of [
    "requests",
    "tokens",
    "billedSpend",
    "subscriptionValue",
    "unpricedRequests",
  ] as const) {
    target[metric] += row[metric];
    point[metric] += row[metric];
    if (metric === "billedSpend" || metric === "subscriptionValue") {
      target[metric] = costPrecision(target[metric]);
      point[metric] = costPrecision(point[metric]);
    }
  }
}

// Match the database's 10-decimal cost precision so grouping by a different
// dimension cannot move a half-cent total across a display rounding boundary.
function costPrecision(value: number) {
  return Number(value.toFixed(10));
}
