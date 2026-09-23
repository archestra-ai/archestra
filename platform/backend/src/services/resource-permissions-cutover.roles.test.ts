// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { eq } from "drizzle-orm";
import { isAgentTypeAdmin } from "@/auth/agent-type-permissions";
import { isMcpInstallationAdmin } from "@/auth/mcp-catalog-permissions";
import { userHasPermission } from "@/auth/utils";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { ResourcePermissions } from "./resource-permissions";
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

  test("strips project:read-all and project:share-org from stored roles, turning read-all into a read grant on every chat", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const reader = await makeCustomRole(org.id, {
      permission: { project: ["read", "create", "read-all", "share-org"] },
    });
    const sharer = await makeCustomRole(org.id, {
      permission: { project: ["read", "share-org"] },
    });
    await runMigration();
    const permissionOf = async (id: string) => {
      const [row] = await db
        .select({ permission: schema.organizationRolesTable.permission })
        .from(schema.organizationRolesTable)
        .where(eq(schema.organizationRolesTable.id, id));
      return JSON.parse(row.permission);
    };
    expect(await permissionOf(reader.id)).toEqual({
      project: ["read", "create"],
    });
    expect(await permissionOf(sharer.id)).toEqual({ project: ["read"] });
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource: "conversation",
      scope: "*",
    });
    // share-org converts to nothing; read-all to `read` on every chat, next to
    // the built-in admin-tier roles that held it in code.
    expect(policy?.grants).toEqual(
      expect.arrayContaining([
        { subject: { type: "role", id: reader.id }, actions: ["read"] },
        {
          subject: { type: "role", id: "admin" },
          actions: ["manage-permissions", "read"],
        },
        {
          subject: { type: "role", id: "platform_admin" },
          actions: ["manage-permissions", "read"],
        },
      ]),
    );
    expect(policy?.grants.some((grant) => grant.subject.id === sharer.id)).toBe(
      false,
    );
    const revision = policy?.revision;
    await runMigration();
    expect(
      (
        await ResourcePermissionPolicyModel.find({
          organizationId: org.id,
          resource: "conversation",
          scope: "*",
        })
      )?.revision,
    ).toBe(revision);
  });

  test("a role still storing a retired action gains nothing from it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    // Written as if saved before the actions were retired and before any
    // cutover ran: the checks read grants, so the stored flags confer nothing.
    const org = await makeOrganization();
    const role = await makeCustomRole(org.id, {
      permission: {
        agent: ["read", "admin", "team-admin"],
        plugin: ["read", "create", "admin"],
        mcpServerInstallation: ["read", "admin"],
        log: ["read", "admin"],
        project: ["read", "admin", "read-all", "share-org"],
      },
    });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: role.role });
    const context = { userId: user.id, organizationId: org.id };
    expect(await isAgentTypeAdmin({ ...context, agentType: "agent" })).toBe(
      false,
    );
    expect(await isMcpInstallationAdmin(context)).toBe(false);
    for (const [resource, action] of [
      ["plugin", "update"],
      ["log", "read"],
      ["project", "update"],
      ["conversation", "read"],
    ] as const)
      expect(
        await ResourcePermissions.allows({
          ...context,
          resource,
          scope: "*",
          action,
        }),
      ).toBe(false);
    expect(await userHasPermission(user.id, org.id, "plugin", "read")).toBe(
      true,
    );
  });
});
