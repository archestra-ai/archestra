/**
 * The MCP File Uploads extension end to end: a REAL upstream server that
 * speaks 2026-07-28 and the files extension (and 2025-11-25 for the pooled
 * connection), the real tool sync, and the real gateway route over a socket.
 * The caller is plain HTTP, as a 2026-07-28 client is.
 */

import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { MCP_FILES_EXTENSION_ID } from "@archestra/shared";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import mcpClient from "@/clients/mcp-client";
import {
  AgentToolModel,
  McpServerModel,
  McpToolCallModel,
  ToolModel,
  UserTokenModel,
} from "@/models";
import { reloadToolsForServer } from "@/services/mcp-reinstall";
import { afterEach, describe, expect, type TestFixtures, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { agentOwner } from "@/types/tool-owner";
import mcpGatewayRoutes from "./index";

setupTestCacheManager();

const UPSTREAM_SECRET = `upstream-secret-${randomUUID()}`;
const FILE_BYTES = Buffer.from("%PDF-1.7 quarterly report\n".repeat(64));

type Fixtures = Pick<
  TestFixtures,
  | "makeOrganization"
  | "makeUser"
  | "makeMember"
  | "makeAgent"
  | "makeInternalMcpCatalog"
  | "makeMcpServer"
  | "makeSecret"
>;

describe("MCP gateway - File Uploads extension", () => {
  let upstream: Upstream | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await mcpClient.disconnectAll();
    await upstream?.close();
    await app?.close();
    upstream = undefined;
    app = undefined;
  });

  async function setUp(fixtures: Fixtures, options: UpstreamOptions) {
    upstream = await startUpstream(options);
    const install = await installAndSync(fixtures, upstream.url);
    app = await gatewayApp();
    const gateway = gatewayClient(app, install.agentId, install.token);
    return { upstream, install, gateway };
  }

  test("server/discover advertises uploads with an inline limit", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway } = await setUp(fixtures, { mode: "url" });
    const discover = await gateway.rpc("server/discover", {});
    expect(
      discover.body.result.capabilities.extensions[MCP_FILES_EXTENSION_ID],
    ).toEqual({ upload: {}, maxInlineBytes: 8 * 1024 * 1024 });
  });

  test("a tool the upstream only lists to files clients is synced, and listed only to them", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install } = await setUp(fixtures, { mode: "url" });

    const plain = await gateway.rpc("tools/list", {}, { declareFiles: false });
    const plainNames = plain.body.result.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(plainNames).toContain(install.echoToolName);
    expect(plainNames).not.toContain(install.saveToolName);

    const withFiles = await gateway.rpc(
      "tools/list",
      {},
      { declareFiles: true },
    );
    const saveTool = withFiles.body.result.tools.find(
      (t: { name: string }) => t.name === install.saveToolName,
    );
    expect(saveTool.inputSchema.properties.file["x-mcp-file"]).toEqual({
      maxSize: 1024 * 1024,
    });
  });

  test("url/omit target: the caller uploads to the gateway, the bytes reach upstream storage without a credential, and the retry runs the tool", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install, upstream } = await setUp(fixtures, {
      mode: "url",
    });

    const first = await gateway.callSave(install.saveToolName, fileInput());
    expect(first.body.result.resultType).toBe("upload_required");
    const [target] = first.body.result.uploads;
    expect(target).toEqual({
      fileId: "file-1",
      path: expect.stringMatching(/^\/files\/[A-Za-z0-9_-]{43}$/),
      method: "PUT",
      credentials: "include",
      expiresAt: expect.any(String),
    });
    // Neither the upstream's storage address nor its state reaches the caller.
    const firstJson = JSON.stringify(first.body);
    expect(firstJson).not.toContain(upstream.url.replace(/\/mcp$/, ""));
    expect(firstJson).not.toContain("upstream-state-");

    const upload = await gateway.upload(target.path, FILE_BYTES);
    expect(upload.status).toBe(200);
    expect(upstream.stored.get("file-1")).toEqual(FILE_BYTES);
    const storageRequest = upstream.uploads.at(-1);
    expect(storageRequest?.headers.authorization).toBeUndefined();
    expect(storageRequest?.headers["content-type"]).toBe("application/pdf");

    const retry = await gateway.callSave(install.saveToolName, fileInput(), {
      requestState: first.body.result.requestState,
    });
    expect(retry.body.result.isError).toBeFalsy();
    expect(retry.body.result.content[0].text).toBe(
      `saved Q3 report.pdf: ${FILE_BYTES.length} bytes, sha256 ${sha256(FILE_BYTES)}`,
    );

    // Spent: the same state cannot run the tool twice.
    const replay = await gateway.callSave(install.saveToolName, fileInput(), {
      requestState: first.body.result.requestState,
    });
    expect(replay.body.error.code).toBe(-32602);
  });

  test("path/include target: the relay attaches only the upstream's own credential", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install, upstream } = await setUp(fixtures, {
      mode: "path-include",
    });

    const first = await gateway.callSave(install.saveToolName, fileInput());
    const [target] = first.body.result.uploads;
    const upload = await gateway.upload(target.path, FILE_BYTES);
    expect(upload.status).toBe(200);

    const uploadRequest = upstream.uploads.at(-1);
    expect(uploadRequest?.path).toMatch(/^\/mcp\/uploads\//);
    expect(uploadRequest?.headers.authorization).toBe(
      `Bearer ${UPSTREAM_SECRET}`,
    );
    // The caller's gateway token never travels upstream.
    expect(JSON.stringify(upstream.uploads)).not.toContain(install.token);

    const retry = await gateway.callSave(install.saveToolName, fileInput(), {
      requestState: first.body.result.requestState,
    });
    expect(retry.body.result.content[0].text).toContain(
      `${FILE_BYTES.length} bytes`,
    );
  });

  test("form target: the caller PUTs raw bytes and the relay builds the multipart POST", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install, upstream } = await setUp(fixtures, {
      mode: "form",
    });

    const first = await gateway.callSave(
      install.saveToolName,
      fileInput({ name: 'reports/Q3 "final".pdf' }),
    );
    const [target] = first.body.result.uploads;
    expect(target.method).toBe("PUT");
    expect(target).not.toHaveProperty("form");

    const upload = await gateway.upload(target.path, FILE_BYTES);
    expect(upload.status).toBe(200);
    const form = upstream.forms.at(-1);
    expect(form?.fields).toEqual([
      ["key", "uploads/file-1"],
      ["policy", "signed-policy"],
    ]);
    expect(form?.fileField).toBe("file");
    expect(form?.filename).toBe("Q3 %22final%22.pdf");
    expect(form?.contentType).toBe("application/pdf");
    expect(upstream.stored.get("file-1")).toEqual(FILE_BYTES);

    const retry = await gateway.callSave(
      install.saveToolName,
      fileInput({ name: 'reports/Q3 "final".pdf' }),
      { requestState: first.body.result.requestState },
    );
    expect(retry.body.result.isError).toBeFalsy();
  });

  test("a retry before every file arrived does not run the tool and keeps the state redeemable", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install } = await setUp(fixtures, { mode: "url" });

    const first = await gateway.callSave(install.saveToolName, fileInput());
    const early = await gateway.callSave(install.saveToolName, fileInput(), {
      requestState: first.body.result.requestState,
    });
    expect(early.body.result.isError).toBe(true);
    expect(early.body.result.content[0].text).toContain(
      "Not every file was uploaded",
    );

    await gateway.upload(first.body.result.uploads[0].path, FILE_BYTES);
    const retry = await gateway.callSave(install.saveToolName, fileInput(), {
      requestState: first.body.result.requestState,
    });
    expect(retry.body.result.isError).toBeFalsy();
  });

  test("the retry must repeat the call exactly", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install } = await setUp(fixtures, { mode: "url" });

    const first = await gateway.callSave(install.saveToolName, fileInput());
    const tampered = await gateway.callSave(
      install.saveToolName,
      fileInput({ name: "other.pdf" }),
      { requestState: first.body.result.requestState },
    );
    expect(tampered.status).toBe(400);
    expect(tampered.body.error).toEqual({
      code: -32602,
      message: "Invalid requestState (request_mismatch).",
    });
  });

  test("an upload target works only for the caller it was issued to", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install, upstream } = await setUp(fixtures, {
      mode: "url",
    });
    const first = await gateway.callSave(install.saveToolName, fileInput());

    const otherUser = await fixtures.makeUser();
    await fixtures.makeMember(otherUser.id, install.organizationId, {
      role: "admin",
    });
    const { value: otherToken } = await UserTokenModel.create(
      otherUser.id,
      install.organizationId,
    );
    const stolen = await gateway.upload(
      first.body.result.uploads[0].path,
      FILE_BYTES,
      "PUT",
      otherToken,
    );
    expect(stolen.status).toBe(404);
    expect(upstream.stored.has("file-1")).toBe(false);

    // The owner can still use it.
    const upload = await gateway.upload(
      first.body.result.uploads[0].path,
      FILE_BYTES,
    );
    expect(upload.status).toBe(200);
  });

  test("bytes that do not match the declared size or digest never complete upstream", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install, upstream } = await setUp(fixtures, {
      mode: "url",
    });

    const first = await gateway.callSave(
      install.saveToolName,
      fileInput({
        digest: { algorithm: "sha-256", value: sha256(FILE_BYTES) },
      }),
    );
    const path = first.body.result.uploads[0].path;

    const tooLong = await gateway.upload(
      path,
      Buffer.concat([FILE_BYTES, Buffer.from("x")]),
    );
    expect(tooLong.status).toBe(400);

    const tampered = Buffer.from(FILE_BYTES);
    tampered[0] = 0x00;
    const wrongDigest = await gateway.upload(path, tampered);
    expect(wrongDigest.status).toBe(502);
    expect(upstream.stored.has("file-1")).toBe(false);

    // A failed PUT leaves the target usable for the real bytes.
    const upload = await gateway.upload(path, FILE_BYTES);
    expect(upload.status).toBe(200);
    expect(upstream.stored.get("file-1")).toEqual(FILE_BYTES);
  });

  test("a caller that did not declare uploads gets MissingRequiredClientCapability", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install } = await setUp(fixtures, { mode: "url" });
    const response = await gateway.callSave(install.saveToolName, fileInput(), {
      declareUpload: false,
    });
    expect(response.body.error.code).toBe(-32021);
    expect(response.body.error.data).toEqual({
      requiredCapabilities: {
        extensions: { [MCP_FILES_EXTENSION_ID]: { upload: {} } },
      },
    });
  });

  test("an inline file within the upstream's limit goes inline, and the record keeps no bytes", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install } = await setUp(fixtures, {
      mode: "url",
      maxInlineBytes: 64 * 1024,
    });
    const response = await gateway.callSave(
      install.saveToolName,
      fileInput({ data: FILE_BYTES.toString("base64") }),
      { declareUpload: false },
    );
    expect(response.body.result.isError).toBeFalsy();
    expect(response.body.result.content[0].text).toContain("inline");

    const rows = await toolCallRows(install.agentId, install.saveToolName);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].toolCall)).not.toContain(
      FILE_BYTES.toString("base64"),
    );
    expect(JSON.stringify(rows[0].toolCall)).toContain(
      `[${FILE_BYTES.length} bytes omitted]`,
    );
  });

  test("an inline file over the upstream's limit is refused without running the tool", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install, upstream } = await setUp(fixtures, {
      mode: "url",
      maxInlineBytes: 16,
    });
    const response = await gateway.callSave(
      install.saveToolName,
      fileInput({ data: FILE_BYTES.toString("base64") }),
    );
    expect(response.body.result.isError).toBe(true);
    expect(response.body.result.content[0].text).toContain("at most 16 inline");
    expect(upstream.toolCalls).toBe(0);
  });

  test("inline data that does not match its declared size is refused", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install, upstream } = await setUp(fixtures, {
      mode: "url",
      maxInlineBytes: 64 * 1024,
    });
    const response = await gateway.callSave(
      install.saveToolName,
      fileInput({ data: Buffer.from("short").toString("base64") }),
    );
    expect(response.body.result.isError).toBe(true);
    expect(response.body.result.content[0].text).toContain("decodes to 5");
    expect(upstream.toolCalls).toBe(0);
  });

  test("a second upload request in one call fails the call", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install } = await setUp(fixtures, {
      mode: "url",
      askTwice: true,
    });
    const first = await gateway.callSave(install.saveToolName, fileInput());
    await gateway.upload(first.body.result.uploads[0].path, FILE_BYTES);
    const retry = await gateway.callSave(install.saveToolName, fileInput(), {
      requestState: first.body.result.requestState,
    });
    expect(retry.body.result.isError).toBe(true);
    expect(retry.body.result.content[0].text).toContain("a second time");
  });

  test("repeating an upload that already arrived succeeds without sending it again", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install, upstream } = await setUp(fixtures, {
      mode: "url",
    });
    const first = await gateway.callSave(install.saveToolName, fileInput());
    const [target] = first.body.result.uploads;
    expect((await gateway.upload(target.path, FILE_BYTES)).status).toBe(200);
    const sent = upstream.uploads.length;
    expect((await gateway.upload(target.path, FILE_BYTES)).status).toBe(200);
    expect(upstream.uploads).toHaveLength(sent);
    expect((await gateway.upload(target.path, FILE_BYTES, "POST")).status).toBe(
      404,
    );
    const longer = Buffer.concat([FILE_BYTES, Buffer.from("x")]);
    expect((await gateway.upload(target.path, longer)).status).toBe(400);
  });

  test("a caller that did not declare the extension cannot call a file tool", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install, upstream } = await setUp(fixtures, {
      mode: "url",
      maxInlineBytes: 64 * 1024,
    });
    const response = await gateway.callSave(
      install.saveToolName,
      fileInput({ data: FILE_BYTES.toString("base64") }),
      { declareFiles: false },
    );
    expect(response.body.error.code).toBe(-32021);
    expect(response.body.error.data).toEqual({
      requiredCapabilities: { extensions: { [MCP_FILES_EXTENSION_ID]: {} } },
    });
    expect(upstream.toolCalls).toBe(0);
  });

  test("a file argument that is not a file input is refused, and its bytes are not recorded", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { gateway, install, upstream } = await setUp(fixtures, {
      mode: "url",
      maxInlineBytes: 64 * 1024,
    });
    const notAnObject = await gateway.callSave(
      install.saveToolName,
      "report.pdf",
    );
    expect(notAnObject.body.result.isError).toBe(true);
    expect(notAnObject.body.result.content[0].text).toContain(
      "not a file input object",
    );

    const data = FILE_BYTES.toString("base64");
    const invalid = await gateway.callSave(
      install.saveToolName,
      fileInput({ id: "", data }),
    );
    expect(invalid.body.result.isError).toBe(true);
    const rows = await toolCallRows(install.agentId, install.saveToolName);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.map((row) => row.toolCall))).not.toContain(data);
    expect(upstream.toolCalls).toBe(0);
  });

  test("a file tool called outside the gateway's files path is refused", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeSecret,
  }) => {
    const fixtures: Fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeSecret,
    };
    const { install, upstream } = await setUp(fixtures, {
      mode: "url",
      maxInlineBytes: 64 * 1024,
    });
    const data = FILE_BYTES.toString("base64");
    // How run_tool, chat and apps call a tool: no files plan.
    const result = await mcpClient.executeToolCallForOwner(
      {
        id: randomUUID(),
        name: install.saveToolName,
        arguments: { folder: "x", file: fileInput({ data }) },
      },
      agentOwner(install.agentId),
      {
        tokenId: install.tokenId,
        teamId: null,
        isOrganizationToken: false,
        isUserToken: true,
        userId: install.userId,
        organizationId: install.organizationId,
      },
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("This tool takes files");
    const rows = await toolCallRows(install.agentId, install.saveToolName);
    expect(JSON.stringify(rows.map((row) => row.toolCall))).not.toContain(data);
    expect(upstream.toolCalls).toBe(0);
  });
});

