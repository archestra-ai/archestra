import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { KbDirectoryModel, KbFileModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import type { AuditEventName } from "@/types/audit-log";

/**
 * A repository selection mixes two resources — documents and the directories
 * that hold them — so they get one bulk route each and the client sends at most
 * two requests for a mixed selection.
 */
describe("knowledge repository bulk routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);

    const { default: routes } = await import("./knowledge-file.routes");
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  const makeFile = (filename: string, orgId = organizationId) =>
    KbFileModel.create({
      organizationId: orgId,
      directoryId: null,
      filename,
      mimeType: "text/plain",
      sizeBytes: 5,
      contentHash: `hash-${filename}`,
      data: Buffer.from("hello"),
      uploadedBy: user.id,
    });

  const makeDirectory = (name: string, orgId = organizationId) =>
    KbDirectoryModel.create({
      organizationId: orgId,
      name,
      createdBy: user.id,
    });

  // Built per call: `user` is assigned in beforeEach, so a viewer captured at
  // describe time would close over undefined.
  const findFile = (id: string, orgId = organizationId) =>
    KbFileModel.findById({
      id,
      organizationId: orgId,
      viewer: { userId: user.id, teamIds: [], canManageAll: true },
    });

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

  describe("DELETE /api/knowledge-files/bulk", () => {
    const bulkDelete = (ids: unknown) =>
      app.inject({
        method: "DELETE",
        url: "/api/knowledge-files/bulk",
        payload: { ids },
      });

    test("deletes every named document and leaves the rest alone", async () => {
      const first = await makeFile("bulk-doc-a.txt");
      const second = await makeFile("bulk-doc-b.txt");
      const kept = await makeFile("bulk-doc-kept.txt");

      const response = await bulkDelete([first.id, second.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        succeeded: [
          { id: first.id, name: "bulk-doc-a.txt" },
          { id: second.id, name: "bulk-doc-b.txt" },
        ],
        failed: [],
      });
      expect(await findFile(first.id)).toBeNull();
      expect(await findFile(kept.id)).not.toBeNull();
    });

    test("reports a document from another organization as not found", async ({
      makeOrganization,
    }) => {
      const otherOrgId = (await makeOrganization()).id;
      const foreign = await makeFile("theirs.txt", otherOrgId);

      const response = await bulkDelete([foreign.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json().failed).toEqual([
        { id: foreign.id, name: null, error: "File not found" },
      ]);
      expect(await findFile(foreign.id, otherOrgId)).not.toBeNull();
    });

    test("rejects an empty batch", async () => {
      expect((await bulkDelete([])).statusCode).toBe(400);
    });

    test("writes one audit record covering the batch", async () => {
      const file = await makeFile("audited-doc.txt");

      expect((await bulkDelete([file.id])).statusCode).toBe(200);

      const rows = await auditRows("knowledgeFile.bulk_deleted");
      expect(rows).toHaveLength(1);
      expect(rows[0].resourceType).toBe("knowledgeFile");
      expect(rows[0].before).toMatchObject({
        files: [{ id: file.id, filename: "audited-doc.txt" }],
      });
      expect(rows[0].after).toMatchObject({ files: [] });
    });
  });

  describe("directories", () => {
    test("deletes every named directory", async () => {
      const first = await makeDirectory("bulk-dir-a");
      const second = await makeDirectory("bulk-dir-b");

      const response = await app.inject({
        method: "DELETE",
        url: "/api/knowledge-directories/bulk",
        payload: { ids: [first.id, second.id] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().failed).toEqual([]);
      expect(await KbDirectoryModel.findAll(organizationId)).toEqual([]);
    });

    test("reports a directory from another organization as not found", async ({
      makeOrganization,
    }) => {
      const otherOrgId = (await makeOrganization()).id;
      const foreign = await makeDirectory("theirs", otherOrgId);

      const response = await app.inject({
        method: "DELETE",
        url: "/api/knowledge-directories/bulk",
        payload: { ids: [foreign.id] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().failed).toEqual([
        { id: foreign.id, name: null, error: "Directory not found" },
      ]);
    });
  });
});
