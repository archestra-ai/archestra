/**
 * The MCP File Uploads extension for the gateway's own built-in tools, end
 * to end: the real gateway route over a socket, the real transfer ticket
 * service and shared cache, with the Agent Runtime's in-Pod helper replaced
 * at its process boundary. The caller is plain HTTP, as a 2026-07-28 client
 * is.
 */

import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  ARCHESTRA_MCP_CATALOG_ID,
  MCP_FILES_EXTENSION_ID,
} from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { executeArchestraTool } from "@/archestra-mcp-server";
import { McpToolCallModel, ToolModel, UserTokenModel } from "@/models";
import { afterEach, describe, expect, type TestFixtures, test } from "@/test";
import {
  fakeWorkspacePod,
  seedRetainedRun,
} from "@/test/agent-runtime-workspace";
import { setupTestCacheManager } from "@/test/cache-manager";
import mcpGatewayRoutes from "./index";

setupTestCacheManager();

const TRANSFER = "archestra__transfer_workspace_file";
const RUN_TOOL = "archestra__run_tool";
const FILE_BYTES = Buffer.from("quarterly numbers\n".repeat(64));

type Fixtures = Pick<
  TestFixtures,
  "makeOrganization" | "makeUser" | "makeMember" | "makeAgent"
>;

