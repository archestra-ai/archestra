// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";

const statements = fs
  .readFileSync(
    path.join(__dirname, "0572_fold-openappa-rbac-resources.sql"),
    "utf8",
  )
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

test("renames the policy resource and folds diagnostics into log without granting organization-wide logs", async ({
  makeOrganization,
  makeCustomRole,
}) => {
  const org = await makeOrganization();
  const legacy = (permission: Record<string, string[]>) =>
    makeCustomRole(org.id, { permission });
  const policyEditor = await legacy({
    openappaPolicy: ["read", "update"],
    chat: ["read"],
  });
  const diagnosticsAdmin = await legacy({
    openappaDiagnostics: ["read", "update", "admin"],
  });
  const logAdmin = await legacy({
    openappaDiagnostics: ["read", "admin"],
    log: ["read", "admin"],
  });
  const updateOnly = await legacy({ openappaDiagnostics: ["update"] });
  const untouched = await makeCustomRole(org.id, {
    permission: { log: ["read"], agent: ["read"] },
  });
  const roleRow = async (id: string) =>
    (
      await db
        .select()
        .from(schema.organizationRolesTable)
        .where(eq(schema.organizationRolesTable.id, id))
    )[0];
  const permissionOf = async (id: string) =>
    JSON.parse((await roleRow(id)).permission);
  const beforeUntouched = await roleRow(untouched.id);

  for (const statement of statements) await db.execute(sql.raw(statement));

  expect(await permissionOf(policyEditor.id)).toEqual({
    guardrailsPolicy: ["read", "update"],
    chat: ["read"],
  });
  expect(await permissionOf(diagnosticsAdmin.id)).toEqual({ log: ["read"] });
  expect(await permissionOf(logAdmin.id)).toEqual({ log: ["read", "admin"] });
  expect(await permissionOf(updateOnly.id)).toEqual({});
  expect(await roleRow(untouched.id)).toEqual(beforeUntouched);

  const migrated = await roleRow(policyEditor.id);
  for (const statement of statements) await db.execute(sql.raw(statement));
  expect(await roleRow(policyEditor.id)).toEqual(migrated);
});
