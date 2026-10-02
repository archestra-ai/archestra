import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0505_simplify-role-permissions.sql"),
  "utf-8",
);

describe("retired manage-deleted permission migration", () => {
  test("removes every retired grant across organizations without adding delete or changing other actions", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const roles = await Promise.all([
      makeCustomRole(org.id, {
        permission: {
          mcpRegistry: ["read", "manage-deleted", "update", "manage-deleted"],
          mcpServerInstallation: ["manage-deleted"],
          agent: ["delete", "read"],
        },
      }),
      makeCustomRole(otherOrg.id, {
        permission: {
          mcpServerInstallation: ["delete", "manage-deleted"],
          futureResource: ["manage-deleted", "future-action"],
        },
      }),
      makeCustomRole(org.id, {
        permission: { agent: ["read"], mcpRegistry: [] },
      }),
      makeCustomRole(org.id, { permission: {} }),
    ]);
    const before = await db.select().from(schema.organizationRolesTable);
    await db.execute(sql.raw(migrationSql));
    const expected = [
      {
        mcpRegistry: ["read", "update"],
        mcpServerInstallation: [],
        agent: ["delete", "read"],
      },
      { mcpServerInstallation: ["delete"], futureResource: ["future-action"] },
      { agent: ["read"], mcpRegistry: [] },
      {},
    ];
    for (const [index, role] of roles.entries()) {
      const [stored] = await db
        .select()
        .from(schema.organizationRolesTable)
        .where(eq(schema.organizationRolesTable.id, role.id));
      expect(JSON.parse(stored.permission)).toEqual(expected[index]);
      expect({ ...stored, permission: undefined }).toEqual({
        ...before.find((row) => row.id === role.id),
        permission: undefined,
      });
      if (index >= 2)
        expect(stored.permission).toBe(
          before.find((row) => row.id === role.id)?.permission,
        );
    }
    const once = await db.select().from(schema.organizationRolesTable);
    await db.execute(sql.raw(migrationSql));
    expect(await db.select().from(schema.organizationRolesTable)).toEqual(once);
  });
});
