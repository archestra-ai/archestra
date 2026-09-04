import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const previousCleanupSql = fs.readFileSync(
  path.join(__dirname, "0426_member_default_agent_explicit_only.sql"),
  "utf-8",
);
const migrationSql = fs.readFileSync(
  path.join(__dirname, "0454_clear-legacy-personal-assistant-defaults.sql"),
  "utf-8",
);

async function runMigration(sqlText: string) {
  await db.execute(sql.raw(sqlText));
}

async function insertHistoricalPersonalAgent(params: {
  organizationId: string;
  authorId: string;
  name?: string;
  description?: string;
  createdAt: Date;
}) {
  const [agent] = await db
    .insert(schema.agentsTable)
    .values({
      organizationId: params.organizationId,
      authorId: params.authorId,
      agentType: "agent",
      scope: "personal",
      name: params.name ?? "My Assistant",
      description: params.description ?? "Your personal chat assistant",
      accessAllTools: true,
      createdAt: params.createdAt,
    })
    .returning();
  return agent;
}

async function setMemberDefault(params: {
  userId: string;
  organizationId: string;
  agentId: string;
}) {
  await db
    .update(schema.membersTable)
    .set({ defaultAgentId: params.agentId })
    .where(
      sql`${schema.membersTable.userId} = ${params.userId} AND ${schema.membersTable.organizationId} = ${params.organizationId}`,
    );
}

async function getMemberDefault(params: {
  userId: string;
  organizationId: string;
}) {
  const [member] = await db
    .select({ defaultAgentId: schema.membersTable.defaultAgentId })
    .from(schema.membersTable)
    .where(
      sql`${schema.membersTable.userId} = ${params.userId} AND ${schema.membersTable.organizationId} = ${params.organizationId}`,
    );
  return member?.defaultAgentId ?? null;
}

describe("0454 clear legacy personal assistant defaults", () => {
  test("clears the newer duplicate that the original cleanup left shadowing the organization default", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id);
    await insertHistoricalPersonalAgent({
      organizationId: organization.id,
      authorId: user.id,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const selectedDuplicate = await insertHistoricalPersonalAgent({
      organizationId: organization.id,
      authorId: user.id,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    await setMemberDefault({
      userId: user.id,
      organizationId: organization.id,
      agentId: selectedDuplicate.id,
    });

    await runMigration(previousCleanupSql);

    expect(
      await getMemberDefault({
        userId: user.id,
        organizationId: organization.id,
      }),
    ).toBe(selectedDuplicate.id);

    await runMigration(migrationSql);

    expect(
      await getMemberDefault({
        userId: user.id,
        organizationId: organization.id,
      }),
    ).toBeNull();
  });

  test("preserves deliberate custom and unambiguous assistant pins", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organization = await makeOrganization();
    const customUser = await makeUser();
    const assistantUser = await makeUser();
    await makeMember(customUser.id, organization.id);
    await makeMember(assistantUser.id, organization.id);

    await insertHistoricalPersonalAgent({
      organizationId: organization.id,
      authorId: customUser.id,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const customSelection = await insertHistoricalPersonalAgent({
      organizationId: organization.id,
      authorId: customUser.id,
      name: "Release Assistant",
      description: "Coordinates release work",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    const singleAssistant = await insertHistoricalPersonalAgent({
      organizationId: organization.id,
      authorId: assistantUser.id,
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    });
    await setMemberDefault({
      userId: customUser.id,
      organizationId: organization.id,
      agentId: customSelection.id,
    });
    await setMemberDefault({
      userId: assistantUser.id,
      organizationId: organization.id,
      agentId: singleAssistant.id,
    });

    await runMigration(migrationSql);

    expect(
      await getMemberDefault({
        userId: customUser.id,
        organizationId: organization.id,
      }),
    ).toBe(customSelection.id);
    expect(
      await getMemberDefault({
        userId: assistantUser.id,
        organizationId: organization.id,
      }),
    ).toBe(singleAssistant.id);
  });

  test("is idempotent", async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id);
    await insertHistoricalPersonalAgent({
      organizationId: organization.id,
      authorId: user.id,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const selectedDuplicate = await insertHistoricalPersonalAgent({
      organizationId: organization.id,
      authorId: user.id,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    await setMemberDefault({
      userId: user.id,
      organizationId: organization.id,
      agentId: selectedDuplicate.id,
    });

    await runMigration(migrationSql);
    await runMigration(migrationSql);

    expect(
      await getMemberDefault({
        userId: user.id,
        organizationId: organization.id,
      }),
    ).toBeNull();
    expect(
      await db
        .select({ id: schema.agentsTable.id })
        .from(schema.agentsTable)
        .where(eq(schema.agentsTable.authorId, user.id)),
    ).toHaveLength(2);
  });
});
