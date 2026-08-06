import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import {
  AgentConnectorAssignmentModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
} from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type {
  AuditEventName,
  ConnectorConfig,
  InsertKnowledgeBaseConnector,
  User,
} from "@/types";

const jiraConfig: ConnectorConfig = {
  type: "jira",
  jiraBaseUrl: "https://trash-routes.atlassian.net",
  isCloud: true,
  projectKey: "TR",
};

/**
 * The knowledge trash lifecycle through the routes: `status=deleted` listings
 * (delete-gated), restore, and permanent delete (global admins only) for
 * knowledge bases and connectors — plus the audit records each mutation must
 * emit.
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

  const makeConnector = (
    name: string,
    overrides: Partial<InsertKnowledgeBaseConnector> = {},
  ) =>
    KnowledgeBaseConnectorModel.create({
      organizationId,
      name,
      connectorType: "jira",
      config: jiraConfig,
      enabled: true,
      ...overrides,
    });

  /**
   * Pins `createdAt`/`deletedAt` outright, so the ordering tests assert on a
   * fixed sequence instead of on whichever microsecond the inserts landed in.
   * Setting `deletedAt` IS the soft delete, so no separate DELETE is needed.
   */
  const stampLifecycle = (
    table:
      | typeof schema.knowledgeBasesTable
      | typeof schema.knowledgeBaseConnectorsTable,
    id: string,
    values: { createdAt: Date; deletedAt: Date },
  ) => db.update(table).set(values).where(eq(table.id, id));

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

    // An ordinary member holds knowledgeSource read+query but not delete, so
    // the trash — the delete permission's other half — stays closed to them.
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

  test("the KB trash sorts by deletedAt, the column it actually renders", async () => {
    // Created oldest-first, deleted newest-first, so `createdAt` and
    // `deletedAt` disagree: an ordering assertion that passed under either
    // would not be testing anything.
    const older = await makeKb("Created first, deleted last");
    const newer = await makeKb("Created last, deleted first");
    await stampLifecycle(schema.knowledgeBasesTable, older.id, {
      createdAt: new Date("2026-01-01T00:00:00Z"),
      deletedAt: new Date("2026-03-01T00:00:00Z"),
    });
    await stampLifecycle(schema.knowledgeBasesTable, newer.id, {
      createdAt: new Date("2026-02-01T00:00:00Z"),
      deletedAt: new Date("2026-01-15T00:00:00Z"),
    });

    const deleted = await app.inject({
      method: "GET",
      url: "/api/knowledge-bases?status=deleted",
    });
    expect(deleted.json().data.map((k: { id: string }) => k.id)).toEqual([
      older.id,
      newer.id,
    ]);

    // The active list is unchanged: newest-created first.
    await KnowledgeBaseModel.restore(older.id);
    await KnowledgeBaseModel.restore(newer.id);
    const active = await app.inject({
      method: "GET",
      url: "/api/knowledge-bases",
    });
    expect(active.json().data.map((k: { id: string }) => k.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  test("the KB trash pages a deletedAt tie without repeating or dropping a row", async () => {
    // A cascade hands `softDelete` one shared `at`, so a tie spanning a page
    // boundary is the normal case rather than the edge one. `createdAt` runs
    // opposite to the expected sequence, so the assertion can only pass on the
    // `id` tiebreaker.
    const tiedAt = new Date("2026-04-01T00:00:00Z");
    const kbs = [
      await makeKb("Tied one"),
      await makeKb("Tied two"),
      await makeKb("Tied three"),
    ];
    for (const [index, kb] of kbs.entries()) {
      await stampLifecycle(schema.knowledgeBasesTable, kb.id, {
        createdAt: new Date(Date.UTC(2026, 0, index + 1)),
        deletedAt: tiedAt,
      });
    }

    const page = async (offset: number) => {
      const response = await app.inject({
        method: "GET",
        url: `/api/knowledge-bases?status=deleted&limit=2&offset=${offset}`,
      });
      expect(response.statusCode).toBe(200);
      return response.json().data.map((k: { id: string }) => k.id);
    };

    // Descending uuid text order is descending uuid byte order, which is what
    // Postgres sorts on.
    const expected = kbs
      .map((kb) => kb.id)
      .sort()
      .reverse();
    expect([...(await page(0)), ...(await page(2))]).toEqual(expected);
  });

  // ===== Connectors =====

  test("the connector trash sorts by deletedAt, the column it actually renders", async () => {
    const older = await makeConnector("Created first, deleted last");
    const newer = await makeConnector("Created last, deleted first");
    await stampLifecycle(schema.knowledgeBaseConnectorsTable, older.id, {
      createdAt: new Date("2026-01-01T00:00:00Z"),
      deletedAt: new Date("2026-03-01T00:00:00Z"),
    });
    await stampLifecycle(schema.knowledgeBaseConnectorsTable, newer.id, {
      createdAt: new Date("2026-02-01T00:00:00Z"),
      deletedAt: new Date("2026-01-15T00:00:00Z"),
    });

    const deleted = await app.inject({
      method: "GET",
      url: "/api/connectors?status=deleted",
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data.map((c: { id: string }) => c.id)).toEqual([
      older.id,
      newer.id,
    ]);

    await KnowledgeBaseConnectorModel.restore(older.id);
    await KnowledgeBaseConnectorModel.restore(newer.id);
    const active = await app.inject({
      method: "GET",
      url: "/api/connectors",
    });
    expect(active.json().data.map((c: { id: string }) => c.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  test("the connector trash pages a deletedAt tie without repeating or dropping a row", async () => {
    const tiedAt = new Date("2026-04-01T00:00:00Z");
    const connectors = [
      await makeConnector("Tied one"),
      await makeConnector("Tied two"),
      await makeConnector("Tied three"),
    ];
    for (const [index, connector] of connectors.entries()) {
      await stampLifecycle(schema.knowledgeBaseConnectorsTable, connector.id, {
        createdAt: new Date(Date.UTC(2026, 0, index + 1)),
        deletedAt: tiedAt,
      });
    }

    const page = async (offset: number) => {
      const response = await app.inject({
        method: "GET",
        url: `/api/connectors?status=deleted&limit=2&offset=${offset}`,
      });
      expect(response.statusCode).toBe(200);
      return response.json().data.map((c: { id: string }) => c.id);
    };

    const expected = connectors
      .map((connector) => connector.id)
      .sort()
      .reverse();
    expect([...(await page(0)), ...(await page(2))]).toEqual(expected);
  });

  test("the trash lists a connector whose stored config no longer parses, so it stays recoverable", async () => {
    const connector = await makeConnector("Drifted config");
    // A config persisted by an older version and since drifted: the active
    // list drops it, and the trash — the only surface offering restore and
    // permanent delete — must not, or the row is stranded for good.
    await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set({
        config: {
          type: "jira",
          retiredField: true,
        } as unknown as ConnectorConfig,
      })
      .where(eq(schema.knowledgeBaseConnectorsTable.id, connector.id));

    const active = await app.inject({ method: "GET", url: "/api/connectors" });
    expect(active.statusCode).toBe(200);
    expect(
      active.json().data.some((c: { id: string }) => c.id === connector.id),
    ).toBe(false);

    await app.inject({
      method: "DELETE",
      url: `/api/connectors/${connector.id}`,
    });

    const deleted = await app.inject({
      method: "GET",
      url: "/api/connectors?status=deleted",
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      deleted.json().data.some((c: { id: string }) => c.id === connector.id),
    ).toBe(true);

    // Visible means reachable: both trash actions work on it.
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/connectors/${connector.id}/restore`,
        })
      ).statusCode,
    ).toBe(200);
    await app.inject({
      method: "DELETE",
      url: `/api/connectors/${connector.id}`,
    });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/connectors/${connector.id}/permanent`,
        })
      ).statusCode,
    ).toBe(200);
  });

  test("the connector trash returns identity only, skipping agent enrichment", async ({
    makeAgent,
  }) => {
    const connector = await makeConnector("Assigned connector");
    const agent = await makeAgent({ organizationId });
    await AgentConnectorAssignmentModel.assign(agent.id, connector.id);

    const active = await app.inject({ method: "GET", url: "/api/connectors" });
    expect(
      active
        .json()
        .data.find((c: { id: string }) => c.id === connector.id)
        .assignedAgents.map((a: { id: string }) => a.id),
    ).toEqual([agent.id]);

    await app.inject({
      method: "DELETE",
      url: `/api/connectors/${connector.id}`,
    });
    const deleted = await app.inject({
      method: "GET",
      url: "/api/connectors?status=deleted",
    });
    expect(
      deleted.json().data.find((c: { id: string }) => c.id === connector.id)
        .assignedAgents,
    ).toEqual([]);
  });

  test("restored connector comes back disabled and stays off the sync schedulers", async () => {
    const connector = await makeConnector("Sync connector");
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

  test("connector restore is gated on management visibility, not just the org", async ({
    makeCustomRole,
    makeMember,
    makeTeam,
    makeUser,
  }) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const otherTeam = await makeTeam(organizationId, adminUser.id);
    const teamScoped = await makeConnector("Team-scoped connector", {
      visibility: "team-scoped",
      teamIds: [otherTeam.id],
    });
    const autoSync = await makeConnector("Auto-sync connector", {
      visibility: "auto-sync-permissions",
    });
    for (const { id } of [teamScoped, autoSync]) {
      expect(
        (await app.inject({ method: "DELETE", url: `/api/connectors/${id}` }))
          .statusCode,
      ).toBe(200);
    }

    // A knowledgeSource:delete holder on no team and with no auto-sync grant.
    const deleter = await makeUser();
    await makeCustomRole(organizationId, {
      role: `kb_deleter_${suffix}`,
      permission: { knowledgeSource: ["read", "delete"] },
    });
    await makeMember(deleter.id, organizationId, {
      role: `kb_deleter_${suffix}`,
    });
    currentUser = deleter;

    // The trash listing already hides both rows from them...
    const listed = await app.inject({
      method: "GET",
      url: "/api/connectors?status=deleted",
    });
    expect(listed.statusCode).toBe(200);
    const listedIds = listed.json().data.map((c: { id: string }) => c.id);
    expect(listedIds).not.toContain(teamScoped.id);
    expect(listedIds).not.toContain(autoSync.id);

    // ...so restoring by id must not be the way around that: a connector the
    // caller may not edit or delete is one they may not revive either.
    for (const { id } of [teamScoped, autoSync]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/connectors/${id}/restore`,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        await KnowledgeBaseConnectorModel.findDeletedByIdForOrganization(
          id,
          organizationId,
        ),
      ).not.toBeNull();
    }

    // The same calls succeed for an admin, so the 404s above are the gate and
    // not a broken route.
    currentUser = adminUser;
    for (const { id } of [teamScoped, autoSync]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/connectors/${id}/restore`,
          })
        ).statusCode,
      ).toBe(200);
    }
  });

  test("knowledgeBaseId is rejected on the deleted slice, not silently dropped", async () => {
    const kb = await makeKb("Scoping guard");
    const connector = await makeConnector("Scoped connector");
    await app.inject({
      method: "DELETE",
      url: `/api/connectors/${connector.id}`,
    });

    // The per-knowledge-base path has no deleted-slice variant. Answering the
    // org-wide trash here would look like a scoped result and silently leak
    // every other knowledge base's deleted connectors into it.
    const response = await app.inject({
      method: "GET",
      url: `/api/connectors?status=deleted&knowledgeBaseId=${kb.id}`,
    });
    expect(response.statusCode).toBe(400);

    // The same id on the active slice still works.
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/connectors?knowledgeBaseId=${kb.id}`,
        })
      ).statusCode,
    ).toBe(200);
  });

  test("all four trash routes are gated on knowledgeSource:delete in the endpoint permission map", async () => {
    const { requiredEndpointPermissionsMap } = await import(
      "@archestra/shared/access-control"
    );
    // The permission map is only the outer gate — restore is the inverse of
    // delete, and the two permanent-delete handlers narrow further to a
    // built-in admin ROLE (asserted below), exactly as skills and projects do.
    for (const routeId of [
      "restoreKnowledgeBase",
      "permanentlyDeleteKnowledgeBase",
      "restoreConnector",
      "permanentlyDeleteConnector",
    ] as const) {
      expect(requiredEndpointPermissionsMap[routeId]).toEqual({
        knowledgeSource: ["delete"],
      });
    }
  });

  test("permanent delete answers 404, not 403, to a caller who is not a global admin", async () => {
    const kb = await makeKb("Admin-gated KB");
    const connector = await makeConnector("Admin-gated connector");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/knowledge-bases/${kb.id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/connectors/${connector.id}`,
        })
      ).statusCode,
    ).toBe(200);

    // 404 rather than 403, so the endpoint never confirms that a trashed
    // knowledge base or connector exists — the same answer a non-admin gets
    // for an id that was never real.
    currentUser = memberUser;

    for (const url of [
      `/api/knowledge-bases/${kb.id}/permanent`,
      `/api/connectors/${connector.id}/permanent`,
    ]) {
      expect((await app.inject({ method: "DELETE", url })).statusCode).toBe(
        404,
      );
    }

    // Still in the trash, not destroyed.
    expect(
      await KnowledgeBaseModel.findDeletedByIdForOrganization(
        kb.id,
        organizationId,
      ),
    ).not.toBeNull();
    expect(
      await KnowledgeBaseConnectorModel.findDeletedByIdForOrganization(
        connector.id,
        organizationId,
      ),
    ).not.toBeNull();
  });
});
