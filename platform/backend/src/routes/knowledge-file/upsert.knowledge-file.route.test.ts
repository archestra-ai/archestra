import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { KbFileModel, KnowledgeBaseModel } from "@/models";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import routes from "./knowledge-file.routes";

describe("PUT knowledge file content", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let knowledgeBaseId: string;
  const id = randomUUID();
  beforeEach(async ({ makeOrganization, makeUser }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    knowledgeBaseId = (
      await KnowledgeBaseModel.create({
        organizationId,
        createdBy: user.id,
        name: "Market research",
      })
    ).id;
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(routes);
  });
  afterEach(async () => {
    await app.close();
  });
  const put = (
    content = "First market report",
    overrides: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: "PUT",
      url: `/api/knowledge-files/${id}/content`,
      payload: {
        filename: "market.md",
        mimeType: "text/markdown",
        content: Buffer.from(content).toString("base64"),
        knowledgeBaseId,
        ...overrides,
      },
    });
  const stored = () =>
    KbFileModel.findById({
      id,
      organizationId,
      viewer: { userId: user.id, teamIds: [], canManageAll: true },
    });

  test("creates, retries, and replaces one document and its searchable chunks", async () => {
    expect((await put()).statusCode).toBe(200);
    expect((await put()).json()).toMatchObject({
      id,
      results: [{ knowledgeBaseId, indexed: 1, failures: [] }],
    });
    expect((await put("Updated market report")).statusCode).toBe(200);
    expect(Buffer.from((await stored())?.data ?? []).toString()).toBe(
      "Updated market report",
    );
    const documents = await db.select().from(schema.kbDocumentsTable);
    expect(documents).toHaveLength(1);
    expect(documents[0].content).toBe("Updated market report");
    const chunks = await db.select().from(schema.kbChunksTable);
    expect(chunks.length).toBeGreaterThan(0);
    expect(
      chunks.every((chunk) => !chunk.content.includes("First market report")),
    ).toBe(true);
    await expect
      .poll(
        async () =>
          (
            await db
              .select()
              .from(schema.auditLogsTable)
              .where(
                eq(
                  schema.auditLogsTable.action,
                  "knowledgeFile.content_upserted",
                ),
              )
          ).length,
      )
      .toBe(3);
    const audit = await db
      .select()
      .from(schema.auditLogsTable)
      .where(
        eq(schema.auditLogsTable.action, "knowledgeFile.content_upserted"),
      );
    expect(
      audit.some(
        (row) => JSON.stringify(row.before) !== JSON.stringify(row.after),
      ),
    ).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("Updated market report");
  });

  test("preserves a private audience and refreshes every linked knowledge base", async () => {
    await put();
    await KbFileModel.update({ id, organizationId, visibility: "private" });
    const otherKb = await KnowledgeBaseModel.create({
      organizationId,
      createdBy: user.id,
      name: "Second research base",
    });
    expect(
      (await put("Private report", { knowledgeBaseId: otherKb.id })).json()
        .results,
    ).toHaveLength(2);
    expect((await stored())?.visibility).toBe("private");
    const documents = await db.select().from(schema.kbDocumentsTable);
    expect(documents).toHaveLength(2);
    expect(
      documents.every(
        (doc) =>
          doc.content === "Private report" &&
          doc.acl.includes(`user_email:${user.email}`),
      ),
    ).toBe(true);
  });

  test("refuses another uploader and leaves the original bytes intact", async ({
    makeUser,
  }) => {
    await put();
    user = await makeUser();
    expect((await put("Unauthorized replacement")).statusCode).toBe(409);
    expect(Buffer.from((await stored())?.data ?? []).toString()).toBe(
      "First market report",
    );
  });

  test("refuses a foreign knowledge base before creating a file", async ({
    makeOrganization,
  }) => {
    const other = await makeOrganization();
    const foreign = await KnowledgeBaseModel.create({
      organizationId: other.id,
      name: "Other base",
    });
    expect(
      (await put("Rejected", { knowledgeBaseId: foreign.id })).statusCode,
    ).toBe(404);
    expect(await stored()).toBeNull();
  });

  test("does not overwrite a foreign organization UUID", async ({
    makeOrganization,
    makeUser,
  }) => {
    await put();
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    knowledgeBaseId = (
      await KnowledgeBaseModel.create({ organizationId, name: "Other base" })
    ).id;
    expect((await put()).statusCode).toBe(409);
    expect(await stored()).toBeNull();
  });

  test("rejects oversized and unreadable replacements without changing the file", async () => {
    await put();
    expect(
      (await put("PK invalid", { filename: "invalid.zip" })).statusCode,
    ).toBe(400);
    expect((await put("   ")).statusCode).toBe(400);
    expect((await put("", { content: "not base64!" })).statusCode).toBe(400);
    config.knowledgeFiles.maxUploadBytes = 10;
    expect((await put("A replacement that is too large")).statusCode).toBe(413);
    expect(Buffer.from((await stored())?.data ?? []).toString()).toBe(
      "First market report",
    );
  });
});
