import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { AgentModel, AuditLogModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import { describe, expect, test, vi } from "@/test";
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

  test("a failed audit write rolls back the purge; the next sweep retries", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await agedDeletedAgent(makeAgent, org.id);
    enableRetention();

    const createSpy = vi
      .spyOn(AuditLogModel, "create")
      .mockRejectedValueOnce(new Error("audit store unavailable"));
    try {
      await handleSoftDeletePurge();

      // The delete rolled back with its audit insert: the row survives and
      // nothing was destroyed without a trail.
      const [row] = await db
        .select()
        .from(schema.agentsTable)
        .where(eq(schema.agentsTable.id, agent.id));
      expect(row).toBeDefined();
      const audits = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.resourceId, agent.id));
      expect(audits).toEqual([]);

      // Audit writes healthy again: the next sweep purges and records it.
      await handleSoftDeletePurge();
    } finally {
      createSpy.mockRestore();
    }

    const [rowAfter] = await db
      .select()
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, agent.id));
    expect(rowAfter).toBeUndefined();
    const [audit] = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, agent.id));
    expect(audit).toMatchObject({ action: "agent.purged", outcome: "success" });
  });

  test("attributes an unowned+teamless install to its catalog's organization", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // No team and no owner, so the only link left is the catalog. One catalog
    // per install (`catalog_id` is NOT NULL), so this answer is exact.
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      teamId: null,
      ownerId: null,
    });
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
    expect(row).toBeUndefined();
    const [audit] = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, server.id));
    expect(audit).toMatchObject({
      organizationId: org.id,
      action: "mcpServer.purged",
      actorType: "system",
    });
  });

  test("attributes a personal install to the same org on every run", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // An owner in two orgs on a global catalog entry has no single right
    // answer, but it must be the SAME answer every time: an unordered
    // LIMIT 1 flips between orgs, and whichever org loses the toss loses the
    // record that the install was destroyed.
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, orgA.id);
    await makeMember(user.id, orgB.id);
    const catalog = await makeInternalMcpCatalog({ organizationId: orgA.id });
    // Global/public entry: no owning org, so resolution has to fall through
    // to the owner's memberships.
    await db
      .update(schema.internalMcpCatalogTable)
      .set({ organizationId: null })
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));

    const servers: { id: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const server = await makeMcpServer({
        catalogId: catalog.id,
        teamId: null,
        ownerId: user.id,
      });
      await db
        .update(schema.mcpServersTable)
        .set({ deletedAt: FORTY_DAYS_AGO() })
        .where(eq(schema.mcpServersTable.id, server.id));
      servers.push(server);
    }

    // An unrelated write to one membership row rewrites its tuple at the end
    // of the heap — enough to flip an unordered LIMIT 1.
    const [firstMembership] = await db
      .select()
      .from(schema.membersTable)
      .where(eq(schema.membersTable.userId, user.id));
    await db
      .update(schema.membersTable)
      .set({ role: "member" })
      .where(eq(schema.membersTable.id, firstMembership.id));

    enableRetention();
    await handleSoftDeletePurge();

    const audits = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.action, "mcpServer.purged"));
    const attributed = audits
      .filter((a) => servers.some((s) => s.id === a.resourceId))
      .map((a) => a.organizationId);
    expect(attributed).toHaveLength(3);
    expect(new Set(attributed).size).toBe(1);
  });

  test("skips a row whose organization cannot be resolved", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    // No team, no owner, and a global catalog entry that names no org: every
    // link misses. `audit_logs.organization_id` is NOT NULL, so this purge
    // could not be recorded at all — left in place instead.
    const catalog = await makeInternalMcpCatalog();
    await db
      .update(schema.internalMcpCatalogTable)
      .set({ organizationId: null })
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    const server = await makeMcpServer({
      catalogId: catalog.id,
      teamId: null,
      ownerId: null,
    });
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
