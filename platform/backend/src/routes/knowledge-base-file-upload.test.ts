import { EmbeddingErrorCode } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { embeddingService } from "@/knowledge-base/embedder";
import { KbUploadedFileModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { handleProcessUploadedFiles } from "@/task-queue/handlers/process-uploaded-files-handler";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi as testVi,
} from "@/test";
import type { User } from "@/types";

const mockEmbeddingsCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    object: "list",
    data: [],
    model: "text-embedding-3-small",
    usage: { prompt_tokens: 0, total_tokens: 0 },
  }),
);

vi.mock("openai", () => {
  class MockOpenAI {
    static APIError = class APIError extends Error {
      status: number;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
      }
    };
    embeddings = { create: mockEmbeddingsCreate };
  }
  return { default: MockOpenAI };
});

vi.mock("@/knowledge-base/file-upload/blob-storage-providers", () => {
  const databaseProvider = {
    name: "db",
    put: async (params: { data: Buffer }) => ({
      provider: "db",
      key: null,
      dbData: params.data,
    }),
    get: async (params: { dbData: Buffer | null }) => params.dbData,
    delete: async () => {},
  };

  return {
    getConfiguredBlobStorageProvider: () => databaseProvider,
    getBlobStorageProvider: () => databaseProvider,
  };
});

function makeEmbeddingContext() {
  return {
    apiKey: "test-key",
    baseUrl: null,
    model: "text-embedding-3-small" as const,
    dimensions: 1536,
    provider: "openai" as const,
    inputModalities: null,
  };
}

function buildUploadPayload(
  files: Array<{ name: string; content: Buffer; mimeType: string }>,
) {
  return {
    visibility: "personal" as const,
    teamIds: [],
    agentIds: [],
    files: files.map((f) => ({
      name: f.name,
      mimeType: f.mimeType,
      content: f.content.toString("base64"),
    })),
  };
}

async function uploadFile(
  app: FastifyInstanceWithZod,
  file: { name: string; content: Buffer; mimeType: string },
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/knowledge-files",
    payload: buildUploadPayload([file]),
  });
  expect(response.statusCode).toBe(200);
  const fileId = response.json().results[0].fileId as string;
  const uploaded = await KbUploadedFileModel.findById(fileId);
  if (!uploaded) throw new Error("Expected uploaded file to exist");
  return { fileId, connectorId: uploaded.connectorId };
}

async function runWorkers(fileId: string, connectorId: string) {
  await handleProcessUploadedFiles({ connectorId, fileIds: [fileId] });
  const doc = await db
    .select()
    .from(schema.kbDocumentsTable)
    .where(
      and(
        eq(schema.kbDocumentsTable.connectorId, connectorId),
        eq(schema.kbDocumentsTable.sourceId, fileId),
      ),
    )
    .then((rows) => rows[0]);
  if (!doc) throw new Error("Expected document after upload worker");
  await embeddingService.processDocument(doc.id, makeEmbeddingContext());
}

