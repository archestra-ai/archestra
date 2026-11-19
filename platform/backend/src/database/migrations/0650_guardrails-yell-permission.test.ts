// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migration = fs.readFileSync(
  path.join(__dirname, "0650_guardrails-yell-permission.sql"),
  "utf8",
);

async function migrate() {
  await db.execute(sql.raw(migration));
}

async function rolePermission(id: string) {
  const [role] = await db
    .select({ permission: schema.organizationRolesTable.permission })
    .from(schema.organizationRolesTable)
    .where(eq(schema.organizationRolesTable.id, id));
  return JSON.parse(role.permission) as Record<string, string[]>;
}

describe("moving yells from log to guardrailsYell", () => {
  test("custom roles keep the yells their log actions showed", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const reader = await makeCustomRole(org.id, {
      permission: { log: ["read"], agent: ["read"] },
    });
    const admin = await makeCustomRole(org.id, {
      permission: { log: ["read", "admin"] },
    });
    const adminOnly = await makeCustomRole(org.id, {
      permission: { log: ["admin"] },
    });
    const withoutLogs = await makeCustomRole(org.id, {
      permission: { agent: ["read"], log: [] },
    });
    const alreadyGranted = await makeCustomRole(org.id, {
      permission: { log: ["read"], guardrailsYell: ["admin"] },
    });

    await migrate();

    expect(await rolePermission(reader.id)).toEqual({
      log: ["read"],
      agent: ["read"],
      guardrailsYell: ["read"],
    });
    expect(await rolePermission(admin.id)).toEqual({
      log: ["read", "admin"],
      guardrailsYell: ["admin", "read"],
    });
    expect(await rolePermission(adminOnly.id)).toEqual({
      log: ["admin"],
      guardrailsYell: ["admin"],
    });
    expect(await rolePermission(withoutLogs.id)).toEqual({
      agent: ["read"],
      log: [],
    });
    expect(await rolePermission(alreadyGranted.id)).toEqual({
      log: ["read"],
      guardrailsYell: ["admin", "read"],
    });

    // Running it again changes nothing.
    const before = await rolePermission(admin.id);
    await migrate();
    expect(await rolePermission(admin.id)).toEqual(before);
  });
});
