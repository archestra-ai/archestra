import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { userHasPermission } from "@/auth";
import { SERVICE_ACCOUNT_USER_ID_PREFIX } from "@/auth/service-account-user-id";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import TeamModel from "@/models/team";
import { ResourcePermissions } from "@/services/resource-permissions";
import { runScopedResourcePermissionCutover } from "@/services/resource-permissions-cutover";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0505_restore-log-role-actions.sql"),
  "utf8",
);
const migrate = () => db.execute(sql.raw(migrationSql));

describe("restore log role actions", () => {
  test("restores custom role Admin without adding Read or touching unrelated actions, and survives restarts", async ({
    makeOrganization,
    makeCustomRole,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const role = await makeCustomRole(org.id, {
      permission: {
        log: ["read"],
        agent: ["read", "update"],
        futureResource: ["future-action"],
      },
    });
    await makeMember(user.id, org.id, { role: role.role });
    for (const resource of ["log", "auditLog"] as const) {
      await ResourcePermissionPolicyModel.replace({
        organizationId: org.id,
        resource,
        scope: "*",
        revision: 0,
        grants: [{ subject: { type: "role", id: role.id }, actions: ["read"] }],
      });
    }
    await migrate();
    const [stored] = await db
      .select()
      .from(schema.organizationRolesTable)
      .where(eq(schema.organizationRolesTable.id, role.id));
    expect(JSON.parse(stored.permission)).toEqual({
      log: ["read", "admin"],
      auditLog: ["admin"],
      agent: ["read", "update"],
      futureResource: ["future-action"],
    });
    expect(await userHasPermission(user.id, org.id, "auditLog", "read")).toBe(
      false,
    );
    await runScopedResourcePermissionCutover();
    expect(await userHasPermission(user.id, org.id, "log", "admin")).toBe(true);
    expect(
      await ResourcePermissions.resolveAll({
        userId: user.id,
        organizationId: org.id,
      }),
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ resource: "log" })]),
    );
    const once = await db.select().from(schema.organizationRolesTable);
    await migrate();
    expect(await db.select().from(schema.organizationRolesTable)).toEqual(once);
    expect(
      await ResourcePermissionPolicyModel.find({
        organizationId: org.id,
        resource: "log",
        scope: "*",
      }),
    ).toBeNull();
  });

  test("preserves direct users, inherited teams, service accounts and predefined-role recipients without adding data or global-policy permissions", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeCustomRole,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const direct = await makeUser();
    const teammate = await makeUser();
    const predefined = await makeUser();
    const outsider = await makeUser();
    const reader = await makeCustomRole(org.id, {
      permission: { log: ["read"] },
    });
    await makeMember(direct.id, org.id, { role: reader.role });
    await makeMember(teammate.id, org.id, { role: reader.role });
    await makeMember(predefined.id, org.id, { role: "platform_admin" });
    await makeMember(outsider.id, otherOrg.id, { role: "platform_admin" });
    const team = await makeTeam(org.id, direct.id);
    const child = await makeTeam(org.id, direct.id, { parentId: team.id });
    await TeamModel.addMember(child.id, teammate.id);
    const account = await makeServiceAccount(org.id, { role: reader.role });
    await ResourcePermissionPolicyModel.replace({
      organizationId: org.id,
      resource: "log",
      scope: "*",
      revision: 0,
      grants: [
        { subject: { type: "user", id: direct.id }, actions: ["read"] },
        { subject: { type: "team", id: team.id }, actions: ["read"] },
        {
          subject: { type: "serviceAccount", id: account.id },
          actions: ["read"],
        },
        { subject: { type: "role", id: "platform_admin" }, actions: ["read"] },
      ],
    });
    await migrate();
    for (const actor of [
      direct.id,
      teammate.id,
      predefined.id,
      `${SERVICE_ACCOUNT_USER_ID_PREFIX}${account.id}`,
    ]) {
      expect(await userHasPermission(actor, org.id, "log", "admin")).toBe(true);
      expect(await userHasPermission(actor, org.id, "auditLog", "admin")).toBe(
        false,
      );
      // Platform Admin intentionally already has global policy controls.
      if (actor !== predefined.id)
        expect(
          await userHasPermission(actor, org.id, "globalPermissions", "update"),
        ).toBe(false);
    }
    expect(
      await userHasPermission(outsider.id, otherOrg.id, "log", "admin"),
    ).toBe(false);
    const migrated = (
      await db.select().from(schema.organizationRolesTable)
    ).filter((role) => role.role.startsWith("migrated_log_access_"));
    expect(migrated).toHaveLength(1);
    expect(JSON.parse(migrated[0].permission)).toEqual({ log: ["admin"] });
  });

  test("organization grants stay local and a policy with no Read grants cannot manufacture Admin", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    await makeMember(user.id, otherOrg.id, { role: "member" });
    await ResourcePermissionPolicyModel.replace({
      organizationId: org.id,
      resource: "auditLog",
      scope: "*",
      revision: 0,
      grants: [
        { subject: { type: "organization", id: "*" }, actions: ["read"] },
      ],
    });
    await ResourcePermissionPolicyModel.replace({
      organizationId: org.id,
      resource: "log",
      scope: "*",
      revision: 0,
      grants: [],
    });
    await migrate();
    expect(await userHasPermission(user.id, org.id, "auditLog", "admin")).toBe(
      true,
    );
    expect(await userHasPermission(user.id, org.id, "auditLog", "read")).toBe(
      false,
    );
    expect(await userHasPermission(user.id, org.id, "log", "admin")).toBe(
      false,
    );
    expect(
      await userHasPermission(user.id, otherOrg.id, "auditLog", "admin"),
    ).toBe(false);
  });
});
