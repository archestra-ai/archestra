// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { Permissions } from "@archestra/shared";
import { describe, expect, test } from "vitest";
import { resolveLegacyResourcePermissions } from "./resource-permission-compatibility";

describe("legacy permission translation", () => {
  test("model discovery and invocation retain their distinct restriction checks", () => {
    const context = {
      ...catalogContext(),
      resource: "llmModel" as const,
      permissions: { llmModel: ["read"] } as Permissions,
      teamIds: [],
    };
    expect(actions(context)).toEqual([]);
    expect(actions({ ...context, teamIds: ["team-a"] })).toEqual([
      "read",
      "use",
    ]);
    expect(
      actions({
        ...context,
        target: { ...context.target, users: [{ id: context.userId }] },
      }),
    ).toEqual(["read"]);
    expect(
      actions({
        ...context,
        target: { ...context.target, scope: "org" },
        permissions: {},
      }),
    ).toEqual(["use"]);
    expect(actions({ ...context, scope: "*", target: null })).toEqual([]);
    expect(
      actions({
        ...context,
        scope: "*",
        target: null,
        permissions: { llmModel: ["update"] },
      }),
    ).toEqual(["use", "update", "manage-permissions"]);
  });
  test("personal resources with another or missing author remain inaccessible", () => {
    const context = catalogContext();
    for (const authorId of ["other-user", null]) {
      expect(
        actions({
          ...context,
          target: { ...context.target, scope: "personal", authorId },
        }),
      ).toEqual([]);
    }
  });
  test("catalog write applies to every team member, while use never grants editing", () => {
    const context = catalogContext();
    expect(actions(context)).toEqual([
      "read",
      "use",
      "update",
      "manage-permissions",
    ]);
    expect(actions({ ...context, teamIds: [] })).toEqual([]);
    expect(
      actions({ ...context, permissions: { mcpRegistry: ["read"] } }),
    ).toEqual(["read", "use"]);
    expect(
      actions({
        ...context,
        target: {
          ...context.target,
          teams: [{ id: "team-a", level: "use" as const }],
        },
      }),
    ).toEqual(["read", "use"]);
  });

  test("elevated scope flags do not manufacture actions missing from the role", () => {
    const context = catalogContext();
    expect(
      actions({
        ...context,
        permissions: { mcpServerInstallation: ["admin"] },
      }),
    ).toEqual([]);
    expect(
      actions({
        ...context,
        permissions: {
          mcpRegistry: ["read"],
          mcpServerInstallation: ["admin"],
        },
      }),
    ).toEqual(["read", "use"]);
    expect(
      actions({
        ...context,
        permissions: {
          mcpRegistry: ["update"],
          mcpServerInstallation: ["admin"],
        },
      }),
    ).toEqual(["update", "manage-permissions"]);
  });

  test("catalog authorship stops granting edits when the item is shared", () => {
    const context = catalogContext();
    const owned = { ...context.target, authorId: context.userId };
    expect(
      actions({ ...context, target: { ...owned, scope: "personal" } }),
    ).toEqual(["read", "use", "update", "manage-permissions", "delete"]);
    expect(actions({ ...context, target: { ...owned, scope: "org" } })).toEqual(
      ["read", "use"],
    );
    expect(
      actions({ ...context, target: { ...owned, scope: "team" } }),
    ).toEqual(["read", "use", "update", "manage-permissions"]);
  });

  test("agent team-admin requires membership and the underlying mutation action", () => {
    const context = {
      ...catalogContext(),
      resource: "agent" as const,
      permissions: { agent: ["read", "update", "team-admin"] } as Permissions,
    };
    expect(actions(context)).toEqual([
      "read",
      "use",
      "update",
      "manage-permissions",
    ]);
    expect(actions({ ...context, teamIds: [] })).toEqual([]);
    expect(
      actions({ ...context, permissions: { agent: ["read", "team-admin"] } }),
    ).toEqual(["read", "use"]);
    expect(
      actions({ ...context, target: { ...context.target, scope: "org" } }),
    ).toEqual(["read", "use"]);
  });

  test("an object-specific legacy grant cannot become wildcard authority", () => {
    const context = catalogContext();
    expect(actions({ ...context, scope: "*", target: null })).toEqual([]);
    expect(
      actions({
        ...context,
        scope: "*",
        target: null,
        permissions: {
          ...context.permissions,
          mcpServerInstallation: ["admin"],
        },
      }),
    ).toEqual(["read", "use", "update", "manage-permissions", "delete"]);
  });
});

function actions(
  params: Parameters<typeof resolveLegacyResourcePermissions>[0],
) {
  return resolveLegacyResourcePermissions(params).map((grant) => grant.action);
}

function catalogContext() {
  return {
    organizationId: "organization-a",
    userId: "reader",
    resource: "mcpRegistry" as const,
    scope: "00000000-0000-4000-8000-000000000001",
    permissions: { mcpRegistry: ["read", "update", "delete"] } as Permissions,
    teamIds: ["team-a"],
    target: {
      authorId: "author",
      scope: "team" as const,
      teams: [{ id: "team-a", level: "write" as const }],
      users: [],
    },
  };
}
