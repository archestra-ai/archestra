// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { ROLE_RETIREMENT_STATEMENTS } from "./resource-permissions-cutover";

/** Only the role half, so the fixtures stay about roles. */
async function runMigration() {
  await db.transaction(async (tx) => {
    for (const statement of ROLE_RETIREMENT_STATEMENTS)
      await tx.execute(statement);
  });
}

describe("scoped RBAC final cutover", () => {
  test("an Editor model grant edit survives a restart without revision churn", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const key = {
      organizationId: org.id,
      resource: "llmModel" as const,
      scope: "*",
    };
    const original = await ResourcePermissionPolicyModel.find(key);
    const edited = await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: original?.revision ?? 0,
      grants: [
        {
          subject: { type: "role", id: "editor" },
          actions: ["read", "delete"],
        },
        { subject: { type: "user", id: user.id }, actions: ["use"] },
      ],
    });
    const unrelatedKey = {
      organizationId: org.id,
      resource: "agent" as const,
      scope: "*",
    };
    const unrelated = await ResourcePermissionPolicyModel.find(unrelatedKey);
    await runMigration();
    const result = await ResourcePermissionPolicyModel.find(key);
    expect(result).toEqual(edited);
    expect(await ResourcePermissionPolicyModel.find(unrelatedKey)).toEqual(
      unrelated,
    );
    await runMigration();
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(result);
  });

  test("retires only converted resource flags, preserving role identity, ordinary actions, and unrelated resource permissions", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const role = await makeCustomRole(org.id, {
      permission: {
        agent: ["read", "admin", "update", "team-admin"],
        mcpGateway: ["team-admin"],
        mcpRegistry: ["admin", "create"],
        skill: ["read", "team-admin"],
        app: ["admin", "delete"],
        // Converted alongside the six: its admin action became a grant.
        knowledgeSource: ["admin", "read", "team-admin"],
        project: ["admin", "read"],
        log: ["read", "admin"],
        // Never carried an admin action, so it must come through untouched.
        toolPolicy: ["read", "create", "update"],
      },
    });
    await runMigration();
    const [row] = await db
      .select()
      .from(schema.organizationRolesTable)
      .where(eq(schema.organizationRolesTable.id, role.id));
    expect(row.id).toBe(role.id);
    expect(row.role).toBe(role.role);
    expect(JSON.parse(row.permission)).toEqual({
      agent: ["read", "update"],
      mcpGateway: [],
      mcpRegistry: ["create"],
      skill: ["read"],
      app: ["delete"],
      knowledgeSource: ["read"],
      project: ["read"],
      log: ["read"],
      toolPolicy: ["read", "create", "update"],
    });
    await runMigration();
    const [replayed] = await db
      .select()
      .from(schema.organizationRolesTable)
      .where(eq(schema.organizationRolesTable.id, role.id));
    expect(replayed).toEqual(row);
  });

  test("rolls back role grants and retirement when a later statement fails", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const role = await makeCustomRole(org.id, {
      permission: { project: ["read", "admin"] },
    });
    const key = {
      organizationId: org.id,
      resource: "project" as const,
      scope: "*",
    };
    const initial = await ResourcePermissionPolicyModel.find(key);
    await expect(
      db.transaction(async (tx) => {
        // The whole conversion runs in one transaction, so a later failure
        // must leave the earlier statements with nothing written.
        for (const statement of ROLE_RETIREMENT_STATEMENTS)
          await tx.execute(statement);
        throw new Error("simulated later cutover failure");
      }),
    ).rejects.toThrow("simulated later cutover failure");
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(initial);
    const [rolledBackRole] = await db
      .select({ permission: schema.organizationRolesTable.permission })
      .from(schema.organizationRolesTable)
      .where(eq(schema.organizationRolesTable.id, role.id));
    expect(JSON.parse(rolledBackRole.permission).project).toContain("admin");
    await runMigration();
    expect(
      (await ResourcePermissionPolicyModel.find(key))?.grants.some(
        (grant) => grant.subject.id === role.id,
      ),
    ).toBe(true);
    const [retiredRole] = await db
      .select({ permission: schema.organizationRolesTable.permission })
      .from(schema.organizationRolesTable)
      .where(eq(schema.organizationRolesTable.id, role.id));
    expect(JSON.parse(retiredRole.permission).project).toEqual(["read"]);
  });

  /**
   * The one shape the deploy conversion cannot carry across unchanged.
   *
   * `deploy-to-restricted` discriminated on the kind of object deployed, so a
   * role could be allowed to put an agent in a restricted environment while
   * being refused an MCP server there. `environment:use` discriminates on the
   * environment instead, and there is no room in a policy key for both axes.
   * A partial holder therefore comes out of the conversion able to deploy
   * anything into a restricted environment. This test exists to make that
   * widening deliberate and visible rather than a surprise in production.
   */
  test("a role holding deploy-to-restricted on one resource gains use on every environment", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const partial = await makeCustomRole(org.id, {
      permission: { agent: ["read", "deploy-to-restricted"] },
    });

    await runMigration();

    const policy = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource: "environment",
      scope: "*",
    });
    expect(
      policy?.grants.find(
        (grant) =>
          grant.subject.type === "role" && grant.subject.id === partial.id,
      )?.actions,
    ).toEqual(["read", "use"]);

    // And the role action it replaces is gone, so nothing reads it twice.
    const [row] = await db
      .select({ permission: schema.organizationRolesTable.permission })
      .from(schema.organizationRolesTable)
      .where(eq(schema.organizationRolesTable.id, partial.id));
    expect(JSON.parse(row.permission).agent).toEqual(["read"]);
  });

  /** Replaying must not touch a policy whose grants already match. */
  test("the deploy conversion replays without revision churn", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const key = {
      organizationId: org.id,
      resource: "environment" as const,
      scope: "*",
    };
    await runMigration();
    const first = await ResourcePermissionPolicyModel.find(key);
    await runMigration();
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(first);
  });
});