// =============================================================================
// Helpers
// =============================================================================

function fileInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "file-1",
    name: "Q3 report.pdf",
    mimeType: "application/pdf",
    size: FILE_BYTES.length,
    ...overrides,
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

async function toolCallRows(agentId: string, toolName: string) {
  const rows = await McpToolCallModel.getAllMcpToolCallsForAgent(agentId);
  return rows.filter((row) => row.toolCall?.name === toolName);
}

async function installAndSync(fixtures: Fixtures, url: string) {
  const org = await fixtures.makeOrganization();
  const user = await fixtures.makeUser();
  await fixtures.makeMember(user.id, org.id, { role: "admin" });
  const agent = await fixtures.makeAgent({
    organizationId: org.id,
    agentType: "mcp_gateway",
    toolExposureMode: "full",
    accessAllTools: false,
  });
  const catalog = await fixtures.makeInternalMcpCatalog({
    organizationId: org.id,
    name: "files",
    serverType: "remote",
    serverUrl: url,
  });
  const secret = await fixtures.makeSecret({
    secret: { access_token: UPSTREAM_SECRET },
  });
  const { id: serverId } = await fixtures.makeMcpServer({
    name: catalog.name,
    catalogId: catalog.id,
    ownerId: user.id,
    serverType: "remote",
    secretId: secret.id,
  });
  const server = await McpServerModel.findById(serverId);
  if (!server) throw new Error("server not created");

  await reloadToolsForServer(server);
  const rows = await ToolModel.findByCatalogIdWithMeta(catalog.id, {
    kind: "caller",
  });
  for (const row of rows) {
    await AgentToolModel.create(agent.id, row.id, { mcpServerId: serverId });
  }

  const { value: token, token: tokenRecord } = await UserTokenModel.create(
    user.id,
    org.id,
  );
  return {
    agentId: agent.id,
    organizationId: org.id,
    userId: user.id,
    tokenId: tokenRecord.id,
    token,
    saveToolName: ToolModel.slugifyName(catalog.name, "save_file"),
    echoToolName: ToolModel.slugifyName(catalog.name, "echo"),
  };
}

