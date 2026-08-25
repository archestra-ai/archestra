import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0435_single_llm_proxy.sql"),
  "utf-8",
);

/**
 * Replays only the data-migration DO block. The CREATE UNIQUE INDEX statement
 * at the end of the file already exists in the shared test schema (migrations
 * run once when the PGlite snapshot is built), so replaying it would fail —
 * and the DO block is deliberately ordered so it never violates that index
 * (demotions happen before the elected row is promoted).
 */
async function runMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.includes("DO $$"));
  if (statements.length !== 1) {
    throw new Error("Migration data DO block not found");
  }
  await db.execute(sql.raw(statements[0]));
  // The DO block's temporary election table lives for the duration of the
  // connection, and the test suite runs on a single PGlite connection — drop
  // it so the block can be replayed within one test run.
  await db.execute(sql.raw('DROP TABLE IF EXISTS "_llm_proxy_election"'));
}

/**
 * Rows are inserted directly rather than through `AgentModel` so the tests can
 * shape exactly the historical states the migration has to handle.
 */
async function insertAgentRow(
  overrides: Partial<typeof schema.agentsTable.$inferInsert> & {
    organizationId: string;
  },
) {
  const [row] = await db
    .insert(schema.agentsTable)
    .values({
      name: `Historical Proxy ${crypto.randomUUID().substring(0, 8)}`,
      agentType: "llm_proxy",
      scope: "org",
      ...overrides,
    })
    .returning();
  return row;
}

async function getAgent(id: string) {
  const [row] = await db
    .select()
    .from(schema.agentsTable)
    .where(sql`${schema.agentsTable.id} = ${id}`);
  return row;
}

async function getOrgProxyRows(organizationId: string) {
  return await db
    .select()
    .from(schema.agentsTable)
    .where(
      sql`${schema.agentsTable.organizationId} = ${organizationId} AND ${schema.agentsTable.agentType} = 'llm_proxy'`,
    );
}

