import { expect, test } from "vitest";
import {
  type SpendTeam,
  teamSpendCube,
  teamSpendKpis,
} from "./team-spend-data";

test("team chart totals exclude ancestor rollup duplication and preserve zero teams, model splits and subscription values", () => {
  const base: SpendTeam = {
    teamId: "parent",
    teamName: "Parent",
    parentId: null,
    memberCount: 3,
    directSpend: 0,
    descendantSpend: 12,
    requests: 0,
    tokens: 0,
    subscriptionValue: 0,
    unpricedRequests: 0,
    models: [],
  };
  const usage = {
    requests: 2,
    tokens: 100,
    billedSpend: 12,
    subscriptionValue: 8,
    unpricedRequests: 1,
  };
  const child: SpendTeam = {
    ...base,
    teamId: "child",
    teamName: "Child",
    parentId: "parent",
    directSpend: 12,
    descendantSpend: 0,
    requests: 2,
    tokens: 100,
    subscriptionValue: 8,
    unpricedRequests: 1,
    models: [
      {
        model: "example",
        provider: "openai",
        ...usage,
        timeSeries: [{ timestamp: "2026-11-01T00:00:00Z", ...usage }],
      },
    ],
  };
  const teams = [base, child];
  const cube = teamSpendCube(teams, "billed", "30d");
  expect(cube.total).toBe(12);
  expect(cube.rows).toHaveLength(2);
  expect(cube.rows[0]).toMatchObject({
    key: "child",
    total: 12,
    series: [12],
    sub: "3 members · Parent: Parent",
  });
  expect(cube.rows[1]).toMatchObject({
    key: "parent",
    total: 0,
    extras: { descendants: 12, includingDescendants: 12 },
  });
  expect(cube.splitKeys[0].total).toBe(12);
  expect(teamSpendCube(teams, "subscription", "30d").total).toBe(8);
  expect(teamSpendKpis(teams, false).billed.value).toBe(12);
});