describe("knowledge file upload processing", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

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

    mockEmbeddingsCreate.mockImplementation(
      async ({ input }: { input: string[] }) => ({
        object: "list",
        data: input.map((_, i) => ({
          object: "embedding",
          embedding: Array.from({ length: 1536 }, (__, j) => (i + j) * 0.001),
          index: i,
        })),
        model: "text-embedding-3-small",
        usage: {
          prompt_tokens: input.length * 5,
          total_tokens: input.length * 5,
        },
      }),
    );
  });

  afterEach(async () => {
    testVi.restoreAllMocks();
    await app.close();
  });

  describe("POST /api/knowledge-files", () => {
    test("detects duplicate content and returns duplicate status", async () => {
      const content = Buffer.from("Duplicate content for dedup test");

      const first = await app.inject({
        method: "POST",
        url: "/api/knowledge-files",
        payload: buildUploadPayload([
          { name: "first-upload.txt", content, mimeType: "text/plain" },
        ]),
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: "/api/knowledge-files",
        payload: buildUploadPayload([
          { name: "second-upload.txt", content, mimeType: "text/plain" },
        ]),
      });

      expect(second.statusCode).toBe(200);
      expect(second.json().results[0]).toMatchObject({
        filename: "second-upload.txt",
        status: "duplicate",
      });
    });

    test("handles a race: when the pre-check is bypassed the unique constraint prevents a double-insert and the conflict handler returns 'duplicate'", async () => {
      const content = Buffer.from("Identical content to trigger a race");

      const first = await app.inject({
        method: "POST",
        url: "/api/knowledge-files",
        payload: buildUploadPayload([
          { name: "race-first.txt", content, mimeType: "text/plain" },
        ]),
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().results[0].status).toBe("created");

      testVi
        .spyOn(KbUploadedFileModel, "findByContentHash")
        .mockResolvedValueOnce(null);

      const second = await app.inject({
        method: "POST",
        url: "/api/knowledge-files",
        payload: buildUploadPayload([
          { name: "race-second.txt", content, mimeType: "text/plain" },
        ]),
      });

      expect(second.statusCode).toBe(200);
      expect(second.json().results[0]).toMatchObject({
        filename: "race-second.txt",
        status: "duplicate",
      });

      const firstFileId = first.json().results[0].fileId as string;
      const firstFile = await KbUploadedFileModel.findById(firstFileId);
      if (!firstFile) throw new Error("Expected first file to exist");

      const rows = await db
        .select()
        .from(schema.kbUploadedFilesTable)
        .where(
          eq(schema.kbUploadedFilesTable.connectorId, firstFile.connectorId),
        );
      expect(rows).toHaveLength(1);
    });
  });

  describe("GET /api/knowledge-files/:fileId — embedding states", () => {
    test("returns basic file fields", async () => {
      const { fileId } = await uploadFile(app, {
        name: "single.txt",
        content: Buffer.from("Single file content"),
        mimeType: "text/plain",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/knowledge-files/${fileId}`,
      });

      expect(response.statusCode).toBe(200);
      const file = response.json();
      expect(file).toMatchObject({
        id: fileId,
        originalName: "single.txt",
        mimeType: "text/plain",
      });
      expect(file).toHaveProperty("embeddingStatus");
      expect(file).toHaveProperty("createdAt");
    });

    test("returns pending with null embeddingError before the worker runs", async () => {
      const { fileId } = await uploadFile(app, {
        name: "nodoc.txt",
        content: Buffer.from("Not yet embedded"),
        mimeType: "text/plain",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/knowledge-files/${fileId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().embeddingStatus).toBe("pending");
      expect(response.json().embeddingError).toBeNull();
    });

    test("returns completed with null embeddingError after workers succeed", async () => {
      const { fileId, connectorId } = await uploadFile(app, {
        name: "done.txt",
        content: Buffer.from("Fully embedded content"),
        mimeType: "text/plain",
      });

      await runWorkers(fileId, connectorId);

      const response = await app.inject({
        method: "GET",
        url: `/api/knowledge-files/${fileId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().embeddingStatus).toBe("completed");
      expect(response.json().embeddingError).toBeNull();
    });

    test("returns failed with embeddingError after embedding worker fails", async () => {
      const { fileId, connectorId } = await uploadFile(app, {
        name: "fail.txt",
        content: Buffer.from("Content that fails to embed"),
        mimeType: "text/plain",
      });

      await handleProcessUploadedFiles({ connectorId, fileIds: [fileId] });

      const OpenAIMod = (await import("openai")).default;
      const authError = Object.assign(new Error("Unauthorized"), {
        status: 401,
      });
      Object.setPrototypeOf(authError, OpenAIMod.APIError.prototype);
      mockEmbeddingsCreate.mockRejectedValueOnce(authError);

      const doc = await db
        .select()
        .from(schema.kbDocumentsTable)
        .where(
          and(
            eq(schema.kbDocumentsTable.connectorId, connectorId),
            eq(schema.kbDocumentsTable.sourceId, fileId),
          ),
        )
        .then((rows) => rows[0]);
      if (!doc) throw new Error("Expected document after upload worker");
      await embeddingService.processDocument(doc.id, makeEmbeddingContext());

      const response = await app.inject({
        method: "GET",
        url: `/api/knowledge-files/${fileId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().embeddingStatus).toBe("failed");
      expect(response.json().embeddingError).toBe(
        EmbeddingErrorCode.Authentication,
      );
    });

    test("returns 404 when the file does not exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/knowledge-files/${crypto.randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /api/knowledge-files — list embedding states", () => {
    test("returns an empty list when no files have been uploaded", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/knowledge-files",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([]);
    });

    test("returns pending with null embeddingError before the worker runs", async () => {
      await uploadFile(app, {
        name: "list-pending.txt",
        content: Buffer.from("Pending list content"),
        mimeType: "text/plain",
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/knowledge-files",
      });

      expect(response.statusCode).toBe(200);
      const item = response.json().data[0];
      expect(item.embeddingStatus).toBe("pending");
      expect(item.embeddingError).toBeNull();
    });

    test("returns completed with null embeddingError after workers succeed", async () => {
      const { fileId, connectorId } = await uploadFile(app, {
        name: "list-done.txt",
        content: Buffer.from("List completed content"),
        mimeType: "text/plain",
      });

      await runWorkers(fileId, connectorId);

      const response = await app.inject({
        method: "GET",
        url: "/api/knowledge-files",
      });

      expect(response.statusCode).toBe(200);
      const item = response.json().data[0];
      expect(item.embeddingStatus).toBe("completed");
      expect(item.embeddingError).toBeNull();
    });
  });

  describe("DELETE /api/knowledge-files/:fileId", () => {
    test("deletes an uploaded file and removes it from the file list", async () => {
      const { fileId } = await uploadFile(app, {
        name: "to-delete.txt",
        content: Buffer.from("Content to be deleted"),
        mimeType: "text/plain",
      });

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/knowledge-files/${fileId}`,
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json().success).toBe(true);

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/knowledge-files",
      });

      expect(listResponse.json().data).toHaveLength(0);
    });

    test("returns 404 when the file does not exist", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/api/knowledge-files/${crypto.randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
