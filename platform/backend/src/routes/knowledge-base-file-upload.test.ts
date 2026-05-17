import { eq } from "drizzle-orm";
import JSZip from "jszip";
import db, { schema } from "@/database";
import * as fileProcessor from "@/knowledge-base/connectors/file-upload/file-processor";
import { KbUploadedFileModel, KnowledgeBaseConnectorModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import type { User } from "@/types";

function buildJsonBody(
  files: Array<{ name: string; content: Buffer; mimeType: string }>,
): {
  payload: object;
} {
  return {
    payload: {
      files: files.map((f) => ({
        name: f.name,
        mimeType: f.mimeType,
        content: f.content.toString("base64"),
      })),
    },
  };
}

describe("connector file upload routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let fileUploadConnector: Awaited<
    ReturnType<typeof KnowledgeBaseConnectorModel.create>
  >;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: knowledgeBaseRoutes } = await import("./knowledge-base");
    await app.register(knowledgeBaseRoutes);

    fileUploadConnector = await KnowledgeBaseConnectorModel.create({
      organizationId,
      name: "File Upload Connector",
      connectorType: "file_upload",
      config: { type: "file_upload" },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe("POST /api/connectors/:id/files", () => {
    test("creates file and document records from an uploaded text file", async () => {
      const { payload } = buildJsonBody([
        {
          name: "notes.txt",
          content: Buffer.from("Hello, world!"),
          mimeType: "text/plain",
        },
      ]);

      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload,
      });

      expect(response.statusCode).toBe(200);
      const result = response.json();
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        filename: "notes.txt",
        status: "created",
      });
      expect(result.results[0].fileId).toBeDefined();
    });

    test("detects duplicate content and returns duplicate status", async () => {
      const content = Buffer.from("Duplicate content for dedup test");

      const { payload: payload1 } = buildJsonBody([
        { name: "first-upload.txt", content, mimeType: "text/plain" },
      ]);
      await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload: payload1,
      });

      const { payload: payload2 } = buildJsonBody([
        { name: "second-upload.txt", content, mimeType: "text/plain" },
      ]);
      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload: payload2,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().results[0]).toMatchObject({
        filename: "second-upload.txt",
        status: "duplicate",
      });
    });

    test("rejects files larger than the 10MB size limit", async () => {
      const oversized = Buffer.alloc(
        fileProcessor.MAX_FILE_SIZE_BYTES + 1,
        0x61,
      );
      const { payload } = buildJsonBody([
        { name: "toobig.txt", content: oversized, mimeType: "text/plain" },
      ]);

      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().results[0]).toMatchObject({
        filename: "toobig.txt",
        status: "too_large",
      });
    });

    test("accepts files at the 10MB size limit", async () => {
      vi.spyOn(fileProcessor, "extractTextFiles").mockResolvedValueOnce({
        extracted: [
          {
            filename: "maxsize.txt",
            text: "content at the limit",
            rawBytes: Buffer.from("content at the limit"),
            mimeType: "text/plain",
          },
        ],
        skipped: [],
      });

      const atLimit = Buffer.alloc(fileProcessor.MAX_FILE_SIZE_BYTES, 0x61);
      const { payload } = buildJsonBody([
        { name: "maxsize.txt", content: atLimit, mimeType: "text/plain" },
      ]);

      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().results[0]).toMatchObject({
        filename: "maxsize.txt",
        status: "created",
      });
    });

    test("rejects unsupported file types", async () => {
      const { payload } = buildJsonBody([
        {
          name: "program.exe",
          content: Buffer.from("binary content"),
          mimeType: "application/octet-stream",
        },
      ]);

      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().results[0]).toMatchObject({
        filename: "program.exe",
        status: "unsupported",
      });
    });

    test("returns 400 when the connector is not of file_upload type", async () => {
      const jiraConnector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: "Jira Connector For File Test",
        connectorType: "jira",
        config: {
          type: "jira",
          jiraBaseUrl: "https://test.atlassian.net",
          isCloud: true,
          projectKey: "TEST",
        },
      });

      const { payload } = buildJsonBody([
        {
          name: "test.txt",
          content: Buffer.from("text"),
          mimeType: "text/plain",
        },
      ]);

      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${jiraConnector.id}/files`,
        payload,
      });

      expect(response.statusCode).toBe(400);
    });

    test("returns 404 for a non-existent connector", async () => {
      const { payload } = buildJsonBody([
        {
          name: "test.txt",
          content: Buffer.from("text"),
          mimeType: "text/plain",
        },
      ]);

      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${crypto.randomUUID()}/files`,
        payload,
      });

      expect(response.statusCode).toBe(404);
    });

    test("handles zip files by extracting the text files inside", async () => {
      const zip = new JSZip();
      zip.file("readme.txt", "Content of the readme inside the zip");
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

      const { payload } = buildJsonBody([
        {
          name: "archive.zip",
          content: zipBuffer,
          mimeType: "application/zip",
        },
      ]);

      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload,
      });

      expect(response.statusCode).toBe(200);
      const result = response.json();
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        filename: "readme.txt",
        status: "created",
      });
    });

    test("extracts files from nested folders inside a zip", async () => {
      const zip = new JSZip();
      zip.file("docs/readme.txt", "Content in the docs folder");
      zip.file("docs/subfolder/notes.txt", "Content in a nested subfolder");
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

      const { payload } = buildJsonBody([
        { name: "nested.zip", content: zipBuffer, mimeType: "application/zip" },
      ]);

      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload,
      });

      expect(response.statusCode).toBe(200);
      const result = response.json();
      expect(result.results).toHaveLength(2);
      expect(result.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filename: "docs/readme.txt",
            status: "created",
          }),
          expect.objectContaining({
            filename: "docs/subfolder/notes.txt",
            status: "created",
          }),
        ]),
      );
    });

    test("extracts same-named files from different nested folders as distinct entries", async () => {
      const zip = new JSZip();
      zip.file("draft/report.txt", "Draft version of the report");
      zip.file("final/report.txt", "Final version of the report");
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

      const { payload } = buildJsonBody([
        {
          name: "reports.zip",
          content: zipBuffer,
          mimeType: "application/zip",
        },
      ]);

      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload,
      });

      expect(response.statusCode).toBe(200);
      const result = response.json();
      // Both files are created — not deduplicated despite sharing a basename
      expect(result.results).toHaveLength(2);
      expect(result.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filename: "draft/report.txt",
            status: "created",
          }),
          expect.objectContaining({
            filename: "final/report.txt",
            status: "created",
          }),
        ]),
      );

      // Verify both are stored as separate records with distinct paths
      const listResponse = await app.inject({
        method: "GET",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
      });
      const files = listResponse.json().data;
      expect(files).toHaveLength(2);
      const originalNames = files.map(
        (f: { originalName: string }) => f.originalName,
      );
      expect(originalNames).toContain("draft/report.txt");
      expect(originalNames).toContain("final/report.txt");
    });

    test("handles pdf files", async () => {
      vi.spyOn(fileProcessor, "extractTextFiles").mockResolvedValueOnce({
        extracted: [
          {
            filename: "report.pdf",
            text: "Extracted PDF text content",
            rawBytes: Buffer.from("pdf-like bytes"),
            mimeType: "application/pdf",
          },
        ],
        skipped: [],
      });

      const { payload } = buildJsonBody([
        {
          name: "report.pdf",
          content: Buffer.from("pdf-like bytes"),
          mimeType: "application/pdf",
        },
      ]);

      const response = await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().results[0]).toMatchObject({
        filename: "report.pdf",
        status: "created",
      });
    });

    test("handles a race: when the pre-check is bypassed the unique constraint prevents a double-insert and the conflict handler returns 'duplicate'", async () => {
      const content = Buffer.from("Identical content to trigger a race");

      // Step 1 — insert the first copy normally so a row exists in the DB.
      const { payload: firstPayload } = buildJsonBody([
        { name: "race-first.txt", content, mimeType: "text/plain" },
      ]);
      const first = await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload: firstPayload,
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().results[0].status).toBe("created");

      vi.spyOn(KbUploadedFileModel, "findByContentHash").mockResolvedValueOnce(
        null,
      );

      const { payload: secondPayload } = buildJsonBody([
        { name: "race-second.txt", content, mimeType: "text/plain" },
      ]);
      const second = await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload: secondPayload,
      });

      // The isContentHashConflict handler must catch the constraint violation
      // and return a graceful "duplicate" instead of a 500.
      expect(second.statusCode).toBe(200);
      expect(second.json().results[0]).toMatchObject({
        filename: "race-second.txt",
        status: "duplicate",
      });

      // The unique index must have prevented a second row from being inserted.
      const rows = await db
        .select()
        .from(schema.kbUploadedFilesTable)
        .where(
          eq(schema.kbUploadedFilesTable.connectorId, fileUploadConnector.id),
        );
      expect(rows).toHaveLength(1);
    });
  });

  describe("GET /api/connectors/:id/files/:fileId", () => {
    test("returns a single uploaded file by ID", async () => {
      const { payload } = buildJsonBody([
        {
          name: "single.txt",
          content: Buffer.from("Single file content"),
          mimeType: "text/plain",
        },
      ]);

      const uploadResponse = await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload,
      });

      const fileId = uploadResponse.json().results[0].fileId;

      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${fileUploadConnector.id}/files/${fileId}`,
      });

      expect(response.statusCode).toBe(200);
      const file = response.json();
      expect(file).toMatchObject({
        id: fileId,
        connectorId: fileUploadConnector.id,
        originalName: "single.txt",
        mimeType: "text/plain",
      });
      expect(file).toHaveProperty("embeddingStatus");
      expect(file).toHaveProperty("createdAt");
    });

    test("returns 404 when the file does not exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${fileUploadConnector.id}/files/${crypto.randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /api/connectors/:id/files", () => {
    test("returns an empty list when no files have been uploaded", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([]);
    });

    test("lists files uploaded to the connector", async () => {
      const { payload } = buildJsonBody([
        {
          name: "listed.txt",
          content: Buffer.from("File list test content"),
          mimeType: "text/plain",
        },
      ]);

      await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload,
      });

      const listResponse = await app.inject({
        method: "GET",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
      });

      expect(listResponse.statusCode).toBe(200);
      const listBody = listResponse.json();
      expect(listBody.data).toHaveLength(1);
      expect(listBody.data[0]).toMatchObject({
        originalName: "listed.txt",
        mimeType: "text/plain",
      });
      expect(listBody.data[0]).toHaveProperty("id");
      expect(listBody.data[0]).toHaveProperty("contentHash");
      expect(listBody.data[0]).toHaveProperty("embeddingStatus");
    });
  });

  describe("DELETE /api/connectors/:id/files/:fileId", () => {
    test("deletes an uploaded file and removes it from the file list", async () => {
      const { payload } = buildJsonBody([
        {
          name: "to-delete.txt",
          content: Buffer.from("Content to be deleted"),
          mimeType: "text/plain",
        },
      ]);

      const uploadResponse = await app.inject({
        method: "POST",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
        payload,
      });

      const fileId = uploadResponse.json().results[0].fileId;

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/connectors/${fileUploadConnector.id}/files/${fileId}`,
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json().success).toBe(true);

      const listResponse = await app.inject({
        method: "GET",
        url: `/api/connectors/${fileUploadConnector.id}/files`,
      });

      expect(listResponse.json().data).toHaveLength(0);
    });

    test("returns 404 when the file does not exist", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/api/connectors/${fileUploadConnector.id}/files/${crypto.randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
