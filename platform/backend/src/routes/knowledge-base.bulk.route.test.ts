import { and, eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { KnowledgeBaseConnectorModel, KnowledgeBaseModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import type { AuditEventName } from "@/types/audit-log";

describe("knowledge bases and connectors bulk routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    config.kb.autoSyncPermissionsEnabled = true;
    user = await makeUser();
    organizationId = (await makeOrganization()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);

    const { default: knowledgeBaseRoutes } = await import("./knowledge-base");
    await app.register(knowledgeBaseRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const makeConnector = (name: string, orgId = organizationId) =>
    KnowledgeBaseConnectorModel.create({
      organizationId: orgId,
      name,
      connectorType: "jira",
      config: {
        type: "jira",
        jiraBaseUrl: `https://${name}.atlassian.net`,
        isCloud: true,
        projectKey: "CD",
      },
    });

  const makeKnowledgeBase = (name: string, orgId = organizationId) =>
    KnowledgeBaseModel.create({ organizationId: orgId, name });

  const auditRows = (action: AuditEventName) =>
    db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
        resourceType: schema.auditLogsTable.resourceType,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, action),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

  describe("DELETE /api/knowledge-bases/bulk", () => {
    const bulkDelete = (ids: unknown) =>
      app.inject({
        method: "DELETE",
        url: "/api/knowledge-bases/bulk",
        payload: { ids },
      });

    test("soft-deletes every named knowledge base and leaves the rest alone", async () => {
      const first = await makeKnowledgeBase("bulk-kb-a");
      const second = await makeKnowledgeBase("bulk-kb-b");
      const kept = await makeKnowledgeBase("bulk-kb-kept");

      const response = await bulkDelete([first.id, second.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        succeeded: [
          { id: first.id, name: "bulk-kb-a" },
          { id: second.id, name: "bulk-kb-b" },
        ],
        failed: [],
      });
      expect(await KnowledgeBaseModel.findById(first.id)).toBeNull();
      expect(await KnowledgeBaseModel.findById(kept.id)).not.toBeNull();
    });

    test("reports a knowledge base from another organization as not found", async ({
      makeOrganization,
    }) => {
      const otherOrgId = (await makeOrganization()).id;
      const foreign = await makeKnowledgeBase("theirs", otherOrgId);

      const response = await bulkDelete([foreign.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json().failed).toEqual([
        { id: foreign.id, name: null, error: "Knowledge base not found" },
      ]);
      expect(await KnowledgeBaseModel.findById(foreign.id)).not.toBeNull();
    });

    test("rejects an empty batch", async () => {
      expect((await bulkDelete([])).statusCode).toBe(400);
    });

    test("writes one audit record covering the batch", async () => {
      const kb = await makeKnowledgeBase("audited-kb");

      expect((await bulkDelete([kb.id])).statusCode).toBe(200);

      const rows = await auditRows("knowledgeBase.bulk_deleted");
      expect(rows).toHaveLength(1);
      expect(rows[0].resourceType).toBe("knowledgeBase");
      expect(rows[0].before).toMatchObject({
        knowledgeBases: [{ id: kb.id, name: "audited-kb" }],
      });
      expect(rows[0].after).toMatchObject({ knowledgeBases: [] });
    });
  });

  describe("DELETE /api/connectors/bulk", () => {
    const bulkDelete = (ids: unknown) =>
      app.inject({
        method: "DELETE",
        url: "/api/connectors/bulk",
        payload: { ids },
      });

    test("soft-deletes every named connector", async () => {
      const first = await makeConnector("bulk-conn-a");
      const second = await makeConnector("bulk-conn-b");
      const kept = await makeConnector("bulk-conn-kept");

      const response = await bulkDelete([first.id, second.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json().failed).toEqual([]);
      expect(await KnowledgeBaseConnectorModel.findById(first.id)).toBeNull();
      expect(
        await KnowledgeBaseConnectorModel.findById(kept.id),
      ).not.toBeNull();
    });

    test("reports a connector from another organization as not found", async ({
      makeOrganization,
    }) => {
      const otherOrgId = (await makeOrganization()).id;
      const foreign = await makeConnector("theirs", otherOrgId);

      const response = await bulkDelete([foreign.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json().failed).toEqual([
        { id: foreign.id, name: null, error: "Connector not found" },
      ]);
      expect(
        await KnowledgeBaseConnectorModel.findById(foreign.id),
      ).not.toBeNull();
    });
  });

  describe("PATCH /api/connectors/bulk", () => {
    const bulkPatch = (payload: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: "/api/connectors/bulk",
        payload,
      });

    test("moves every connector in the batch to one audience", async () => {
      const first = await makeConnector("vis-conn-a");
      const second = await makeConnector("vis-conn-b");

      const response = await bulkPatch({
        ids: [first.id, second.id],
        visibility: "org-wide",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        succeeded: [
          { id: first.id, name: "vis-conn-a" },
          { id: second.id, name: "vis-conn-b" },
        ],
        failed: [],
      });
    });

    /**
     * Team scope with no teams would leave every connector in the batch
     * reachable by nobody, so it is refused before anything is written.
     */
    test("rejects team scope with no teams, changing nothing", async () => {
      const connector = await makeConnector("stays-put");

      const response = await bulkPatch({
        ids: [connector.id],
        visibility: "team-scoped",
        teamIds: [],
      });

      expect(response.statusCode).toBe(400);
      expect(
        (await KnowledgeBaseConnectorModel.findById(connector.id))?.visibility,
      ).toBe("org-wide");
    });

    /**
     * Switching a connector to auto-sync fail-closes its whole corpus until a
     * permission pass completes, and is gated on the connector's own type, so
     * the bulk route does not accept it at all.
     */
    test("will not set auto-sync-permissions in bulk", async () => {
      const connector = await makeConnector("no-auto-sync");

      const response = await bulkPatch({
        ids: [connector.id],
        visibility: "auto-sync-permissions",
      });

      expect(response.statusCode).toBe(400);
      expect(
        (await KnowledgeBaseConnectorModel.findById(connector.id))?.visibility,
      ).toBe("org-wide");
    });

    test("writes one audit record covering the batch", async () => {
      const connector = await makeConnector("audited-conn");

      expect(
        (
          await bulkPatch({
            ids: [connector.id],
            visibility: "org-wide",
          })
        ).statusCode,
      ).toBe(200);

      const rows = await auditRows("connector.bulk_updated");
      expect(rows).toHaveLength(1);
      expect(rows[0].resourceType).toBe("connector");
      expect(rows[0].before).toMatchObject({
        connectors: [{ id: connector.id, name: "audited-conn" }],
      });
    });
  });
});
