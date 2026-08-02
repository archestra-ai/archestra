import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { AgentModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import { describe, expect, test } from "@/test";
import { handleSoftDeletePurge } from "./soft-delete-purge-handler";

const FORTY_DAYS_AGO = () => new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

function enableRetention(days = 30) {
  // Direct mutation — the shared setup restores the pristine config after
  // every test.
  config.softDeleteRetention.enabled = true;
  config.softDeleteRetention.days = days;
}

async function agedDeletedAgent(
  makeAgent: (o: {
    organizationId: string;
  }) => Promise<{ id: string; name: string }>,
  organizationId: string,
) {
  const agent = await makeAgent({ organizationId });
  await db
    .update(schema.agentsTable)
    .set({ deletedAt: FORTY_DAYS_AGO() })
    .where(eq(schema.agentsTable.id, agent.id));
  return agent;
}

describe("handleSoftDeletePurge", () => {
  test("disabled (the default) is a no-op even with aged-out rows", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await agedDeletedAgent(makeAgent, org.id);

    await handleSoftDeletePurge();

    const [row] = await db
      .select()
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, agent.id));
    expect(row).toBeDefined();
  });

  test("purges an aged-out row and writes an identity-only system audit row", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await agedDeletedAgent(makeAgent, org.id);
    enableRetention();

    await handleSoftDeletePurge();

    const [row] = await db
      .select()
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, agent.id));
    expect(row).toBeUndefined();

    const [audit] = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, agent.id));
    expect(audit).toMatchObject({
      organizationId: org.id,
      action: "agent.purged",
      actorType: "system",
      actorId: null,
      outcome: "success",
      resourceType: "agent",
      resourceName: agent.name,
      after: null,
    });
    // Identity-only snapshot: the row is recorded as gone, not what it held.
    expect(audit.before).toMatchObject({ id: agent.id, name: agent.name });
    expect(Object.keys(audit.before as Record<string, unknown>).sort()).toEqual(
      ["agentType", "deletedAt", "id", "name"],
    );
  });

  test("a row inside the window survives; a restored row is never selected", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const fresh = await makeAgent({ organizationId: org.id });
    await AgentModel.delete(fresh.id);
    const restored = await agedDeletedAgent(makeAgent, org.id);
    await AgentModel.restore(restored.id);
    enableRetention();

    await handleSoftDeletePurge();

    const [freshRow] = await db
      .select()
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, fresh.id));
    expect(freshRow?.deletedAt).toBeInstanceOf(Date);
    const [restoredRow] = await db
      .select()
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, restored.id));
    expect(restoredRow?.deletedAt).toBeNull();
  });

  test("purges an install (destroying its secret) before its catalog in one sweep", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const secret = await secretManager().createSecret(
      { API_KEY: "retained" },
      "sweep-secret",
    );
    const server = await makeMcpServer({
      catalogId: catalog.id,
      teamId: team.id,
    });
    const at = FORTY_DAYS_AGO();
    await db
      .update(schema.mcpServersTable)
      .set({ secretId: secret.id, deletedAt: at })
      .where(eq(schema.mcpServersTable.id, server.id));
    await db
      .update(schema.internalMcpCatalogTable)
      .set({ deletedAt: at })
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    enableRetention();

    await handleSoftDeletePurge();

    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, server.id));
    expect(serverRow).toBeUndefined();
    const [catalogRow] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    expect(catalogRow).toBeUndefined();
    const [secretRow] = await db
      .select()
      .from(schema.secretsTable)
      .where(eq(schema.secretsTable.id, secret.id));
    expect(secretRow).toBeUndefined();

    const audits = await db
      .select({ action: schema.auditLogsTable.action })
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.organizationId, org.id));
    expect(audits.map((a) => a.action).sort()).toEqual([
      "internalMcpCatalog.purged",
      "mcpServer.purged",
    ]);
  });

  test("skips a row whose organization cannot be resolved", async ({
    makeMcpServer,
  }) => {
    // Legacy unowned+teamless system install: no team, no owner — no org to
    // attribute the purge to, so it is left in place.
    const server = await makeMcpServer({ teamId: null, ownerId: null });
    await db
      .update(schema.mcpServersTable)
      .set({ deletedAt: FORTY_DAYS_AGO() })
      .where(eq(schema.mcpServersTable.id, server.id));
    enableRetention();

    await handleSoftDeletePurge();

    const [row] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, server.id));
    expect(row).toBeDefined();
  });
});