describe("MCP gateway - File Uploads for built-in tools", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function setUp(fixtures: Fixtures) {
    const run = await seedRetainedRun(fixtures);
    const pod = fakeWorkspacePod();
    const gatewayAgent = await fixtures.makeAgent({
      organizationId: run.actor.organizationId,
      agentType: "mcp_gateway",
      toolExposureMode: "full",
      // The run belongs to a runtime agent this gateway may reach.
      accessAllSubagents: true,
    });
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    await ToolModel.assignArchestraToolsToAgent(
      gatewayAgent.id,
      ARCHESTRA_MCP_CATALOG_ID,
    );
    const { value: token } = await UserTokenModel.create(
      run.actor.id,
      run.actor.organizationId as string,
    );
    app = await gatewayApp();
    const gateway = gatewayClient(app, gatewayAgent.id, token);
    const upload = (file: unknown, requestState?: string) =>
      gateway.call(
        TRANSFER,
        { run_id: run.taskId, direction: "upload", path: "inbox/q3.csv", file },
        { requestState },
      );
    return {
      run,
      pod,
      gateway,
      gatewayAgentId: gatewayAgent.id,
      upload,
    };
  }

  test("the caller uploads to the gateway, the bytes land in the workspace, and the retry reports them stored", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const { pod, gateway, upload } = await setUp({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
    });

    const first = await upload(fileInput());
    console.error("DEBUG", JSON.stringify(first.body.result.content));
    expect(first.body.result).toMatchObject({
      resultType: "upload_required",
      uploads: [
        {
          fileId: "file-1",
          path: expect.stringMatching(/^\/files\/[A-Za-z0-9_-]{43}$/),
          method: "PUT",
          credentials: "include",
          expiresAt: expect.any(String),
        },
      ],
      requestState: expect.any(String),
    });
    // Nothing is in the workspace until the bytes arrive.
    expect(pod.finalized).toEqual([]);

    const [target] = first.body.result.uploads;
    const put = await gateway.upload(target.path, FILE_BYTES);
    expect(put.status).toBe(200);
    expect([...pod.staged.values()]).toEqual([FILE_BYTES]);
    expect(pod.finalized).toEqual([
      [expect.any(String), "inbox/q3.csv", hex(FILE_BYTES), "-", "0"],
    ]);

    const retry = await upload(fileInput(), first.body.result.requestState);
    expect(retry.body.result.isError).toBeFalsy();
    expect(retry.body.result.structuredContent).toMatchObject({
      direction: "upload",
      status: "stored",
      path: "inbox/q3.csv",
      size: FILE_BYTES.length,
      sha256: hex(FILE_BYTES),
    });

    // Spent: the same state cannot run the tool twice.
    const replay = await upload(fileInput(), first.body.result.requestState);
    expect(replay.body.error.code).toBe(-32602);
  });

  test("an inline file is stored in the same call, and the record keeps no bytes", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const fixtures = { makeOrganization, makeUser, makeMember, makeAgent };
    const { pod, upload, gatewayAgentId } = await setUp(fixtures);
    const result = await upload(
      fileInput({ data: FILE_BYTES.toString("base64") }),
    );
    expect(result.body.result.structuredContent).toMatchObject({
      status: "stored",
      path: "inbox/q3.csv",
      sha256: hex(FILE_BYTES),
    });
    expect([...pod.staged.values()]).toEqual([FILE_BYTES]);
    const [row] = await toolCallRows(gatewayAgentId, TRANSFER);
    expect(JSON.stringify(row.toolCall)).not.toContain(
      FILE_BYTES.toString("base64").slice(0, 32),
    );
    expect(row.toolCall?.arguments).toMatchObject({
      file: { data: `[${FILE_BYTES.length} bytes omitted]` },
    });
  });

  test("a retry before the file arrived does not run the tool and keeps the state redeemable", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const fixtures = { makeOrganization, makeUser, makeMember, makeAgent };
    const { gateway, upload } = await setUp(fixtures);
    const first = await upload(fileInput());
    const { requestState, uploads } = first.body.result;

    const early = await upload(fileInput(), requestState);
    expect(early.body.result.isError).toBe(true);
    expect(early.body.result.content[0].text).toMatch(/not uploaded yet/);

    expect((await gateway.upload(uploads[0].path, FILE_BYTES)).status).toBe(
      200,
    );
    const retry = await upload(fileInput(), requestState);
    expect(retry.body.result.structuredContent).toMatchObject({
      status: "stored",
    });
  });

  test("the retry must repeat the call exactly", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const fixtures = { makeOrganization, makeUser, makeMember, makeAgent };
    const { gateway, upload } = await setUp(fixtures);
    const first = await upload(fileInput());
    await gateway.upload(first.body.result.uploads[0].path, FILE_BYTES);
    const changed = await upload(
      fileInput({ name: "other.csv" }),
      first.body.result.requestState,
    );
    expect(changed.body.error.code).toBe(-32602);
  });

  test("an upload target works only for the caller it was issued to", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const fixtures = { makeOrganization, makeUser, makeMember, makeAgent };
    const { gateway, upload, run, pod } = await setUp(fixtures);
    const first = await upload(fileInput());
    const stranger = await fixtures.makeUser();
    await fixtures.makeMember(stranger.id, run.actor.organizationId as string, {
      role: "admin",
    });
    const { value: strangerToken } = await UserTokenModel.create(
      stranger.id,
      run.actor.organizationId as string,
    );
    const put = await gateway.upload(
      first.body.result.uploads[0].path,
      FILE_BYTES,
      strangerToken,
    );
    expect(put.status).toBe(404);
    expect(pod.staged.size).toBe(0);
  });

  test("bytes that do not match the declared size or digest never finalize, and the target can be used again", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const fixtures = { makeOrganization, makeUser, makeMember, makeAgent };
    const { gateway, upload, pod } = await setUp(fixtures);
    const first = await upload(
      fileInput({
        digest: { algorithm: "sha-256", value: base64url(FILE_BYTES) },
      }),
    );
    const { path } = first.body.result.uploads[0];

    const tampered = Buffer.from(FILE_BYTES);
    tampered[0] ^= 1;
    expect((await gateway.upload(path, tampered)).status).toBe(400);
    expect((await gateway.upload(path, FILE_BYTES.subarray(1))).status).toBe(
      400,
    );
    expect(pod.finalized).toEqual([]);

    expect((await gateway.upload(path, FILE_BYTES)).status).toBe(200);
    expect(pod.finalized).toEqual([
      [expect.any(String), "inbox/q3.csv", hex(FILE_BYTES), "-", "0"],
    ]);
  });

  test("a caller that cannot upload gets MissingRequiredClientCapability, and one without the extension cannot pass a file", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const fixtures = { makeOrganization, makeUser, makeMember, makeAgent };
    const { gateway, run } = await setUp(fixtures);
    const args = {
      run_id: run.taskId,
      direction: "upload",
      path: "inbox/q3.csv",
      file: fileInput(),
    };
    const noUpload = await gateway.call(TRANSFER, args, { declare: "files" });
    expect(noUpload.body.error).toMatchObject({
      code: -32021,
      data: {
        requiredCapabilities: {
          extensions: { [MCP_FILES_EXTENSION_ID]: { upload: {} } },
        },
      },
    });
    const none = await gateway.call(TRANSFER, args, { declare: "none" });
    expect(none.body.error).toMatchObject({
      code: -32021,
      data: {
        requiredCapabilities: { extensions: { [MCP_FILES_EXTENSION_ID]: {} } },
      },
    });
  });

  test("only a caller with the extension is shown the file argument", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const fixtures = { makeOrganization, makeUser, makeMember, makeAgent };
    const { gateway } = await setUp(fixtures);
    const transferSchema = async (declare: "none" | "upload") => {
      const list = await gateway.rpc("tools/list", {}, { declare });
      return list.body.result.tools.find(
        (tool: { name: string }) => tool.name === TRANSFER,
      ).inputSchema;
    };
    const plain = await transferSchema("none");
    expect(plain.properties).not.toHaveProperty("file");
    expect(plain.properties).toHaveProperty("local_path");
    const withFiles = await transferSchema("upload");
    expect(withFiles.properties.file).toHaveProperty("x-mcp-file");
  });

  test("through run_tool, the upload binds the run_tool call", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const fixtures = { makeOrganization, makeUser, makeMember, makeAgent };
    const { gateway, run, pod } = await setUp(fixtures);
    const args = {
      tool_name: TRANSFER,
      tool_args: {
        run_id: run.taskId,
        direction: "upload",
        path: "inbox/q3.csv",
        file: fileInput(),
      },
    };
    const first = await gateway.call(RUN_TOOL, args);
    expect(first.body.result.resultType).toBe("upload_required");
    await gateway.upload(first.body.result.uploads[0].path, FILE_BYTES);
    expect([...pod.staged.values()]).toEqual([FILE_BYTES]);

    const retry = await gateway.call(RUN_TOOL, args, {
      requestState: first.body.result.requestState,
    });
    expect(retry.body.result.isError).toBeFalsy();
    expect(JSON.parse(retry.body.result.content[0].text)).toMatchObject({
      status: "stored",
      path: "inbox/q3.csv",
    });
  });

  test("a file comes in place of local_path, size and sha256, and only for an upload", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const fixtures = { makeOrganization, makeUser, makeMember, makeAgent };
    const { gateway, run } = await setUp(fixtures);
    for (const extra of [
      { local_path: "/tmp/q3.csv" },
      { direction: "download" },
    ]) {
      const result = await gateway.call(TRANSFER, {
        run_id: run.taskId,
        direction: "upload",
        path: "inbox/q3.csv",
        file: fileInput(),
        ...extra,
      });
      expect(result.body.result.isError).toBe(true);
      expect(result.body.result.content[0].text).toMatch(
        /in place of local_path/,
      );
    }
  });

  test("outside the gateway, where no file can arrive, the tool refuses one", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const fixtures = { makeOrganization, makeUser, makeMember, makeAgent };
    const run = await seedRetainedRun(fixtures);
    fakeWorkspacePod();
    const result = await executeArchestraTool(
      TRANSFER,
      {
        run_id: run.taskId,
        direction: "upload",
        path: "inbox/q3.csv",
        file: fileInput({ data: FILE_BYTES.toString("base64") }),
      },
      {
        agent: { id: randomUUID(), name: "chat" },
        userId: run.actor.id,
        organizationId: run.actor.organizationId,
      },
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/cannot send files/);
  });
});

