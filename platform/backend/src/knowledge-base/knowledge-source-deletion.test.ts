import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  AgentConnectorAssignmentModel,
  AgentKnowledgeBaseModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  TaskModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { describe, expect, test } from "@/test";
import type { ConnectorConfig } from "@/types";
import { ApiError } from "@/types";
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

  test("deleteConnector preserves the secret (revocation deferred to purge)", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secret = await secretManager().createSecret(
      { email: "svc", apiToken: "keep-me" },
      "soft-delete-secret",
    );
    const connector = await makeConnector(org.id, { secretId: secret.id });

    await deleteConnector(connector.id);

    // The secret must still exist so a future restore is credential-preserving.
    expect(await secretManager().getSecret(secret.id)).not.toBeNull();
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

  describe("write guards reject attaching to a soft-deleted parent", () => {
    test("connector→KB assignment 404s when the KB is soft-deleted", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const connector = await makeConnector(org.id);
      const kb = await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "Gone KB",
      });
      await deleteKnowledgeBase(kb.id);

      await expect(
        KnowledgeBaseConnectorModel.assignToKnowledgeBase(connector.id, kb.id),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    test("connector→KB assignment 404s when the connector is soft-deleted", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const connector = await makeConnector(org.id);
      const kb = await KnowledgeBaseModel.create({
        organizationId: org.id,
        name: "Live KB",
      });
      await deleteConnector(connector.id);

      await expect(
        KnowledgeBaseConnectorModel.assignToKnowledgeBase(connector.id, kb.id),
      ).rejects.toBeInstanceOf(ApiError);
    });

    test("agent→KB assignment 404s when the KB is soft-deleted", async ({
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

      await expect(
        AgentKnowledgeBaseModel.assign(agent.id, kb.id),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    test("agent→connector assignment 404s when the connector is soft-deleted", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const connector = await makeConnector(org.id);
      await deleteConnector(connector.id);

      await expect(
        AgentConnectorAssignmentModel.assign(agent.id, connector.id),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
