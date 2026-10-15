// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { runScopedResourcePermissionCutover } from "@/services/resource-permissions-cutover";
import { expect, test } from "@/test";

const statements = fs
  .readFileSync(
    path.join(__dirname, "0551_remove-scheduled-task-permissions.sql"),
    "utf8",
  )
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

test("retires schedule permissions across organizations without widening Projects or changing unrelated roles", async ({
  makeOrganization,
  makeCustomRole,
}) => {
  const org = await makeOrganization();
  const otherOrg = await makeOrganization();
  const mixed = await makeCustomRole(org.id, {
    permission: {
      scheduledTask: ["read", "create", "update", "delete", "admin"],
      project: ["read"],
      chat: ["read", "create"],
    },
  });
  const scheduleOnly = await makeCustomRole(otherOrg.id, {
    permission: { scheduledTask: ["read"] },
  });
  const emptyLegacy = await makeCustomRole(otherOrg.id, {
    permission: { scheduledTask: [], agent: ["read"] },
  });
  const untouched = await makeCustomRole(org.id, {
    permission: { project: ["read", "create"], agent: ["read"] },
  });
  const roleRow = async (id: string) =>
    (
      await db
        .select()
        .from(schema.organizationRolesTable)
        .where(eq(schema.organizationRolesTable.id, id))
    )[0];
  const beforeUntouched = await roleRow(untouched.id);
  const projectKey = {
    organizationId: org.id,
    resource: "project" as const,
    scope: "*",
  };
  const beforeProject = await ResourcePermissionPolicyModel.find(projectKey);
  for (const organizationId of [org.id, otherOrg.id]) {
    await db.execute(sql`INSERT INTO resource_permission_policies (organization_id, resource, scope, grants, legacy_sharing_migrated)
      VALUES (${organizationId}, 'scheduledTask', '*', ${JSON.stringify([{ subject: { type: "role", id: mixed.id }, actions: ["read", "use", "update", "delete", "manage-permissions"] }])}::jsonb, true)`);
  }

  for (const statement of statements) await db.execute(sql.raw(statement));
  expect(JSON.parse((await roleRow(mixed.id)).permission)).toEqual({
    project: ["read"],
    chat: ["read", "create"],
  });
  expect(JSON.parse((await roleRow(scheduleOnly.id)).permission)).toEqual({});
  expect(JSON.parse((await roleRow(emptyLegacy.id)).permission)).toEqual({
    agent: ["read"],
  });
  expect(await roleRow(untouched.id)).toEqual(beforeUntouched);
  expect(await ResourcePermissionPolicyModel.find(projectKey)).toEqual(
    beforeProject,
  );
  expect(
    (
      await db.execute(
        sql`SELECT resource FROM resource_permission_policies WHERE resource = 'scheduledTask'`,
      )
    ).rows,
  ).toEqual([]);

  const first = await roleRow(mixed.id);
  for (const statement of statements) await db.execute(sql.raw(statement));
  // A restart must not recreate the retired policy from historical role flags.
  await runScopedResourcePermissionCutover();
  expect(await roleRow(mixed.id)).toEqual(first);
  expect(await ResourcePermissionPolicyModel.find(projectKey)).toEqual(
    beforeProject,
  );
  expect(
    (
      await db.execute(
        sql`SELECT resource FROM resource_permission_policies WHERE resource = 'scheduledTask'`,
      )
    ).rows,
  ).toEqual([]);
});
