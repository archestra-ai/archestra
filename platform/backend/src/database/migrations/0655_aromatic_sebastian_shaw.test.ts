// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migration = fs.readFileSync(
  path.join(__dirname, "0655_aromatic_sebastian_shaw.sql"),
  "utf8",
);

/** The migration's role rewrite; the test database already has its columns. */
async function migrate() {
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.includes("organization_role")) {
      await db.execute(sql.raw(statement));
    }
  }
}

async function rolePermission(id: string) {
  const [role] = await db
    .select({ permission: schema.organizationRolesTable.permission })
    .from(schema.organizationRolesTable)
    .where(eq(schema.organizationRolesTable.id, id));
  return JSON.parse(role.permission) as Record<string, string[]>;
}

describe("moving Guardrails and client connections off log", () => {
  test("custom roles keep the Guardrails records and connections they saw", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    // Roles saved before this migration still name `guardrailsYell`.
    const legacy = (permission: Record<string, string[]>) =>
      makeCustomRole(org.id, { permission });
    const logReader = await legacy({
      log: ["read"],
      guardrailsYell: ["read"],
      agent: ["read"],
    });
    const logAdmin = await legacy({
      log: ["read", "admin"],
      guardrailsYell: ["read", "admin"],
      member: ["read"],
    });
    const logAdminWithoutMembers = await legacy({ log: ["read", "admin"] });
    const yellsOnly = await legacy({ guardrailsYell: ["read", "admin"] });
    const withoutLogs = await legacy({
      agent: ["read"],
      log: [],
      guardrailsYell: [],
    });

    await migrate();

    expect(await rolePermission(logReader.id)).toEqual({
      log: ["read"],
      agent: ["read"],
      guardrailsLog: ["read"],
      clientConnection: ["read"],
    });
    expect(await rolePermission(logAdmin.id)).toEqual({
      log: ["read", "admin"],
      member: ["read"],
      guardrailsLog: ["admin", "read"],
      clientConnection: ["admin", "read"],
    });
    // The connection log and Adoption also needed member:read.
    expect(await rolePermission(logAdminWithoutMembers.id)).toEqual({
      log: ["read", "admin"],
      guardrailsLog: ["admin", "read"],
      clientConnection: ["read"],
    });
    expect(await rolePermission(yellsOnly.id)).toEqual({
      guardrailsLog: ["admin", "read"],
    });
    expect(await rolePermission(withoutLogs.id)).toEqual({
      agent: ["read"],
      log: [],
    });

    // Running it again changes nothing.
    const before = await rolePermission(logAdmin.id);
    await migrate();
    expect(await rolePermission(logAdmin.id)).toEqual(before);
  });
});
