import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0529_cleanup-orphaned-personal-agents.sql"),
  "utf-8",
);

describe("0529 orphaned personal agents cleanup", () => {
  test("soft-deletes unshared agents and gateways without an author", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const colleague = await makeUser();
    // Its account would be gone; here it is just no longer a member.
    const formerOwner = await makeUser();
    await makeMember(owner.id, organization.id);
    await makeMember(colleague.id, organization.id);

    const make = (
      agentType: "agent" | "mcp_gateway",
      access: "personal" | "org" | { users: string[] },
      authorId = formerOwner.id,
    ) =>
      makeAgent({
        organizationId: organization.id,
        authorId,
        agentType,
        access,
      });
    const orphanAgent = await make("agent", "personal");
    const orphanGateway = await make("mcp_gateway", "personal");
    const sharedAgent = await make("agent", { users: [colleague.id] });
    const orgGateway = await make("mcp_gateway", "org");
    const ownedAgent = await make("agent", "personal", owner.id);

    await db
      .update(schema.agentsTable)
      .set({ authorId: null })
      .where(
        inArray(schema.agentsTable.id, [
          orphanAgent.id,
          orphanGateway.id,
          sharedAgent.id,
          orgGateway.id,
        ]),
      );

    await runMigration();
    await runMigration();

    const deletedAt = async (id: string) =>
      (
        await db
          .select({ deletedAt: schema.agentsTable.deletedAt })
          .from(schema.agentsTable)
          .where(eq(schema.agentsTable.id, id))
      )[0]?.deletedAt;
    expect(await deletedAt(orphanAgent.id)).not.toBeNull();
    expect(await deletedAt(orphanGateway.id)).not.toBeNull();
    expect(await deletedAt(sharedAgent.id)).toBeNull();
    expect(await deletedAt(orgGateway.id)).toBeNull();
    expect(await deletedAt(ownedAgent.id)).toBeNull();
  });
});

async function runMigration() {
  for (const statement of migrationSql.split("--> statement-breakpoint")) {
    await db.execute(sql.raw(statement));
  }
}