async function gatewayApp(): Promise<FastifyInstance> {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(mcpGatewayRoutes);
  await app.listen({ port: 0, host: "127.0.0.1" });
  return app;
}

/** A 2026-07-28 client of the gateway, speaking plain HTTP. */
function gatewayClient(app: FastifyInstance, agentId: string, token: string) {
  const { port } = app.server.address() as AddressInfo;
  const address = `http://127.0.0.1:${port}/v1/mcp/${agentId}`;

  const rpc = async (
    method: string,
    params: Record<string, unknown>,
    options: {
      declareFiles?: boolean;
      declareUpload?: boolean;
      name?: string;
    } = {},
  ) => {
    const declareFiles = options.declareFiles ?? true;
    const declareUpload = options.declareUpload ?? true;
    const response = await fetch(address, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(options.name && { "mcp-name": options.name }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "files-test",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": declareFiles
              ? {
                  extensions: {
                    [MCP_FILES_EXTENSION_ID]: declareUpload
                      ? { upload: {} }
                      : {},
                  },
                }
              : {},
          },
        },
      }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are asserted field by field
    return { status: response.status, body: (await response.json()) as any };
  };

  return {
    rpc,
    callSave: (
      toolName: string,
      file: unknown,
      options: {
        requestState?: string;
        declareUpload?: boolean;
        declareFiles?: boolean;
      } = {},
    ) =>
      rpc(
        "tools/call",
        {
          name: toolName,
          arguments: { folder: "reports", file },
          ...(options.requestState && { requestState: options.requestState }),
        },
        {
          name: toolName,
          declareUpload: options.declareUpload,
          declareFiles: options.declareFiles,
        },
      ),
    upload: (
      path: string,
      bytes: Buffer,
      method: "PUT" | "POST" = "PUT",
      bearer: string = token,
    ) =>
      fetch(`${address}${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}` },
        body: new Uint8Array(bytes),
      }),
  };
}

