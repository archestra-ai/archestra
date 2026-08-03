import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { KnowledgeBaseConnectorModel, KnowledgeBaseModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { AuditEventName, ConnectorConfig, User } from "@/types";

const jiraConfig: ConnectorConfig = {
  type: "jira",
  jiraBaseUrl: "https://trash-routes.atlassian.net",
  isCloud: true,
  projectKey: "TR",
};

/**
 * The knowledge trash lifecycle through the routes: `status=deleted` listings
 * (manage-deleted gated), restore, and permanent delete for knowledge bases
 * and connectors — plus the audit records each mutation must emit.
 */
describe("knowledge base + connector trash routes", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let memberUser: User;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    adminUser = await makeAdmin();
    await makeMember(adminUser.id, organizationId, { role: "admin" });
    memberUser = await makeUser();
    await makeMember(memberUser.id, organizationId, { role: "member" });
    currentUser = adminUser;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: currentUser, organizationId });
    });
    registerAuditLogHook(app);

    const { default: knowledgeBaseRoutes } = await import("./knowledge-base");
    await app.register(knowledgeBaseRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const makeKb = (name: string) =>
    KnowledgeBaseModel.create({ organizationId, name });

  const makeConnector = (name: string, enabled = true) =>
    KnowledgeBaseConnectorModel.create({
      organizationId,
      name,
      connectorType: "jira",
      config: jiraConfig,
      enabled,
    });

  const auditRow = async (action: AuditEventName, resourceId: string) => {
    let rows: Array<Record<string, unknown>> = [];
    await vi.waitFor(async () => {
      rows = await db
        .select({
          action: schema.auditLogsTable.action,
          resourceType: schema.auditLogsTable.resourceType,
          before: schema.auditLogsTable.before,
          after: schema.auditLogsTable.after,
        })
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.action, action),
            eq(schema.auditLogsTable.resourceId, resourceId),
            // The hook records denied/failed attempts too (e.g. the 404s these
            // tests provoke on purpose) — assert on the successful mutation.
            eq(schema.auditLogsTable.outcome, "success"),
          ),
        );
      expect(rows).toHaveLength(1);
    });
    return rows[0];
  };

  // ===== Knowledge bases =====

  test("status=deleted lists soft-deleted KBs for manage-deleted holders only", async () => {
    const kb = await makeKb("Trashed KB");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/knowledge-bases/${kb.id}`,
        })
      ).statusCode,
    ).toBe(200);

    const active = await app.inject({
      method: "GET",
      url: "/api/knowledge-bases",
    });
    expect(active.json().data.some((k: { id: string }) => k.id === kb.id)).toBe(
      false,
    );

    const deleted = await app.inject({
      method: "GET",
      url: "/api/knowledge-bases?status=deleted",
    });
    expect(deleted.statusCode).toBe(200);
    const row = deleted.json().data.find((k: { id: string }) => k.id === kb.id);
    expect(row).toBeDefined();
    expect(row.deletedAt).toEqual(expect.any(String));

    // An ordinary member (delete permission included) must not see the
    // org-wide tombstone view.
    currentUser = memberUser;
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/knowledge-bases?status=deleted",
        })
      ).statusCode,
    ).toBe(403);
  });

  test("KB restore revives the row with its connector links intact, and audits", async () => {
    const kb = await makeKb("Restorable KB");
    const connector = await makeConnector("Linked connector");
    expect(
      await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
        connector.id,
        kb.id,
      ),
    ).toBe(true);
    await app.inject({
      method: "DELETE",
      url: `/api/knowledge-bases/${kb.id}`,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/knowledge-bases/${kb.id}/restore`,
    });
    expect(response.statusCode).toBe(200);

    expect((await KnowledgeBaseModel.findById(kb.id))?.id).toBe(kb.id);
    // The junction was never stamped, so the link is live again immediately.
    const linked = await KnowledgeBaseConnectorModel.findByKnowledgeBaseId(
      kb.id,
      { canReadAll: true },
    );
    expect(linked.map((c) => c.id)).toContain(connector.id);

    // Restore is a trash action: an active row 404s, as does an unknown id.
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/knowledge-bases/${kb.id}/restore`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/knowledge-bases/${crypto.randomUUID()}/restore`,
        })
      ).statusCode,
    ).toBe(404);

    const audit = await auditRow("knowledgeBase.restored", kb.id);
    expect(audit).toMatchObject({ resourceType: "knowledgeBase" });
    expect(audit.before).toMatchObject({
      id: kb.id,
      deletedAt: expect.any(String),
    });
    expect(audit.after).toMatchObject({ id: kb.id, deletedAt: null });
  });

  test("KB purge is a trash action and audits identity-only", async () => {
    const active = await makeKb("Active KB");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/knowledge-bases/${active.id}/permanent`,
        })
      ).statusCode,
    ).toBe(404);
    expect((await KnowledgeBaseModel.findById(active.id))?.id).toBe(active.id);

    await app.inject({
      method: "DELETE",
      url: `/api/knowledge-bases/${active.id}`,
    });
    const response = await app.inject({
      method: "DELETE",
      url: `/api/knowledge-bases/${active.id}/permanent`,
    });
    expect(response.statusCode).toBe(200);
    expect(
      await KnowledgeBaseModel.findDeletedByIdForOrganization(
        active.id,
        organizationId,
      ),
    ).toBeNull();

    const audit = await auditRow("knowledgeBase.purged", active.id);
    expect(audit).toMatchObject({ resourceType: "knowledgeBase", after: null });
    // Identity-only `before` — never a full copy of purged content.
    expect(Object.keys(audit.before as Record<string, unknown>).sort()).toEqual(
      ["deletedAt", "id", "name"],
    );
  });

  // ===== Connectors =====

  test("restored connector comes back disabled and stays off the sync schedulers", async () => {
    const connector = await makeConnector("Sync connector", true);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/connectors/${connector.id}`,
        })
      ).statusCode,
    ).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: `/api/connectors/${connector.id}/restore`,
    });
    expect(response.statusCode).toBe(200);

    const restored = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(restored?.deletedAt).toBeNull();
    // The credential was destroyed at delete, so restore must not hand the
    // 30s schedulers an enabled, credential-less connector.
    expect(restored?.enabled).toBe(false);
    const enabledIds = (await KnowledgeBaseConnectorModel.findAllEnabled()).map(
      (c) => c.id,
    );
    expect(enabledIds).not.toContain(connector.id);

    const audit = await auditRow("connector.restored", connector.id);
    expect(audit).toMatchObject({ resourceType: "connector" });
    expect(audit.before).toMatchObject({ deletedAt: expect.any(String) });
    expect(audit.after).toMatchObject({ deletedAt: null });
  });

  test("connector restore succeeds while its knowledge bases are still deleted", async () => {
    const kb = await makeKb("Parent KB");
    const connector = await makeConnector("Orphaned connector");
    await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
      connector.id,
      kb.id,
    );
    await app.inject({
      method: "DELETE",
      url: `/api/connectors/${connector.id}`,
    });
    await app.inject({
      method: "DELETE",
      url: `/api/knowledge-bases/${kb.id}`,
    });

    // No parent-ordering rule: KB↔connector is m:n via an unstamped junction,
    // so a connector restored first is merely unassigned-looking.
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/connectors/${connector.id}/restore`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      await KnowledgeBaseModel.findDeletedByIdForOrganization(
        kb.id,
        organizationId,
      ),
    ).not.toBeNull();
  });

  test("connector status=deleted listing and purge, both gated and audited", async () => {
    const connector = await makeConnector("Purgeable connector");

    // Purge is a trash action: 404 while the connector is active.
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/connectors/${connector.id}/permanent`,
        })
      ).statusCode,
    ).toBe(404);

    await app.inject({
      method: "DELETE",
      url: `/api/connectors/${connector.id}`,
    });

    const deleted = await app.inject({
      method: "GET",
      url: "/api/connectors?status=deleted",
    });
    expect(deleted.statusCode).toBe(200);
    const row = deleted
      .json()
      .data.find((c: { id: string }) => c.id === connector.id);
    expect(row).toBeDefined();
    expect(row.deletedAt).toEqual(expect.any(String));

    currentUser = memberUser;
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/connectors?status=deleted",
        })
      ).statusCode,
    ).toBe(403);
    currentUser = adminUser;

    const response = await app.inject({
      method: "DELETE",
      url: `/api/connectors/${connector.id}/permanent`,
    });
    expect(response.statusCode).toBe(200);
    expect(
      await KnowledgeBaseConnectorModel.findDeletedByIdForOrganization(
        connector.id,
        organizationId,
      ),
    ).toBeNull();

    const audit = await auditRow("connector.purged", connector.id);
    expect(audit).toMatchObject({ resourceType: "connector", after: null });
    expect(Object.keys(audit.before as Record<string, unknown>).sort()).toEqual(
      ["connectorType", "deletedAt", "id", "name"],
    );
  });

  test("all four trash routes are gated on knowledgeSource:manage-deleted in the endpoint permission map", async () => {
    const { requiredEndpointPermissionsMap } = await import(
      "@archestra/shared/access-control"
    );
    for (const routeId of [
      "restoreKnowledgeBase",
      "purgeKnowledgeBase",
      "restoreConnector",
      "purgeConnector",
    ] as const) {
      expect(requiredEndpointPermissionsMap[routeId]).toEqual({
        knowledgeSource: ["manage-deleted"],
      });
    }
  });
});
