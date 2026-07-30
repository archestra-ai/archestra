import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  AgentConnectorAssignmentModel,
  AgentKnowledgeBaseModel,
  ConnectorRunModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  TaskModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { describe, expect, test } from "@/test";
import type { ConnectorConfig } from "@/types";
import {
  deleteConnector,
  deleteKnowledgeBase,
} from "./knowledge-source-deletion";

const jiraConfig: ConnectorConfig = {
  type: "jira",
  jiraBaseUrl: "https://soft-delete.atlassian.net",
  isCloud: true,
  projectKey: "SD",
};

async function makeConnector(
  organizationId: string,
  overrides: Partial<
    Parameters<typeof KnowledgeBaseConnectorModel.create>[0]
  > = {},
) {
  return KnowledgeBaseConnectorModel.create({
    organizationId,
    name: `Connector ${crypto.randomUUID().slice(0, 8)}`,
    connectorType: "jira",
    config: jiraConfig,
    ...overrides,
  });
}

describe("knowledge-source soft-delete", () => {
  test("deleteConnector stamps deleted_at: row survives but drops from reads", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);

    expect(await deleteConnector(connector.id)).toBe(true);

    // Filtered reads treat it as gone...
    expect(await KnowledgeBaseConnectorModel.findById(connector.id)).toBeNull();
    // ...but the row physically survives with deleted_at set (soft, not hard).
    const [raw] = await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.id, connector.id));
    expect(raw).toBeDefined();
    expect(raw.deletedAt).not.toBeNull();

    // Re-delete finds no active row → false (routes surface this as a 404).
    expect(await deleteConnector(connector.id)).toBe(false);
  });

  test("deleteKnowledgeBase stamps deleted_at and drops from reads", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const kb = await KnowledgeBaseModel.create({
      organizationId: org.id,
      name: "Soft Delete KB",
    });

    expect(await deleteKnowledgeBase(kb.id)).toBe(true);
    expect(await KnowledgeBaseModel.findById(kb.id)).toBeNull();

    const [raw] = await db
      .select()
      .from(schema.knowledgeBasesTable)
      .where(eq(schema.knowledgeBasesTable.id, kb.id));
    expect(raw.deletedAt).not.toBeNull();

    expect(await deleteKnowledgeBase(kb.id)).toBe(false);
  });

  test("deleteConnector cancels queued syncs (parity for REST + MCP callers)", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);
    await TaskModel.create({
      taskType: "connector_sync",
      payload: { connectorId: connector.id },
    });

    await deleteConnector(connector.id);

    expect(
      await TaskModel.hasPendingOrProcessing("connector_sync", connector.id),
    ).toBe(false);
  });

  test("deleteConnector revokes the connector's credential", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secret = await secretManager().createSecret(
      { email: "svc", apiToken: "revoke-me" },
      "soft-delete-secret",
    );
    const connector = await makeConnector(org.id, { secretId: secret.id });

    await deleteConnector(connector.id);

    // Deleting a connector is how an admin cuts the platform's access to the
    // source. Retaining the credential would be unrevocable: once stamped, the
    // connector 404s from every route, and there is no secrets list/delete API.
    expect(await secretManager().getSecret(secret.id)).toBeNull();

    // `secret_id` is ON DELETE SET NULL, so the surviving row keeps no dangling
    // reference — a restore re-authenticates.
    const [raw] = await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.id, connector.id));
    expect(raw.secretId).toBeNull();
  });

  test("deleteConnector stops an in-flight sync run", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);
    const run = await ConnectorRunModel.create({
      connectorId: connector.id,
      status: "running",
      startedAt: new Date(),
      leaseOwner: "worker-1",
      leaseEpoch: 0,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    await deleteConnector(connector.id);

    // Hard delete cascaded the run row away, which failed the worker's next
    // lease renewal and stopped it before the next batch. Soft delete leaves
    // the row, so the delete path has to fail the lease itself — otherwise the
    // run keeps pulling from the source and writing documents.
    const stopped = await ConnectorRunModel.findById(run.id);
    expect(stopped?.status).toBe("superseded");
    expect(stopped?.leaseEpoch).toBe(1);

    // The exact check the sync loop makes at each batch boundary.
    expect(
      await ConnectorRunModel.renewLease({
        runId: run.id,
        owner: "worker-1",
        epoch: 0,
        leaseTtlSeconds: 60,
      }),
    ).toBe(false);
  });

  test("deleteConnector leaves other connectors' running syncs alone", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const deleted = await makeConnector(org.id);
    const survivor = await makeConnector(org.id);
    const survivorRun = await ConnectorRunModel.create({
      connectorId: survivor.id,
      status: "running",
      startedAt: new Date(),
      leaseOwner: "worker-2",
      leaseEpoch: 0,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    await deleteConnector(deleted.id);

    expect((await ConnectorRunModel.findById(survivorRun.id))?.status).toBe(
      "running",
    );
  });

  test("writes no longer land on a soft-deleted knowledge source", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);
    const kb = await KnowledgeBaseModel.create({
      organizationId: org.id,
      name: "Frozen KB",
    });
    const epochBefore = await KnowledgeBaseConnectorModel.bumpAclConfigEpoch(
      connector.id,
    );

    await deleteConnector(connector.id);
    await deleteKnowledgeBase(kb.id);

    // A background job that finishes after the delete (a sync finalizing its
    // status, an ACL epoch bump) must no-op rather than write to a gone row.
    expect(
      await KnowledgeBaseConnectorModel.update(connector.id, {
        lastSyncStatus: "success",
      }),
    ).toBeNull();
    expect(
      await KnowledgeBaseConnectorModel.bumpAclConfigEpoch(connector.id),
    ).toBe(0);
    expect(
      await KnowledgeBaseModel.update(kb.id, { name: "Renamed" }),
    ).toBeNull();

    const [rawConnector] = await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.id, connector.id));
    expect(rawConnector.lastSyncStatus).not.toBe("success");
    expect(rawConnector.aclConfigEpoch).toBe(epochBefore);

    const [rawKb] = await db
      .select()
      .from(schema.knowledgeBasesTable)
      .where(eq(schema.knowledgeBasesTable.id, kb.id));
    expect(rawKb.name).toBe("Frozen KB");
  });

  test("the audit snapshot stops resolving once the entity is deleted", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);
    const kb = await KnowledgeBaseModel.create({
      organizationId: org.id,
      name: "Audited KB",
    });

    // Both audit surfaces capture `before` ahead of the handler, so the delete
    // record still gets its full prior state...
    expect(
      await KnowledgeBaseModel.findByIdForAudit(kb.id, org.id),
    ).toMatchObject({ name: "Audited KB" });

    await deleteConnector(connector.id);
    await deleteKnowledgeBase(kb.id);

    // ...but a re-delete of an already-deleted entity must not record a prior
    // state that reads as though a live entity was torn down.
    expect(await KnowledgeBaseModel.findByIdForAudit(kb.id, org.id)).toBeNull();
    expect(
      await KnowledgeBaseConnectorModel.findByIdForAudit(connector.id, org.id),
    ).toBeNull();
  });

  test("org-scoped indexes are partial on deleted_at", async () => {
    const { rows } = await db.execute<{ indexname: string; indexdef: string }>(
      sql`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE indexname IN (
          'knowledge_bases_organization_id_idx',
          'knowledge_base_connectors_organization_id_idx',
          'knowledge_base_connectors_environment_id_idx'
        )
      `,
    );

    // Every read filters `deleted_at IS NULL`, so the indexes backing them
    // carry the same predicate and never index rows nothing scans.
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.indexdef).toContain("WHERE (deleted_at IS NULL)");
    }
  });

  test("soft-deleting a connector stops surfacing it to its agents", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const connector = await makeConnector(org.id);
    await AgentConnectorAssignmentModel.assign(agent.id, connector.id);

    expect(
      await AgentConnectorAssignmentModel.getConnectorIds(agent.id),
    ).toEqual([connector.id]);

    await deleteConnector(connector.id);

    // Regression: the junction row survives soft-delete, so without the parent
    // filter this agent would keep being told it has this connector (and keep
    // being offered query_knowledge_sources).
    expect(
      await AgentConnectorAssignmentModel.getConnectorIds(agent.id),
    ).toEqual([]);
  });

  test("soft-deleting a KB stops surfacing it to its agents", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const kb = await KnowledgeBaseModel.create({
      organizationId: org.id,
      name: "Agent KB",
    });
    await AgentKnowledgeBaseModel.assign(agent.id, kb.id);

    expect(await AgentKnowledgeBaseModel.getKnowledgeBaseIds(agent.id)).toEqual(
      [kb.id],
    );

    await deleteKnowledgeBase(kb.id);

    expect(await AgentKnowledgeBaseModel.getKnowledgeBaseIds(agent.id)).toEqual(
      [],
    );
  });

  test("paginated list excludes soft-deleted from both data and total", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const deleted = await makeConnector(org.id);
    const survivor = await makeConnector(org.id);

    await deleteConnector(deleted.id);

    const { data, total } =
      await KnowledgeBaseConnectorModel.findByOrganizationPaginated({
        organizationId: org.id,
        limit: 50,
        offset: 0,
        canReadAll: true,
      });

    expect(total).toBe(1);
    expect(data.map((c) => c.id)).toEqual([survivor.id]);
  });

  test("name/type frees up for reuse after soft-delete", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id, { name: "Reusable" });
    expect(
      await KnowledgeBaseConnectorModel.findByNameAndType(
        "Reusable",
        "jira",
        org.id,
      ),
    ).not.toBeNull();

    await deleteConnector(connector.id);

    expect(
      await KnowledgeBaseConnectorModel.findByNameAndType(
        "Reusable",
        "jira",
        org.id,
      ),
    ).toBeNull();

    const kb = await KnowledgeBaseModel.create({
      organizationId: org.id,
      name: "Reusable KB",
    });
    expect(
      await KnowledgeBaseModel.findByName("Reusable KB", org.id),
    ).not.toBeNull();
    await deleteKnowledgeBase(kb.id);
    expect(
      await KnowledgeBaseModel.findByName("Reusable KB", org.id),
    ).toBeNull();
  });

  // The guards report "no active parent" as `false` and write nothing; mapping
  // that to a 404 belongs to each entry point (route / MCP handler), not the
  // model — see the route-level assertions in routes/knowledge-base.test.ts.
  describe("write guards refuse to attach to a soft-deleted parent", () => {
    test("connector→KB assignment is refused when the KB is soft-deleted", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const connector = await makeConnector(org.id);
      const kb = await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "Gone KB",
      });
      await deleteKnowledgeBase(kb.id);

      expect(
        await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
          connector.id,
          kb.id,
        ),
      ).toBe(false);
      expect(
        await KnowledgeBaseConnectorModel.getKnowledgeBaseIds(connector.id),
      ).toEqual([]);
    });

    test("connector→KB assignment is refused when the connector is soft-deleted", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const connector = await makeConnector(org.id);
      const kb = await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "Live KB",
      });
      await deleteConnector(connector.id);

      expect(
        await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
          connector.id,
          kb.id,
        ),
      ).toBe(false);
      expect(await KnowledgeBaseConnectorModel.getConnectorIds(kb.id)).toEqual(
        [],
      );
    });

    test("agent→KB assignment is refused when the KB is soft-deleted", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "Gone KB 2",
      });
      await deleteKnowledgeBase(kb.id);

      expect(await AgentKnowledgeBaseModel.assign(agent.id, kb.id)).toBe(false);
      expect(
        await AgentKnowledgeBaseModel.getKnowledgeBaseIds(agent.id),
      ).toEqual([]);
    });

    test("agent→connector assignment is refused when the connector is soft-deleted", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const connector = await makeConnector(org.id);
      await deleteConnector(connector.id);

      expect(
        await AgentConnectorAssignmentModel.assign(agent.id, connector.id),
      ).toBe(false);
      expect(
        await AgentConnectorAssignmentModel.getConnectorIds(agent.id),
      ).toEqual([]);
    });
  });
});
