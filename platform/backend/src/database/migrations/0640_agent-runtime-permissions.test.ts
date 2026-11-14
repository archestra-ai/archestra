// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import fs from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const statements = fs
  .readFileSync(
    path.join(__dirname, "0640_agent-runtime-permissions.sql"),
    "utf8",
  )
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

async function migrate() {
  for (const statement of statements) await db.execute(sql.raw(statement));
}

async function runtimePolicy(organizationId: string) {
  const [policy] = await db
    .select()
    .from(schema.resourcePermissionPoliciesTable)
    .where(
      and(
        eq(
          schema.resourcePermissionPoliciesTable.organizationId,
          organizationId,
        ),
        eq(schema.resourcePermissionPoliciesTable.resource, "agentRuntime"),
        eq(schema.resourcePermissionPoliciesTable.scope, "*"),
      ),
    );
  return policy;
}

async function rolePermission(id: string) {
  const [role] = await db
    .select({ permission: schema.organizationRolesTable.permission })
    .from(schema.organizationRolesTable)
    .where(eq(schema.organizationRolesTable.id, id));
  return JSON.parse(role.permission) as Record<string, string[]>;
}

describe("moving agent:configure-runtime to agentRuntime grants", () => {
  test("gives admins Full access and configure-runtime roles use and configure, then retires the action", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    // Existing organizations predate the policy that new ones are given.
    await db
      .delete(schema.resourcePermissionPoliciesTable)
      .where(
        and(
          eq(schema.resourcePermissionPoliciesTable.organizationId, org.id),
          eq(schema.resourcePermissionPoliciesTable.resource, "agentRuntime"),
        ),
      );
    const runtimeBuilder = await makeCustomRole(org.id, {
      permission: { agent: ["read", "create", "configure-runtime"] },
    });
    const reader = await makeCustomRole(org.id, {
      permission: { agent: ["read"] },
    });

    await migrate();

    const policy = await runtimePolicy(org.id);
    expect(policy.grants).toEqual([
      {
        subject: { type: "role", id: "admin" },
        actions: ["read", "use", "configure", "manage-permissions"],
      },
      {
        subject: { type: "role", id: "platform_admin" },
        actions: ["read", "use", "configure", "manage-permissions"],
      },
      {
        subject: { type: "role", id: runtimeBuilder.id },
        actions: ["read", "use", "configure"],
      },
    ]);
    expect(await rolePermission(runtimeBuilder.id)).toEqual({
      agent: ["read", "create"],
    });
    expect(await rolePermission(reader.id)).toEqual({ agent: ["read"] });

    // Running it again changes nothing.
    await migrate();
    expect((await runtimePolicy(org.id)).grants).toEqual(policy.grants);
  });

  test("keeps a policy an organization already has", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const edited = [
      {
        subject: { type: "role" as const, id: "admin" },
        actions: ["read" as const, "use" as const],
      },
    ];
    await db
      .update(schema.resourcePermissionPoliciesTable)
      .set({ grants: edited })
      .where(
        and(
          eq(schema.resourcePermissionPoliciesTable.organizationId, org.id),
          eq(schema.resourcePermissionPoliciesTable.resource, "agentRuntime"),
          eq(schema.resourcePermissionPoliciesTable.scope, "*"),
        ),
      );

    await migrate();

    expect((await runtimePolicy(org.id)).grants).toEqual(edited);
  });
});
