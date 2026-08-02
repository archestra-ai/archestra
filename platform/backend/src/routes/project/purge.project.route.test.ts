import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { FileModel, ProjectModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { fileStore } from "@/skills-sandbox/file-store";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// Purge mutates state and must produce an audit record, so this uses the full
// audit-hook harness (like restore.skill.route.test.ts) rather than
// useRouteTestApp.
describe("DELETE /api/projects/:id/permanent", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);

    const { default: projectRoutes } = await import("./project.routes");
    await app.register(projectRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const purge = (id: string) =>
    app.inject({ method: "DELETE", url: `/api/projects/${id}/permanent` });

  test("permanently deletes a soft-deleted project, its files, and audits identity-only", async () => {
    const project = await projectService.create({
      organizationId,
      userId: user.id,
      name: "purge-me",
      description: null,
    });
    const file = await fileStore.put({
      organizationId,
      userId: user.id,
      projectId: project.id,
      conversationId: null,
      filename: "kept.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      data: Buffer.from("abc"),
    });
    await projectService.delete({
      id: project.id,
      organizationId,
      userId: user.id,
    });

    const response = await purge(project.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    // Gone for good — not even the deleted view can see it.
    expect(
      await ProjectModel.findDeletedByIdForOrganization({
        id: project.id,
        organizationId,
      }),
    ).toBeNull();
    expect(await FileModel.findById(file.id)).toBeNull();

    // The audit row is written fire-and-forget by the onResponse hook.
    await vi.waitFor(async () => {
      const rows = await db
        .select({
          action: schema.auditLogsTable.action,
          resourceType: schema.auditLogsTable.resourceType,
          before: schema.auditLogsTable.before,
          after: schema.auditLogsTable.after,
        })
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.action, "project.purged"),
            eq(schema.auditLogsTable.resourceId, project.id),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "project.purged",
        resourceType: "project",
        after: null,
      });
      // Identity-only `before`: the audit trail records that the row is gone,
      // never a full copy of permanently deleted content.
      expect(rows[0].before).toMatchObject({
        id: project.id,
        name: "purge-me",
        deletedAt: expect.any(String),
      });
      expect(
        Object.keys(rows[0].before as Record<string, unknown>).sort(),
      ).toEqual(["deletedAt", "id", "name"]);
    });
  });

  test("404 for an active project — purge is a trash action, never a shortcut", async () => {
    const project = await projectService.create({
      organizationId,
      userId: user.id,
      name: "still-active",
      description: null,
    });

    expect((await purge(project.id)).statusCode).toBe(404);
    expect(await ProjectModel.findById(project.id)).not.toBeNull();
  });

  test("404 for another organization's deleted project", async ({
    makeOrganization,
    makeUser,
  }) => {
    const victimOrgId = (await makeOrganization()).id;
    const victimOwner = await makeUser();
    const project = await projectService.create({
      organizationId: victimOrgId,
      userId: victimOwner.id,
      name: "not-yours",
      description: null,
    });
    await projectService.delete({
      id: project.id,
      organizationId: victimOrgId,
      userId: victimOwner.id,
    });

    expect((await purge(project.id)).statusCode).toBe(404);
    expect(
      await ProjectModel.findDeletedByIdForOrganization({
        id: project.id,
        organizationId: victimOrgId,
      }),
    ).not.toBeNull();
  });
});
