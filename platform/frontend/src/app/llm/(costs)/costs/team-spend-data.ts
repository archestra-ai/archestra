import type { archestraApiTypes, StatisticsTimeFrame } from "@archestra/shared";
import { formatCost, formatInt } from "./cost-explorer.query";
import {
  assemble,
  type Cube,
  type Fact,
  type MetricId,
} from "./cost-explorer-data";

export type SpendTeam = archestraApiTypes.GetTeamSpendResponses[200][number];

/** Only the server-authorized payer rows enter this cube or its headline totals. */
export function teamSpendCube(
  teams: SpendTeam[],
  metric: MetricId,
  timeframe: StatisticsTimeFrame,
  includePeople = false,
): Cube {
  const field =
    metric === "billed"
      ? "billedSpend"
      : metric === "subscription"
        ? "subscriptionValue"
        : metric === "tokens"
          ? "tokens"
          : "requests";
  const breakdown = (team: SpendTeam) =>
    includePeople
      ? (team.people ?? []).map((person) => ({
          ...person,
          key: JSON.stringify([person.kind, person.personId]),
          label:
            person.kind === "service_account"
              ? `${person.personName} · Service account`
              : person.personName,
        }))
      : team.models.map((model) => ({
          ...model,
          key: JSON.stringify([model.model, model.provider]),
          label: `${model.model} · ${model.provider}`,
        }));
  const meta = new Map<string, Omit<Fact, "b" | "v">>();
  const totals = new Map<string, number>();
  const teamsById = new Map(teams.map((team) => [team.teamId, team]));
  const facts = teams.flatMap((team) => {
    const parent = team.parentId ? teamsById.get(team.parentId) : undefined;
    const group = {
      g: team.teamId,
      gLabel: team.teamName,
      gSub: `${team.memberCount} ${team.memberCount === 1 ? "member" : "members"}${parent ? ` · Parent: ${parent.teamName}` : ""}`,
    };
    meta.set(team.teamId, group);
    totals.set(
      team.teamId,
      metric === "billed"
        ? team.directSpend
        : metric === "subscription"
          ? team.subscriptionValue
          : metric === "tokens"
            ? team.tokens
            : team.requests,
    );
    return breakdown(team).flatMap((item) => {
      const split = { ...group, s: item.key, sLabel: item.label };
      return item.timeSeries.length
        ? item.timeSeries.map((point) => ({
            ...split,
            b: point.timestamp,
            v: point[field],
          }))
        : [{ ...split, b: "", v: item[field] }];
    });
  });
  const cube = assemble(facts, { meta, totals });
  for (const row of cube.rows) {
    const team = teamsById.get(row.key);
    if (team)
      row.extras = {
        descendants: team.descendantSpend,
        includingDescendants: team.directSpend + team.descendantSpend,
        unpriced: team.unpricedRequests,
      };
  }
  return {
    ...cube,
    isLoading: false,
    retry: () => {},
    api: `GET /api/statistics/team-spend?timeframe=${encodeURIComponent(String(timeframe))}${includePeople ? "&includePeople=true" : ""}`,
    extraCols: [
      ...(metric === "billed"
        ? [
            {
              id: "descendants",
              label: "Descendant spend",
              format: formatCost,
            },
            {
              id: "includingDescendants",
              label: "Including descendants",
              format: formatCost,
            },
          ]
        : []),
      { id: "unpriced", label: "Unpriced requests", format: formatInt },
    ],
  };
}

export function teamSpendKpis(teams: SpendTeam[], pending: boolean) {
  const value = (
    key: "directSpend" | "subscriptionValue" | "requests" | "tokens",
  ) => ({
    value: teams.reduce((n, t) => n + t[key], 0),
    series: [] as number[],
  });
  return {
    billed: value("directSpend"),
    subscription: value("subscriptionValue"),
    requests: value("requests"),
    tokens: value("tokens"),
    people: { value: teams.length },
    isCostPending: pending,
    isUsagePending: pending,
    isPeoplePending: pending,
  };
}
