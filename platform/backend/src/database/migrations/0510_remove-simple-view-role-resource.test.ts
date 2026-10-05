import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";

const migration = fs.readFileSync(
  path.join(__dirname, "0510_remove-simple-view-role-resource.sql"),
  "utf8",
);

async function permissions(id: string) {
  const [role] = await db
    .select()
    .from(schema.organizationRolesTable)
    .where(eq(schema.organizationRolesTable.id, id));
  return JSON.parse(role.permission);
}

test("custom roles drop Simple View and keep everything else", async ({
  makeOrganization,
  makeCustomRole,
}) => {
  const org = await makeOrganization();
  const withSimpleView = await makeCustomRole(org.id, {
    permission: { agent: ["read"], simpleView: ["enable"] },
  });
  const without = await makeCustomRole(org.id, {
    permission: { agent: ["read", "create"] },
  });

  await db.execute(sql.raw(migration));
  await db.execute(sql.raw(migration));

  expect(await permissions(withSimpleView.id)).toEqual({ agent: ["read"] });
  expect(await permissions(without.id)).toEqual({ agent: ["read", "create"] });
});
