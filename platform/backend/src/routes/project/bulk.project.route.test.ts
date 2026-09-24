import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { ProjectModel } from "@/models";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("projects bulk routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let owner: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    owner = await makeUser();
    await makeMember(owner.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { organizationId, user: owner });
    });
    registerAuditLogHook(app);

    const { default: projectRoutes } = await import("./project.routes");
    await app.register(projectRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const makeProject = (name: string, userId = owner.id) =>
    projectService.create({
      organizationId,
      userId,
      name,
      description: null,
    });

  const bulkDelete = (ids: unknown) =>
    app.inject({
      method: "DELETE",
      url: "/api/projects/bulk",
      payload: { ids },
    });

  describe("DELETE /api/projects/bulk", () => {
    test("soft-deletes every named project and leaves the rest alone", async () => {
      const first = await makeProject("bulk-proj-a");
      const second = await makeProject("bulk-proj-b");
      const kept = await makeProject("bulk-proj-kept");

      const response = await bulkDelete([first.id, second.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        succeeded: [
          { id: first.id, name: "bulk-proj-a" },
          { id: second.id, name: "bulk-proj-b" },
        ],
        failed: [],
      });

      const remaining = await ProjectModel.findForBulk({
        ids: [first.id, second.id, kept.id],
        organizationId,
      });
      expect(remaining.map((project) => project.id)).toEqual([kept.id]);
    });

    test("reports a project from another organization as not found", async ({
      makeOrganization,
      makeUser,
    }) => {
      const otherOrgId = (await makeOrganization()).id;
      const stranger = await makeUser();
      const foreign = await projectService.create({
        organizationId: otherOrgId,
        userId: stranger.id,
        name: "theirs",
        description: null,
      });

      const response = await bulkDelete([foreign.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json().failed).toEqual([
        { id: foreign.id, name: null, error: "Project not found" },
      ]);
      expect(
        await ProjectModel.findForBulk({
          ids: [foreign.id],
          organizationId: otherOrgId,
        }),
      ).toHaveLength(1);
    });

    test("collapses duplicate ids", async () => {
      const project = await makeProject("dupe");

      const response = await bulkDelete([project.id, project.id]);

      expect(response.json().succeeded).toEqual([
        { id: project.id, name: "dupe" },
      ]);
    });

    test("rejects an empty batch", async () => {
      expect((await bulkDelete([])).statusCode).toBe(400);
    });

    test("writes one audit record covering the batch", async () => {
      const project = await makeProject("audited-proj");

      expect((await bulkDelete([project.id])).statusCode).toBe(200);

      const rows = await db
        .select({
          before: schema.auditLogsTable.before,
          after: schema.auditLogsTable.after,
          resourceType: schema.auditLogsTable.resourceType,
        })
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.action, "project.bulk_deleted"),
            eq(schema.auditLogsTable.organizationId, organizationId),
          ),
        );

      expect(rows).toHaveLength(1);
      expect(rows[0].resourceType).toBe("project");
      expect(rows[0].before).toMatchObject({
        projects: [{ id: project.id, name: "audited-proj", deleted: false }],
      });
      expect(rows[0].after).toMatchObject({
        projects: [{ id: project.id, deleted: true }],
      });
    });
  });
});