type UpstreamOptions = {
  mode: "url" | "path-include" | "form";
  maxInlineBytes?: number;
  askTwice?: boolean;
};

type Upstream = Awaited<ReturnType<typeof startUpstream>>;

const SAVE_TOOL = {
  name: "save_file",
  description: "Save a file into a folder",
  inputSchema: {
    type: "object",
    properties: {
      folder: { type: "string" },
      file: {
        type: "object",
        "x-mcp-file": { maxSize: 1024 * 1024 },
        properties: {
          id: { type: "string", minLength: 1, maxLength: 128 },
          name: { type: "string" },
          mimeType: { type: "string" },
          size: { type: "integer", minimum: 0 },
          data: { type: "string" },
        },
        required: ["id", "mimeType", "size"],
      },
    },
    required: ["folder", "file"],
  },
};

const ECHO_TOOL = {
  name: "echo",
  description: "Echo text",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

/**
 * An upstream that serves the pooled 2025-11-25 connection through the SDK
 * and 2026-07-28 by hand: `server/discover`, a tools/list that shows the file
 * tool only to a client declaring the extension, and `save_file`, which asks
 * for an upload and checks the bytes on the retry. It also hosts the storage
 * its targets point at.
 */
async function startUpstream(options: UpstreamOptions) {
  const stored = new Map<string, Buffer>();
  const pending = new Map<
    string,
    { fileId: string; size: number; name?: string }
  >();
  const uploads: { path: string; headers: http.IncomingHttpHeaders }[] = [];
  const forms: {
    fields: [string, string][];
    fileField?: string;
    filename?: string;
    contentType?: string;
  }[] = [];
  let toolCalls = 0;
  let base = "";

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", base);
      const body = await readBody(req);

      if (url.pathname === "/mcp" && req.method === "POST") {
        const message = JSON.parse(body.toString("utf8"));
        if (req.headers["mcp-protocol-version"] === "2026-07-28") {
          const reply = await statelessAnswer(message, req);
          res.writeHead(reply.status ?? 200, {
            "content-type": "application/json",
          });
          res.end(
            JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply.body }),
          );
          return;
        }
        await legacyAnswer(req, res, message);
        return;
      }

      if (req.method === "PUT" && url.pathname.startsWith("/storage/")) {
        uploads.push({ path: url.pathname, headers: req.headers });
        stored.set(
          decodeURIComponent(url.pathname.slice("/storage/".length)),
          body,
        );
        res.writeHead(200).end();
        return;
      }
      if (req.method === "PUT" && url.pathname.startsWith("/mcp/uploads/")) {
        uploads.push({ path: url.pathname, headers: req.headers });
        if (req.headers.authorization !== `Bearer ${UPSTREAM_SECRET}`) {
          res.writeHead(401).end();
          return;
        }
        stored.set(
          decodeURIComponent(url.pathname.slice("/mcp/uploads/".length)),
          body,
        );
        res.writeHead(201).end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/form-storage") {
        uploads.push({ path: url.pathname, headers: req.headers });
        const form = parseMultipart(body, String(req.headers["content-type"]));
        forms.push(form);
        const key = form.fields.find(([name]) => name === "key")?.[1] ?? "";
        stored.set(key.replace("uploads/", ""), form.file ?? Buffer.alloc(0));
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end();
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  // biome-ignore lint/suspicious/noExplicitAny: a hand-rolled JSON-RPC peer
  async function statelessAnswer(message: any, req: http.IncomingMessage) {
    const params = message.params ?? {};
    const declared =
      params._meta?.["io.modelcontextprotocol/clientCapabilities"]
        ?.extensions?.[MCP_FILES_EXTENSION_ID];
    if (req.headers["mcp-method"] !== message.method) {
      return {
        status: 400,
        body: { error: { code: -32020, message: "header mismatch" } },
      };
    }
    switch (message.method) {
      case "server/discover":
        return {
          body: {
            result: {
              resultType: "complete",
              supportedVersions: ["2026-07-28", "2025-11-25"],
              serverInfo: { name: "files", version: "1.0.0" },
              capabilities: {
                tools: {},
                extensions: {
                  [MCP_FILES_EXTENSION_ID]: {
                    upload: {},
                    ...(options.maxInlineBytes && {
                      maxInlineBytes: options.maxInlineBytes,
                    }),
                  },
                },
              },
            },
          },
        };
      case "tools/list":
        return {
          body: {
            result: {
              resultType: "complete",
              tools: declared ? [ECHO_TOOL, SAVE_TOOL] : [ECHO_TOOL],
            },
          },
        };
      case "tools/call": {
        if (params.name !== "save_file") {
          return {
            body: {
              result: {
                resultType: "complete",
                content: [{ type: "text", text: "echo" }],
              },
            },
          };
        }
        toolCalls++;
        const file = params.arguments.file;
        if (params.requestState) {
          const entry = pending.get(params.requestState);
          if (!entry) {
            return {
              status: 400,
              body: { error: { code: -32602, message: "bad requestState" } },
            };
          }
          pending.delete(params.requestState);
          if (options.askTwice) {
            return { body: { result: uploadRequired(file) } };
          }
          const bytes = stored.get(entry.fileId);
          if (!bytes || bytes.length !== entry.size) {
            return {
              body: {
                result: {
                  resultType: "complete",
                  isError: true,
                  content: [{ type: "text", text: "bytes missing" }],
                },
              },
            };
          }
          return { body: { result: saved(entry.name, bytes, "uploaded") } };
        }
        if (typeof file.data === "string") {
          return {
            body: {
              result: saved(
                file.name,
                Buffer.from(file.data, "base64"),
                "inline",
              ),
            },
          };
        }
        if (!declared?.upload) {
          return {
            status: 400,
            body: { error: { code: -32021, message: "declare upload" } },
          };
        }
        return { body: { result: uploadRequired(file) } };
      }
      default:
        return {
          status: 400,
          body: { error: { code: -32601, message: "not found" } },
        };
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: a FileInput as sent
  function uploadRequired(file: any) {
    const requestState = `upstream-state-${randomUUID()}`;
    pending.set(requestState, {
      fileId: file.id,
      size: file.size,
      name: file.name,
    });
    const target =
      options.mode === "url"
        ? {
            fileId: file.id,
            url: `${base}/storage/${encodeURIComponent(file.id)}?sig=secret-signature`,
            headers: { "Content-Type": file.mimeType },
            credentials: "omit",
          }
        : options.mode === "path-include"
          ? {
              fileId: file.id,
              path: `/uploads/${encodeURIComponent(file.id)}`,
              credentials: "include",
            }
          : {
              fileId: file.id,
              url: `${base}/form-storage`,
              method: "POST",
              form: {
                fields: [
                  { name: "key", value: `uploads/${file.id}` },
                  { name: "policy", value: "signed-policy" },
                ],
                fileField: "file",
              },
              credentials: "omit",
            };
    return {
      resultType: "upload_required",
      uploads: [
        {
          ...target,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        },
      ],
      requestState,
      content: [],
    };
  }

  function saved(name: string | undefined, bytes: Buffer, how: string) {
    return {
      resultType: "complete",
      content: [
        {
          type: "text",
          text:
            how === "inline"
              ? `saved inline: ${bytes.length} bytes`
              : `saved ${name}: ${bytes.length} bytes, sha256 ${sha256(bytes)}`,
        },
      ],
    };
  }

  async function legacyAnswer(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    message: unknown,
  ) {
    const mcp = new McpSdkServer(
      { name: "files", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [ECHO_TOOL as never],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text", text: "echo" }],
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, message);
  }

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = httpServer.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  let closed = false;

  return {
    url: `${base}/mcp`,
    stored,
    uploads,
    forms,
    get toolCalls() {
      return toolCalls;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseMultipart(body: Buffer, contentType: string) {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error("no boundary");
  const text = body.toString("latin1");
  const parts = text
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => part.replace(/^\r\n/, "").replace(/\r\n$/, ""));
  const result: {
    fields: [string, string][];
    fileField?: string;
    filename?: string;
    contentType?: string;
    file?: Buffer;
  } = { fields: [] };
  for (const part of parts) {
    const [head, ...rest] = part.split("\r\n\r\n");
    const content = rest.join("\r\n\r\n");
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename === undefined) {
      result.fields.push([name, content]);
    } else {
      result.fileField = name;
      result.filename = filename;
      result.contentType = /Content-Type: (.*)/.exec(head)?.[1];
      result.file = Buffer.from(content, "latin1");
    }
  }
  return result;
}