describe("0435 single llm proxy", () => {
  test("elects the connection-default row, normalizes it, demotes the rest, and is idempotent", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const oldest = await insertAgentRow({
      organizationId: org.id,
      createdAt: new Date("2024-01-01"),
    });
    const orgDefault = await insertAgentRow({
      organizationId: org.id,
      isDefault: true,
      createdAt: new Date("2024-02-01"),
    });
    const connectionDefault = await insertAgentRow({
      organizationId: org.id,
      name: "Team Proxy",
      description: "hand-configured",
      createdAt: new Date("2024-03-01"),
    });
    await db
      .update(schema.organizationsTable)
      .set({ connectionDefaultLlmProxyId: connectionDefault.id })
      .where(sql`${schema.organizationsTable.id} = ${org.id}`);

    await runMigration();

    const elected = await getAgent(connectionDefault.id);
    expect(elected).toMatchObject({
      isDefault: true,
      name: "LLM Proxy",
      description: null,
      scope: "org",
      isPersonalProxy: false,
      authorId: null,
      environmentId: null,
    });
    expect((await getAgent(orgDefault.id)).isDefault).toBe(false);
    expect((await getAgent(oldest.id)).isDefault).toBe(false);

    await runMigration();

    const defaults = (await getOrgProxyRows(org.id)).filter(
      (row) => row.isDefault,
    );
    expect(defaults.map((row) => row.id)).toEqual([connectionDefault.id]);
  });

  test("falls back to the org default, then to the oldest shared row", async ({
    makeOrganization,
  }) => {
    const defaultWins = await makeOrganization();
    const olderPlain = await insertAgentRow({
      organizationId: defaultWins.id,
      createdAt: new Date("2024-01-01"),
    });
    const newerDefault = await insertAgentRow({
      organizationId: defaultWins.id,
      isDefault: true,
      createdAt: new Date("2024-06-01"),
    });

    const oldestWins = await makeOrganization();
    const first = await insertAgentRow({
      organizationId: oldestWins.id,
      createdAt: new Date("2024-01-01"),
    });
    const second = await insertAgentRow({
      organizationId: oldestWins.id,
      createdAt: new Date("2024-02-01"),
    });

    await runMigration();

    expect((await getAgent(newerDefault.id)).isDefault).toBe(true);
    expect((await getAgent(olderPlain.id)).isDefault).toBe(false);
    expect((await getAgent(first.id)).isDefault).toBe(true);
    expect((await getAgent(second.id)).isDefault).toBe(false);
  });

  test("never elects a personal proxy and creates a fresh row when no shared one exists", async ({
    makeOrganization,
    makeUser,
  }) => {
    const user = await makeUser();
    const personalOnly = await makeOrganization();
    const personal = await insertAgentRow({
      organizationId: personalOnly.id,
      scope: "personal",
      isPersonalProxy: true,
      authorId: user.id,
    });
    const emptyOrg = await makeOrganization();

    await runMigration();

    // The personal row keeps its owner's configuration untouched.
    expect(await getAgent(personal.id)).toMatchObject({
      isDefault: false,
      isPersonalProxy: true,
      authorId: user.id,
    });

    for (const organizationId of [personalOnly.id, emptyOrg.id]) {
      const fresh = (await getOrgProxyRows(organizationId)).filter(
        (row) => row.isDefault,
      );
      expect(fresh).toHaveLength(1);
      expect(fresh[0]).toMatchObject({
        name: "LLM Proxy",
        scope: "org",
        isPersonalProxy: false,
      });
    }
  });

  test("absorbs donor settings: context-untrusted ORs across donors and a lone donor identity provider is adopted", async ({
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const org = await makeOrganization();
    const idp = await makeIdentityProvider(org.id);
    const elected = await insertAgentRow({
      organizationId: org.id,
      isDefault: true,
      considerContextUntrusted: false,
    });
    const profileDonor = await insertAgentRow({
      organizationId: org.id,
      agentType: "profile",
      considerContextUntrusted: true,
      identityProviderId: idp.id,
    });

    await runMigration();

    expect(await getAgent(elected.id)).toMatchObject({
      considerContextUntrusted: true,
      identityProviderId: idp.id,
    });
    // Donor rows keep their own provider (still used on the gateway side).
    expect((await getAgent(profileDonor.id)).identityProviderId).toBe(idp.id);
  });

  test("leaves the identity provider unset when donors disagree", async ({
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const org = await makeOrganization();
    const idpA = await makeIdentityProvider(org.id);
    const idpB = await makeIdentityProvider(org.id);
    const elected = await insertAgentRow({
      organizationId: org.id,
      isDefault: true,
    });
    await insertAgentRow({
      organizationId: org.id,
      identityProviderId: idpA.id,
      createdAt: new Date("2024-01-01"),
    });
    await insertAgentRow({
      organizationId: org.id,
      agentType: "profile",
      identityProviderId: idpB.id,
    });

    await runMigration();

    expect((await getAgent(elected.id)).identityProviderId).toBeNull();
  });

  test("re-keys live donor limits onto the elected row and leaves soft-deleted donors' limits alone", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const elected = await insertAgentRow({
      organizationId: org.id,
      isDefault: true,
    });
    const liveDonor = await insertAgentRow({ organizationId: org.id });
    const deletedDonor = await insertAgentRow({
      organizationId: org.id,
      deletedAt: new Date(),
    });
    const [liveLimit, deadLimit] = await db
      .insert(schema.limitsTable)
      .values([
        {
          entityType: "agent",
          entityId: liveDonor.id,
          limitType: "token_cost",
          limitValue: 100,
        },
        {
          entityType: "agent",
          entityId: deletedDonor.id,
          limitType: "token_cost",
          limitValue: 200,
        },
      ])
      .returning();

    await runMigration();

    const getLimit = async (id: string) => {
      const [row] = await db
        .select()
        .from(schema.limitsTable)
        .where(sql`${schema.limitsTable.id} = ${id}`);
      return row;
    };
    expect((await getLimit(liveLimit.id)).entityId).toBe(elected.id);
    expect((await getLimit(deadLimit.id)).entityId).toBe(deletedDonor.id);
  });

  test("clears team and user grants from the elected row", async ({
    makeOrganization,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const elected = await insertAgentRow({
      organizationId: org.id,
      isDefault: true,
    });
    await db
      .insert(schema.agentTeamsTable)
      .values({ agentId: elected.id, teamId: team.id });
    await db
      .insert(schema.agentUsersTable)
      .values({ agentId: elected.id, userId: user.id });

    await runMigration();

    expect(
      await db
        .select()
        .from(schema.agentTeamsTable)
        .where(sql`${schema.agentTeamsTable.agentId} = ${elected.id}`),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.agentUsersTable)
        .where(sql`${schema.agentUsersTable.agentId} = ${elected.id}`),
    ).toHaveLength(0);
  });

  test("shrinks stored llmProxy role grants to the surviving actions", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const insertRole = async (
      roleId: string,
      permission: Record<string, string[]>,
    ) => {
      await db.insert(schema.organizationRolesTable).values({
        id: roleId,
        organizationId: org.id,
        role: roleId,
        name: roleId,
        permission: JSON.stringify(permission),
      });
    };
    const getPermission = async (
      roleId: string,
    ): Promise<Record<string, string[]>> => {
      const [row] = await db
        .select({ permission: schema.organizationRolesTable.permission })
        .from(schema.organizationRolesTable)
        .where(sql`${schema.organizationRolesTable.id} = ${roleId}`);
      return JSON.parse(row.permission as unknown as string);
    };

    await insertRole("llm-proxy-writer", {
      llmProxy: ["read", "create", "delete"],
      agent: ["read"],
    });
    await insertRole("llm-proxy-reader", { llmProxy: ["read"] });
    await insertRole("llm-proxy-unrelated", { agent: ["read"] });
    await insertRole("llm-proxy-stale-actions", { llmProxy: ["deploy"] });

    await runMigration();

    expect(await getPermission("llm-proxy-writer")).toEqual({
      llmProxy: ["read", "update"],
      agent: ["read"],
    });
    expect(await getPermission("llm-proxy-reader")).toEqual({
      llmProxy: ["read"],
    });
    expect(await getPermission("llm-proxy-unrelated")).toEqual({
      agent: ["read"],
    });
    expect(await getPermission("llm-proxy-stale-actions")).toEqual({
      llmProxy: [],
    });
  });
});
