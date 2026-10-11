import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0528_cleanup-orphaned-personal-gateways.sql"),
  "utf-8",
);

describe("0528 orphaned personal gateways cleanup", () => {
  test("soft-deletes personal gateways without an author and keeps owned ones", async ({
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const formerOwner = await makeUser();
    await makeMember(owner.id, organization.id);
    await makeMember(formerOwner.id, organization.id);

    const owned = await AgentModel.ensurePersonalMcpGateway({
      userId: owner.id,
      organizationId: organization.id,
    });
    const orphan = await AgentModel.ensurePersonalMcpGateway({
      userId: formerOwner.id,
      organizationId: organization.id,
    });
    await db
      .update(schema.agentsTable)
      .set({ authorId: null })
      .where(eq(schema.agentsTable.id, orphan.id));

    await runMigration();

    const rows = await db
      .select({
        id: schema.agentsTable.id,
        deletedAt: schema.agentsTable.deletedAt,
      })
      .from(schema.agentsTable);
    expect(rows.find((row) => row.id === owned.id)?.deletedAt).toBeNull();
    expect(rows.find((row) => row.id === orphan.id)?.deletedAt).not.toBeNull();
  });

  test("strips grants to anyone but the owner from personal gateways only", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const colleague = await makeUser();
    await makeMember(owner.id, organization.id);
    await makeMember(colleague.id, organization.id);

    const personal = await AgentModel.ensurePersonalMcpGateway({
      userId: owner.id,
      organizationId: organization.id,
    });
    const regular = await makeAgent({
      organizationId: organization.id,
      agentType: "mcp_gateway",
      authorId: owner.id,
    });
    const ownerGrant = {
      subject: { type: "user" as const, id: owner.id },
      actions: ["read" as const, "use" as const],
    };
    const colleagueGrant = {
      subject: { type: "user" as const, id: colleague.id },
      actions: ["read" as const, "use" as const],
    };
    const orgGrant = {
      subject: { type: "organization" as const, id: "*" as const },
      actions: ["read" as const, "use" as const],
    };
    for (const gateway of [personal, regular]) {
      const key = {
        organizationId: organization.id,
        resource: "mcpGateway" as const,
        scope: gateway.id,
      };
      const policy = await ResourcePermissionPolicyModel.find(key);
      await ResourcePermissionPolicyModel.replace({
        ...key,
        revision: policy?.revision ?? 0,
        grants: [ownerGrant, colleagueGrant, orgGrant],
      });
    }

    await runMigration();

    const grantsOf = async (scope: string) =>
      (
        await ResourcePermissionPolicyModel.find({
          organizationId: organization.id,
          resource: "mcpGateway",
          scope,
        })
      )?.grants;
    expect(await grantsOf(personal.id)).toEqual([ownerGrant]);
    expect(await grantsOf(regular.id)).toEqual([
      ownerGrant,
      colleagueGrant,
      orgGrant,
    ]);
  });
});

/** Twice, so the test also pins that a rerun changes nothing further. */
async function runMigration() {
  for (const statement of migrationSql.split("--> statement-breakpoint")) {
    await db.execute(sql.raw(statement));
  }
  for (const statement of migrationSql.split("--> statement-breakpoint")) {
    await db.execute(sql.raw(statement));
  }
}