// =============================================================================
// Helpers
// =============================================================================

function fileInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "file-1",
    name: "q3.csv",
    mimeType: "text/csv",
    size: FILE_BYTES.length,
    ...overrides,
  };
}

function hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function base64url(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

async function toolCallRows(agentId: string, toolName: string) {
  const rows = await McpToolCallModel.getAllMcpToolCallsForAgent(agentId);
  return rows.filter((row) => row.toolCall?.name === toolName);
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
    options: { declare?: "none" | "files" | "upload"; name?: string } = {},
  ) => {
    const declare = options.declare ?? "upload";
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
            "io.modelcontextprotocol/clientCapabilities":
              declare === "none"
                ? {}
                : {
                    extensions: {
                      [MCP_FILES_EXTENSION_ID]:
                        declare === "upload" ? { upload: {} } : {},
                    },
                  },
          },
        },
      }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are asserted field by field
    return { status: response.status, body: (await response.json()) as any };
  };

  return {
    rpc,
    call: (
      name: string,
      args: Record<string, unknown>,
      options: {
        requestState?: string;
        declare?: "none" | "files" | "upload";
      } = {},
    ) =>
      rpc(
        "tools/call",
        {
          name,
          arguments: args,
          ...(options.requestState && { requestState: options.requestState }),
        },
        { name, declare: options.declare },
      ),
    upload: (path: string, bytes: Buffer, bearer: string = token) =>
      fetch(`${address}${path}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${bearer}` },
        body: new Uint8Array(bytes),
      }),
  };
}
