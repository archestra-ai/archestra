import { describe, expect, it } from "vitest";
import type { DefaultUserLimit } from "@/lib/default-user-limit.query";
import {
  ALL_ENVIRONMENTS_SCOPE,
  availableDefaultLimitScopes,
  DEFAULT_USER_LIMIT_SCOPE,
  defaultLimitDeleteDescription,
  defaultLimitEnvironmentId,
  defaultLimitNotice,
  defaultLimitScope,
  defaultLimitScopeName,
  matchesDefaultLimitFilters,
  mergeLimitRows,
} from "./default-limit-rows.utils";

describe("mergeLimitRows", () => {
  it("puts limits and default user limits in one list, oldest first", () => {
    const rows = mergeLimitRows({
      limits: [
        { id: "limit-new", createdAt: "2026-03-01T00:00:00.000Z" },
        { id: "limit-old", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      defaults: [
        defaultLimit({ id: "d1", createdAt: "2026-02-01T00:00:00.000Z" }),
      ],
    });

    expect(rows.map((row) => [row.kind, row.id])).toEqual([
      ["limit", "limit-old"],
      ["default", "default:d1"],
      ["limit", "limit-new"],
    ]);
  });

  it("keeps rows created at the same moment in a fixed order", () => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const limits = [
      { id: "b", createdAt },
      { id: "a", createdAt },
    ];

    const order = (input: typeof limits) =>
      mergeLimitRows({ limits: input, defaults: [] }).map((row) => row.id);

    expect(order(limits)).toEqual(["a", "b"]);
    expect(order([...limits].reverse())).toEqual(["a", "b"]);
  });

  it("gives a default an id no limit can have", () => {
    const rows = mergeLimitRows({
      limits: [{ id: "same", createdAt: "2026-01-01T00:00:00.000Z" }],
      defaults: [defaultLimit({ id: "same" })],
    });

    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });
});

describe("matchesDefaultLimitFilters", () => {
  it("shows a default when no filter is set", () => {
    expect(matchesDefaultLimitFilters(defaultLimit(), noFilters)).toBe(true);
  });

  it("hides it under a usage status, which it does not have", () => {
    expect(
      matchesDefaultLimitFilters(defaultLimit(), {
        ...noFilters,
        status: "danger",
      }),
    ).toBe(false);
  });

  it("counts as a spend limit", () => {
    const matches = (units: string) =>
      matchesDefaultLimitFilters(defaultLimit(), { ...noFilters, units });

    expect(matches("token_cost")).toBe(true);
    expect(matches("tokens")).toBe(false);
    expect(matches("requests")).toBe(false);
  });

  it("is found under its own applied-to choice only", () => {
    const matches = (appliedTo: string) =>
      matchesDefaultLimitFilters(defaultLimit(), { ...noFilters, appliedTo });

    expect(matches(DEFAULT_USER_LIMIT_SCOPE)).toBe(true);
    expect(matches("user")).toBe(false);
    expect(matches("environment")).toBe(false);
  });

  it("follows the model filter like any limit", () => {
    const matches = (model: string[] | null) =>
      matchesDefaultLimitFilters(defaultLimit({ model }), {
        ...noFilters,
        model: "gpt-5",
      });

    expect(matches(null)).toBe(true);
    expect(matches(["gpt-5", "claude"])).toBe(true);
    expect(matches(["claude"])).toBe(false);
  });

  it("has no labels and no entity to match", () => {
    expect(
      matchesDefaultLimitFilters(defaultLimit(), {
        ...noFilters,
        hasLabelFilter: true,
      }),
    ).toBe(false);
    expect(
      matchesDefaultLimitFilters(defaultLimit(), {
        ...noFilters,
        appliedTo: DEFAULT_USER_LIMIT_SCOPE,
        entityId: "env-1",
      }),
    ).toBe(false);
  });
});

describe("availableDefaultLimitScopes", () => {
  it("offers all environments first, then each environment", () => {
    expect(availableDefaultLimitScopes({ defaults: [], environments })).toEqual(
      [
        { value: ALL_ENVIRONMENTS_SCOPE, label: "All environments" },
        { value: "env-prod", label: "Production" },
        { value: "env-staging", label: "Staging" },
      ],
    );
  });

  it("leaves out every scope that already has a default", () => {
    expect(
      availableDefaultLimitScopes({
        defaults: [
          defaultLimit({ id: "d1", environmentId: null }),
          defaultLimit({ id: "d2", environmentId: "env-prod" }),
        ],
        environments,
      }),
    ).toEqual([{ value: "env-staging", label: "Staging" }]);
  });

  it("offers an environment even when there is no organization default", () => {
    expect(
      availableDefaultLimitScopes({
        defaults: [defaultLimit({ environmentId: "env-prod" })],
        environments,
      }).map((scope) => scope.value),
    ).toEqual([ALL_ENVIRONMENTS_SCOPE, "env-staging"]);
  });

  it("is empty once everything is set", () => {
    expect(
      availableDefaultLimitScopes({
        defaults: [defaultLimit({ environmentId: null })],
        environments: [],
      }),
    ).toEqual([]);
  });
});

describe("default limit scope", () => {
  it("maps the organization default to and from the picker's value", () => {
    expect(defaultLimitScope({ environmentId: null })).toBe(
      ALL_ENVIRONMENTS_SCOPE,
    );
    expect(defaultLimitEnvironmentId(ALL_ENVIRONMENTS_SCOPE)).toBeNull();
  });

  it("keeps an environment id as it is", () => {
    expect(defaultLimitScope({ environmentId: "env-prod" })).toBe("env-prod");
    expect(defaultLimitEnvironmentId("env-prod")).toBe("env-prod");
  });

  it("names a default after its scope", () => {
    expect(defaultLimitScopeName({ environmentId: null }, environments)).toBe(
      "All environments",
    );
    expect(
      defaultLimitScopeName({ environmentId: "env-prod" }, environments),
    ).toBe("Production");
    expect(
      defaultLimitScopeName({ environmentId: "env-gone" }, environments),
    ).toBe("Unknown environment");
  });
});

describe("defaultLimitNotice", () => {
  it("says who the organization-wide default reaches", () => {
    expect(
      defaultLimitNotice({
        scope: ALL_ENVIRONMENTS_SCOPE,
        environmentName: undefined,
        organizationDefaultAmount: undefined,
      }),
    ).toBe(
      "Every user gets this spend limit, unless a default user limit for their environment or a custom user limit applies to them.",
    );
  });

  it("names the amount an environment default replaces", () => {
    expect(
      defaultLimitNotice({
        scope: "env-prod",
        environmentName: "Production",
        organizationDefaultAmount: "$50",
      }),
    ).toBe(
      "Users in Production get this limit instead of the $50 default user limit.",
    );
  });

  it("says the rest have no default when there is no organization default", () => {
    expect(
      defaultLimitNotice({
        scope: "",
        environmentName: undefined,
        organizationDefaultAmount: undefined,
      }),
    ).toBe(
      "Users in the environment you pick get this limit. Users in other environments have no default user limit.",
    );
  });
});

describe("defaultLimitDeleteDescription", () => {
  it("warns that the organization default leaves users without a limit", () => {
    expect(
      defaultLimitDeleteDescription({
        target: { environmentId: null },
        environmentName: "All environments",
        organizationDefaultAmount: "$50",
      }),
    ).toBe(
      "Users without a default user limit for their environment or a custom limit will have no spend limit.",
    );
  });

  it("says what an environment's users fall back to", () => {
    const describeDelete = (organizationDefaultAmount: string | undefined) =>
      defaultLimitDeleteDescription({
        target: { environmentId: "env-prod" },
        environmentName: "Production",
        organizationDefaultAmount,
      });

    expect(describeDelete("$50")).toBe(
      "Users in Production will get the $50 default user limit instead.",
    );
    expect(describeDelete(undefined)).toBe(
      "Users in Production will have no default user limit.",
    );
  });
});

// ===
// Helpers

const environments = [
  { id: "env-prod", name: "Production" },
  { id: "env-staging", name: "Staging" },
];

const noFilters = {
  status: "all",
  units: "all",
  appliedTo: "all",
  entityId: null,
  model: "all",
  hasLabelFilter: false,
};

function defaultLimit(overrides: Partial<DefaultUserLimit> = {}) {
  return {
    id: "default-1",
    organizationId: "org-1",
    environmentId: null,
    limitValue: 50,
    model: null,
    cleanupInterval: "calendar_month",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } satisfies DefaultUserLimit;
}
