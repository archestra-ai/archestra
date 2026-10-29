// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";

const migration = fs.readFileSync(
  path.join(__dirname, "0501_openappa-rbac.sql"),
  "utf8",
);

async function permissions(id: string) {
  const [role] = await db
    .select()
    .from(schema.organizationRolesTable)
    .where(eq(schema.organizationRolesTable.id, id));
  return JSON.parse(role.permission);
}

test("splits legacy permissions independently and retains other resources on repeated runs", async ({
  makeOrganization,
  makeCustomRole,
}) => {
  const org = await makeOrganization();
  const reader = await makeCustomRole(org.id, {
    permission: { toolPolicy: ["read"], log: ["read"], agent: ["read"] },
  });
  const writer = await makeCustomRole(org.id, {
    permission: { toolPolicy: ["update"], organization: ["update"] },
  });
  const legacyAdmin = await makeCustomRole(org.id, {
    permission: { log: ["read", "admin"] },
  });
  const unrelated = await makeCustomRole(org.id, {
    permission: { agent: ["read"] },
  });
  await db.execute(sql.raw(migration));
  const first = await permissions(reader.id);
  await db.execute(sql.raw(migration));
  expect(await permissions(reader.id)).toEqual(first);
  expect(first).toEqual({
    toolPolicy: ["read"],
    log: ["read"],
    agent: ["read"],
    openappaPolicy: ["read"],
    openappaSettings: ["read"],
    openappaDiagnostics: ["read"],
  });
  expect(await permissions(writer.id)).toMatchObject({
    openappaPolicy: ["update"],
    openappaSettings: ["update"],
    openappaDiagnostics: ["update"],
  });
  expect((await permissions(legacyAdmin.id)).openappaDiagnostics).toEqual([
    "admin",
    "read",
  ]);
  expect((await permissions(unrelated.id)).openappaDiagnostics).toEqual([]);
});

test("preserves scoped log authority only for the matching organization and immutable role ID", async ({
  makeOrganization,
  makeCustomRole,
}) => {
  const org = await makeOrganization();
  const otherOrg = await makeOrganization();
  const role = await makeCustomRole(org.id, {
    role: "consult_reviewer",
    permission: { log: ["read"] },
  });
  const sameName = await makeCustomRole(otherOrg.id, {
    role: role.role,
    permission: { log: ["read"] },
  });
  const ownOnly = await makeCustomRole(org.id, {
    permission: { log: ["read"] },
  });
  const existing = await makeCustomRole(org.id, {
    permission: { openappaDiagnostics: ["update"] },
  });
  // Seed the upgrade boundary directly, before the new permission vocabulary exists.
  await db
    .insert(schema.resourcePermissionPoliciesTable)
    .values({
      organizationId: org.id,
      resource: "log",
      scope: "*",
      grants: [{ subject: { type: "role", id: role.id }, actions: ["read"] }],
    })
    .onConflictDoUpdate({
      target: [
        schema.resourcePermissionPoliciesTable.organizationId,
        schema.resourcePermissionPoliciesTable.resource,
        schema.resourcePermissionPoliciesTable.scope,
      ],
      set: {
        grants: [{ subject: { type: "role", id: role.id }, actions: ["read"] }],
      },
    });
  await db.execute(sql.raw(migration));
  expect((await permissions(role.id)).openappaDiagnostics).toEqual([
    "admin",
    "read",
  ]);
  expect((await permissions(sameName.id)).openappaDiagnostics).toEqual([
    "read",
  ]);
  expect((await permissions(ownOnly.id)).openappaDiagnostics).toEqual(["read"]);
  expect((await permissions(existing.id)).openappaDiagnostics).toEqual([
    "update",
  ]);
});
