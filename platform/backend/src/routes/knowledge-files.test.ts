import { TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME } from "@shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import {
  AgentConnectorAssignmentModel,
  KbDocumentModel,
  KbUploadedFileModel,
  KnowledgeBaseConnectorModel,
  ToolModel,
} from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { taskQueueService } from "@/task-queue";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent, User } from "@/types";

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

function buildUploadPayload(params: {
  files: Array<{ name: string; content: Buffer; mimeType: string }>;
  visibility?: "personal" | "team" | "org";
  teamIds?: string[];
  agentIds?: string[];
}) {
  return {
    visibility: params.visibility ?? "personal",
    teamIds: params.teamIds ?? [],
    agentIds: params.agentIds ?? [],
    files: params.files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      content: file.content.toString("base64"),
    })),
  };
}

describe("knowledge file routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let agent: Agent;

  beforeEach(async ({ makeOrganization, makeUser, makeAgent }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    agent = await makeAgent({
      organizationId,
      agentType: "agent",
      name: "Research Agent",
      teams: [],
    });

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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("uploads a personal file and assigns it to selected agents", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: buildUploadPayload({
        agentIds: [agent.id],
        files: [
          {
            name: "agent-context.md",
            content: Buffer.from("# Context\nUse this document."),
            mimeType: "text/markdown",
          },
        ],
      }),
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.results[0]).toMatchObject({
      filename: "agent-context.md",
      status: "created",
    });

    const file = await KbUploadedFileModel.findById(result.results[0].fileId);
    expect(file).toMatchObject({
      organizationId,
      ownerId: user.id,
      visibility: "personal",
      teamIds: [],
      originalName: "agent-context.md",
    });

    const assignments = await AgentConnectorAssignmentModel.findByConnector(
      file?.connectorId ?? "",
    );
    expect(assignments.map((assignment) => assignment.agentId)).toEqual([
      agent.id,
    ]);
  });

  test("streams uploaded file content for inline preview and download", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: buildUploadPayload({
        files: [
          {
            name: "preview.txt",
            content: Buffer.from("Preview content"),
            mimeType: "text/plain",
          },
        ],
      }),
    });
    expect(upload.statusCode).toBe(200);
    const fileId = upload.json().results[0].fileId as string;

    const preview = await app.inject({
      method: "GET",
      url: `/api/knowledge-files/${fileId}/content`,
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.body).toBe("Preview content");
    expect(preview.headers["content-type"]).toContain("text/plain");
    expect(preview.headers["content-disposition"]).toContain("inline");
    expect(preview.headers["content-security-policy"]).toBe(
      "default-src 'none'; frame-ancestors 'self'",
    );

    const download = await app.inject({
      method: "GET",
      url: `/api/knowledge-files/${fileId}/content?download=true`,
    });

    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
  });

  test("does not expose personal files to other users in the same organization", async ({
    makeUser,
    makeMember,
  }) => {
    const upload = await app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: buildUploadPayload({
        files: [
          {
            name: "private-notes.txt",
            content: Buffer.from("Private notes"),
            mimeType: "text/plain",
          },
        ],
      }),
    });
    expect(upload.statusCode).toBe(200);
    const fileId = upload.json().results[0].fileId as string;

    const otherUser = await makeUser();
    await makeMember(otherUser.id, organizationId);
    user = otherUser;

    const list = await app.inject({
      method: "GET",
      url: "/api/knowledge-files?limit=20&offset=0",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual([]);

    const file = await app.inject({
      method: "GET",
      url: `/api/knowledge-files/${fileId}`,
    });
    expect(file.statusCode).toBe(404);
  });

  test("exposes the knowledge query tool immediately after assigning a file to an agent and MCP gateway", async ({
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    await seedAndAssignArchestraTools(agent.id);
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
      name: "Support Gateway",
      teams: [],
    });
    await seedAndAssignArchestraTools(gateway.id);

    await expectKnowledgeQueryTool(agent.id, false);
    await expectKnowledgeQueryTool(gateway.id, false);

    const upload = await app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: buildUploadPayload({
        agentIds: [agent.id, gateway.id],
        files: [
          {
            name: "retrieval-source.txt",
            content: Buffer.from("Retrieval content"),
            mimeType: "text/plain",
          },
        ],
      }),
    });

    expect(upload.statusCode).toBe(200);
    await expectKnowledgeQueryTool(agent.id, true);
    await expectKnowledgeQueryTool(gateway.id, true);
  });

  test("lists uploaded files with assigned agent summaries", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: buildUploadPayload({
        agentIds: [agent.id],
        files: [
          {
            name: "runbook.txt",
            content: Buffer.from("Operational notes"),
            mimeType: "text/plain",
          },
        ],
      }),
    });
    expect(upload.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/api/knowledge-files?limit=20&offset=0",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({
        originalName: "runbook.txt",
        visibility: "personal",
        assignedAgents: [
          expect.objectContaining({
            id: agent.id,
            name: "Research Agent",
          }),
        ],
      }),
    ]);
  });

  test("treats LIKE wildcard characters in file search as literals", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: buildUploadPayload({
        files: [
          {
            name: "literal%file.txt",
            content: Buffer.from("Percent file content"),
            mimeType: "text/plain",
          },
          {
            name: "literal-match-file.txt",
            content: Buffer.from("Hyphen file content"),
            mimeType: "text/plain",
          },
        ],
      }),
    });
    expect(upload.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/api/knowledge-files?limit=20&offset=0&search=%25",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({ originalName: "literal%file.txt" }),
    ]);
  });

  test("does not reprocess files when only agent assignments change", async ({
    makeAgent,
  }) => {
    const secondAgent = await makeAgent({
      organizationId,
      agentType: "agent",
      name: "Second Agent",
      teams: [],
    });
    const upload = await app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: buildUploadPayload({
        agentIds: [agent.id],
        files: [
          {
            name: "assignment-only.txt",
            content: Buffer.from("Assignment content"),
            mimeType: "text/plain",
          },
        ],
      }),
    });
    expect(upload.statusCode).toBe(200);
    const fileId = upload.json().results[0].fileId as string;

    const enqueueSpy = vi.spyOn(taskQueueService, "enqueue");
    const deleteDocumentSpy = vi.spyOn(
      KbDocumentModel,
      "deleteByConnectorAndSourceId",
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/knowledge-files/${fileId}`,
      payload: {
        visibility: "personal",
        teamIds: [],
        agentIds: [secondAgent.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(deleteDocumentSpy).not.toHaveBeenCalled();
    expect(response.json().assignedAgents).toEqual([
      expect.objectContaining({ id: secondAgent.id, name: "Second Agent" }),
    ]);
  });

  test("reprocesses files when visibility changes", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: buildUploadPayload({
        agentIds: [agent.id],
        files: [
          {
            name: "visibility-change.txt",
            content: Buffer.from("Visibility content"),
            mimeType: "text/plain",
          },
        ],
      }),
    });
    expect(upload.statusCode).toBe(200);
    const fileId = upload.json().results[0].fileId as string;
    const file = await KbUploadedFileModel.findById(fileId);
    if (!file) throw new Error("Expected uploaded file to exist");
    const connectorId = file.connectorId;

    const enqueueSpy = vi.spyOn(taskQueueService, "enqueue");
    const deleteDocumentSpy = vi.spyOn(
      KbDocumentModel,
      "deleteByConnectorAndSourceId",
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/knowledge-files/${fileId}`,
      payload: {
        visibility: "org",
        teamIds: [],
        agentIds: [agent.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().visibility).toBe("org");
    expect(deleteDocumentSpy).toHaveBeenCalledWith({
      connectorId,
      sourceId: fileId,
    });
    expect(enqueueSpy).toHaveBeenCalledWith({
      taskType: "process_uploaded_files",
      payload: {
        connectorId,
        fileIds: [fileId],
      },
    });
  });

  test("hides file upload connectors from the normal connector list", async () => {
    await KnowledgeBaseConnectorModel.create({
      organizationId,
      name: "Knowledge File: hidden.txt",
      connectorType: "file_upload",
      config: { type: "file_upload" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/connectors?limit=20&offset=0",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });

  test("rejects creating file upload connectors through connector CRUD", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/connectors",
      payload: {
        name: "Manual Files",
        connectorType: "file_upload",
        config: { type: "file_upload" },
        credentials: { apiToken: "unused" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("Knowledge > Files");
  });

  test("rejects unsupported file formats on the files page endpoint", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: buildUploadPayload({
        files: [
          {
            name: "notes.docx",
            content: Buffer.from("unsupported"),
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        ],
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([
      {
        filename: "notes.docx",
        status: "unsupported",
      },
    ]);
  });

  test("deletes the uploaded file and its backing connector", async () => {
    const upload = await app.inject({
      method: "POST",
      url: "/api/knowledge-files",
      payload: buildUploadPayload({
        files: [
          {
            name: "delete-me.txt",
            content: Buffer.from("Temporary content"),
            mimeType: "text/plain",
          },
        ],
      }),
    });
    const fileId = upload.json().results[0].fileId as string;
    const file = await KbUploadedFileModel.findById(fileId);
    if (!file) {
      throw new Error("Expected uploaded file to exist before deletion");
    }

    const response = await app.inject({
      method: "DELETE",
      url: `/api/knowledge-files/${fileId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(await KbUploadedFileModel.findById(fileId)).toBeNull();
    const connectors = await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.id, file.connectorId));
    expect(connectors).toEqual([]);
  });
});

async function expectKnowledgeQueryTool(agentId: string, expected: boolean) {
  const tools = await ToolModel.getMcpToolsByAgent(agentId);
  const toolNames = tools.map((tool) => tool.name);

  if (expected) {
    expect(toolNames).toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
    return;
  }

  expect(toolNames).not.toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
}
