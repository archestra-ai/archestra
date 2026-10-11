import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
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

    await db.execute(sql.raw(migrationSql));
    await db.execute(sql.raw(migrationSql));

    const rows = await db
      .select({
        id: schema.agentsTable.id,
        deletedAt: schema.agentsTable.deletedAt,
      })
      .from(schema.agentsTable);
    expect(rows.find((row) => row.id === owned.id)?.deletedAt).toBeNull();
    expect(rows.find((row) => row.id === orphan.id)?.deletedAt).not.toBeNull();
  });
});
