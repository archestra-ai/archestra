import { describe, expect, it } from "vitest";
import { nestLimits } from "./nest-limits";

type TestLimit = {
  id: string;
  entity: string;
  parents: string[];
  limitValue: number;
  cleanupInterval: string;
  allModels?: boolean;
};

const nest = (limits: TestLimit[]) =>
  nestLimits({
    limits,
    entityKeyOf: (limit) => limit.entity,
    parentKeysOf: (limit) => limit.parents,
    prefersAsParent: (limit) => limit.allModels === true,
  }).map(({ limit, depth, allocation }) => ({
    id: limit.id,
    depth,
    allocation,
  }));

const org: TestLimit = {
  id: "org",
  entity: "organization",
  parents: [],
  limitValue: 2500,
  cleanupInterval: "calendar_month",
};
const team: TestLimit = {
  id: "team",
  entity: "team:platform",
  parents: ["organization"],
  limitValue: 800,
  cleanupInterval: "calendar_month",
};
const key = (id: string, limitValue: number, cleanupInterval: string) => ({
  id,
  entity: `virtual_key:${id}`,
  parents: ["team:platform", "organization"],
  limitValue,
  cleanupInterval,
});

describe("nestLimits", () => {
  it("nests keys under their billing team and the team under the organization", () => {
    expect(
      nest([key("k1", 250, "calendar_month"), team, org]).map(
        ({ id, depth }) => [id, depth],
      ),
    ).toEqual([
      ["org", 0],
      ["team", 1],
      ["k1", 2],
    ]);
  });

  it("sums only the children's caps that reset on the parent's period", () => {
    const rows = nest([
      org,
      team,
      key("k1", 250, "calendar_month"),
      key("k2", 200, "calendar_month"),
      key("k3", 500, "calendar_week"),
    ]);

    expect(rows.find((row) => row.id === "team")?.allocation).toEqual({
      total: 450,
      count: 2,
      otherPeriodCount: 1,
    });
    expect(rows.find((row) => row.id === "k1")?.allocation).toBeNull();
  });

  it("falls back to the next parent when the nearest one has no limit", () => {
    const rows = nest([org, key("k1", 250, "calendar_month")]);

    expect(rows.map(({ id, depth }) => [id, depth])).toEqual([
      ["org", 0],
      ["k1", 1],
    ]);
  });

  it("nests under an entity's all-models limit rather than a model-specific one", () => {
    const modelTeam = { ...team, id: "team-model" };
    const allModelsTeam = { ...team, id: "team-all", allModels: true };
    const rows = nest([
      modelTeam,
      allModelsTeam,
      key("k1", 250, "calendar_month"),
    ]);

    expect(rows.map(({ id, depth }) => [id, depth])).toEqual([
      ["team-model", 0],
      ["team-all", 0],
      ["k1", 1],
    ]);
  });
});
