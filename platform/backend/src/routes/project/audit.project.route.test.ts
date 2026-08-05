import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { AuditEventName, User } from "@/types";

vi.mock("@/observability");

/**
 * The project lifecycle is audited as a whole, so these run through the HTTP
 * layer: the audit record is written by a Fastify hook, and calling the service
 * directly would produce none. Deleting no longer removes the row and a project
 * admin can restore someone else's project, which is what makes the trail
 * necessary — see the `projectsTable` decision in middleware/audit-decisions.ts.
 */
describe("project routes — audit trail", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      const req = request as typeof request & {
        user: User;
        organizationId: string;
      };
      req.user = user;
      req.organizationId = organizationId;
    });
    registerAuditLogHook(app);

    const { default: projectRoutes } = await import("./project.routes");
    await app.register(projectRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const selectAuditRows = (resourceId: string, action: AuditEventName) =>
    db
      .select({
        action: schema.auditLogsTable.action,
        resourceType: schema.auditLogsTable.resourceType,
        resourceId: schema.auditLogsTable.resourceId,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, action),
          eq(schema.auditLogsTable.resourceId, resourceId),
        ),
      );

  /**
   * The onResponse hook writes the row fire-and-forget, so the response landing
   * does not mean the row has. Poll rather than assert straight through.
   */
  const auditRowsFor = async (resourceId: string, action: AuditEventName) => {
    await vi.waitFor(async () => {
      expect(await selectAuditRows(resourceId, action)).toHaveLength(1);
    });
    return selectAuditRows(resourceId, action);
  };

  const makeProject = async (name: string) =>
    projectService.create({
      organizationId,
      userId: user.id,
      name,
      description: null,
    });

  test("a soft delete is recorded as project.deleted, stamping deletedAt", async () => {
    const project = await makeProject("audited-delete");

    const response = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
    });
    expect(response.statusCode).toBe(200);

    const rows = await auditRowsFor(project.id, "project.deleted");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "project.deleted",
      resourceType: "project",
      resourceId: project.id,
    });
    // The prior state is the live project, which is what an operator needs to
    // see what was lost. `after` is null: a `.deleted` action on a DELETE has no
    // post-state by platform convention (resolveAfterState), the same record a
    // soft-deleted agent produces — the restore event carries the row's return.
    expect(rows[0].before).toMatchObject({
      name: "audited-delete",
      deletedAt: null,
    });
    expect(rows[0].after).toBeNull();
  });

  test("a restore is recorded as project.restored, clearing deletedAt", async () => {
    const project = await makeProject("audited-restore");
    await projectService.delete({
      id: project.id,
      organizationId,
      userId: user.id,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/restore`,
    });
    expect(response.statusCode).toBe(200);

    const rows = await auditRowsFor(project.id, "project.restored");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "project.restored",
      resourceType: "project",
      resourceId: project.id,
    });
    expect(rows[0].before).toMatchObject({ deletedAt: expect.any(String) });
    expect(rows[0].after).toMatchObject({ deletedAt: null });
  });

  test("a visibility change diffs, though it writes no column on the project row", async () => {
    const project = await makeProject("audited-share");

    const response = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/share`,
      payload: { visibility: "organization", teamIds: [], userIds: [] },
    });
    expect(response.statusCode).toBe(200);

    const rows = await auditRowsFor(project.id, "project.updated");
    expect(rows).toHaveLength(1);
    expect(rows[0].before).toMatchObject({ visibility: null });
    expect(rows[0].after).toMatchObject({ visibility: "organization" });
  });

  test("pinning is NOT audited — it is per-user state, not a project change", async () => {
    const project = await makeProject("audited-pin");

    const pinned = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/pin`,
    });
    expect(pinned.statusCode).toBe(200);

    // Audit rows are written fire-and-forget, so "no row yet" proves nothing.
    // Issue an audited request on the same project and wait for ITS row: once
    // that has landed, the pin ahead of it has had its chance.
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    await auditRowsFor(project.id, "project.deleted");

    // Denylisted; without that the pin would inherit project.updated by walk-up
    // and log an empty diff.
    expect(await selectAuditRows(project.id, "project.updated")).toHaveLength(
      0,
    );
  });

  test("a permanent delete is recorded as project.purged, by identity only", async () => {
    const project = await makeProject("audited-purge");
    await projectService.delete({
      id: project.id,
      organizationId,
      userId: user.id,
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/permanent`,
    });
    expect(response.statusCode).toBe(200);

    const rows = await auditRowsFor(project.id, "project.purged");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "project.purged",
      resourceType: "project",
      resourceId: project.id,
    });
    // Identity and nothing else. A purge destroys the project on request, so
    // its audit record must not preserve a copy of what was destroyed — unlike
    // `project.deleted` above, whose `before` carries the whole row precisely
    // because that row still exists and can be restored. Registering the route
    // is what makes the difference: by walk-up it would inherit
    // `/api/projects/:id`'s full-snapshot fetcher.
    expect(rows[0].before).toEqual({ id: project.id, name: "audited-purge" });
    expect(rows[0].after).toBeNull();
  });
});
