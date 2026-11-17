import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import type { A2AExecuteParams } from "@/agents/a2a-executor";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { AgentRunInputModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const {
  mockExecuteA2AMessage,
  mockRunTaskInAgentRuntime,
  mockValidateMCPGatewayToken,
} = vi.hoisted(() => ({
  mockExecuteA2AMessage: vi.fn(),
  mockRunTaskInAgentRuntime: vi.fn(),
  mockValidateMCPGatewayToken: vi.fn(),
}));

vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: (...args: unknown[]) => mockExecuteA2AMessage(...args),
}));

vi.mock("@/services/agent-runtime/pod-run", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/agent-runtime/pod-run")
  >("@/services/agent-runtime/pod-run");
  return {
    ...actual,
    runTaskInAgentRuntime: (...args: unknown[]) =>
      mockRunTaskInAgentRuntime(...args),
  };
});

vi.mock("@/routes/mcp-gateway/utils", async () => {
  const actual = await vi.importActual<
    typeof import("@/routes/mcp-gateway/utils")
  >("@/routes/mcp-gateway/utils");
  return {
    ...actual,
    validateMCPGatewayToken: (...args: unknown[]) =>
      mockValidateMCPGatewayToken(...args),
  };
});

vi.mock("@/observability/tracing", async () => {
  const actual = await vi.importActual<
    typeof import("@/observability/tracing")
  >("@/observability/tracing");
  return {
    ...actual,
    startActiveChatSpan: async <T>(params: {
      callback: () => Promise<T>;
    }): Promise<T> => params.callback(),
  };
});

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const PDF_BYTES = Buffer.from("%PDF-1.4\n%fake pdf body\n");

function agentReply(text: string) {
  const messageId = crypto.randomUUID();
  return {
    messageId,
    text,
    finishReason: "stop",
    responseUiMessage: {
      id: messageId,
      role: "assistant",
      parts: [{ type: "text", text }],
    },
  };
}

/** What the executor was handed for the current turn. */
function executedTurn() {
  const params = mockExecuteA2AMessage.mock.calls[0][0] as A2AExecuteParams;
  return { message: params.message, attachments: params.attachments };
}

describe("a2a v2 file parts", () => {
  let app: FastifyInstanceWithZod;
  let agentId: string;
  let organizationId: string;
  let userId: string;
  let fileServer: Server | undefined;

  beforeEach(async ({ makeInternalAgent, makeUser, makeMember }) => {
    const agent = await makeInternalAgent();
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    agentId = agent.id;
    organizationId = agent.organizationId;
    userId = user.id;

    mockValidateMCPGatewayToken.mockResolvedValue({
      organizationId: agent.organizationId,
      userId: user.id,
    });
    mockExecuteA2AMessage.mockImplementation(async () => agentReply("seen"));

    app = createFastifyInstance();
    const { default: a2aV2Routes } = await import("./v2");
    await app.register(a2aV2Routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    mockExecuteA2AMessage.mockReset();
    mockRunTaskInAgentRuntime.mockReset();
    mockValidateMCPGatewayToken.mockReset();
    await app.close();
    await new Promise<void>((resolve) => {
      if (!fileServer) return resolve();
      fileServer.close(() => resolve());
      fileServer = undefined;
    });
  });

  async function send(parts: unknown[], configuration?: unknown) {
    const response = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agentId}`,
      headers: { authorization: "Bearer test-token" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          message: {
            messageId: crypto.randomUUID(),
            role: "ROLE_USER",
            parts,
          },
          configuration,
        },
      },
    });
    return response.json();
  }

  /** Serve files from a loopback HTTP server; returns its base URL. */
  async function serveFiles(
    files: Record<
      string,
      { body: Buffer; contentType?: string; redirectTo?: string }
    >,
  ): Promise<string> {
    fileServer = createServer((req, res) => {
      const file = files[req.url ?? ""];
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      if (file.redirectTo) {
        res.writeHead(302, { location: file.redirectTo }).end();
        return;
      }
      res.writeHead(
        200,
        file.contentType ? { "content-type": file.contentType } : {},
      );
      res.end(file.body);
    });
    await new Promise<void>((resolve) =>
      fileServer?.listen(0, "127.0.0.1", resolve),
    );
    const { port } = fileServer.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  test("an inline base64 file reaches the run with its bytes, type and name", async () => {
    const body = await send([
      { text: "what is in this screenshot?" },
      {
        raw: PNG_BYTES.toString("base64"),
        mediaType: "image/png",
        filename: "shot.png",
      },
    ]);

    expect(body.error).toBeUndefined();
    expect(body.result.message.parts).toEqual([{ text: "seen" }]);
    expect(executedTurn()).toEqual({
      message: "what is in this screenshot?",
      attachments: [
        {
          contentType: "image/png",
          contentBase64: PNG_BYTES.toString("base64"),
          name: "shot.png",
        },
      ],
    });
  });

  test("accepts URL-safe unpadded base64 and a file with no text beside it", async () => {
    // 0xfb 0xff 0xfe encodes with `-` and `_` in the URL-safe alphabet, and a
    // 4-byte payload needs padding the client left off.
    const bytes = Buffer.from([0xfb, 0xff, 0xfe, 0x01]);
    const urlSafe = bytes.toString("base64url");
    expect(urlSafe).toMatch(/[-_]/);

    const body = await send([{ raw: urlSafe, mediaType: "application/pdf" }]);

    expect(body.error).toBeUndefined();
    expect(executedTurn().attachments).toEqual([
      {
        contentType: "application/pdf",
        contentBase64: bytes.toString("base64"),
        name: undefined,
      },
    ]);
  });

  test("reads the pre-1.0 file shape", async () => {
    const body = await send([
      { kind: "text", text: "summarize" },
      {
        kind: "file",
        file: {
          bytes: PDF_BYTES.toString("base64"),
          mimeType: "application/pdf",
          name: "report.pdf",
        },
      },
    ]);

    expect(body.error).toBeUndefined();
    expect(executedTurn().attachments).toEqual([
      {
        contentType: "application/pdf",
        contentBase64: PDF_BYTES.toString("base64"),
        name: "report.pdf",
      },
    ]);
  });

  test("names a file by its extension when the client sends no media type", async () => {
    await send([
      { text: "read it" },
      { raw: PDF_BYTES.toString("base64"), filename: "report.pdf" },
    ]);

    expect(executedTurn().attachments?.[0].contentType).toBe("application/pdf");
  });

  test("refuses raw that is not base64, an empty file, and more files than a message may carry", async () => {
    const notBase64 = await send([
      { text: "look" },
      { raw: "not base64!!", mediaType: "image/png" },
    ]);
    expect(notBase64.error.code).toBe(-32600);

    const empty = await send([
      { text: "look" },
      { raw: "", mediaType: "image/png", filename: "empty.png" },
    ]);
    expect(empty.error).toEqual({
      code: -32602,
      message: 'Invalid file part: file part "empty.png" is empty',
    });

    const tooMany = await send(
      Array.from({ length: 21 }, () => ({
        raw: PNG_BYTES.toString("base64"),
        mediaType: "image/png",
      })),
    );
    expect(tooMany.error.message).toBe(
      "Invalid file part: a message may carry at most 20 files",
    );

    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("refuses a file over the attachment size limit", async () => {
    const original = config.chat.attachmentStorageBytesLimit;
    config.chat.attachmentStorageBytesLimit = 8;
    try {
      const baseUrl = await serveFiles({
        "/big.pdf": { body: PDF_BYTES, contentType: "application/pdf" },
      });

      const inline = await send([
        { raw: PNG_BYTES.toString("base64"), mediaType: "image/png" },
      ]);
      expect(inline.error.code).toBe(-32602);
      expect(inline.error.message).toContain("is larger than the");

      const byUrl = await send([{ url: `${baseUrl}/big.pdf` }]);
      expect(byUrl.error.code).toBe(-32602);
      expect(byUrl.error.message).toContain("is larger than the");
    } finally {
      config.chat.attachmentStorageBytesLimit = original;
    }
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("downloads a url part, following a redirect, and takes type and name from the response and URL", async () => {
    const baseUrl = await serveFiles({
      "/files/report.pdf": {
        body: PDF_BYTES,
        contentType: "application/pdf; charset=binary",
      },
      "/moved": { body: Buffer.alloc(0), redirectTo: "/files/report.pdf" },
      // No content type: the extension decides.
      "/files/shot.png": { body: PNG_BYTES },
    });

    const body = await send([
      { text: "compare these" },
      { url: `${baseUrl}/moved` },
      { url: `${baseUrl}/files/shot.png` },
      { url: `${baseUrl}/files/report.pdf`, filename: "q3.pdf" },
    ]);

    expect(body.error).toBeUndefined();
    expect(executedTurn().attachments).toEqual([
      {
        contentType: "application/pdf",
        contentBase64: PDF_BYTES.toString("base64"),
        name: "moved",
      },
      {
        contentType: "image/png",
        contentBase64: PNG_BYTES.toString("base64"),
        name: "shot.png",
      },
      {
        contentType: "application/pdf",
        contentBase64: PDF_BYTES.toString("base64"),
        name: "q3.pdf",
      },
    ]);
  });

  test("refuses a url part it must not or cannot fetch, without starting a run", async () => {
    const baseUrl = await serveFiles({
      // A public-looking URL that bounces to a cloud metadata address.
      "/bounce": {
        body: Buffer.alloc(0),
        redirectTo: "http://169.254.169.254/latest/meta-data/",
      },
    });

    const privateHost = await send([
      { text: "read" },
      { url: "http://10.0.0.5/internal.pdf" },
    ]);
    expect(privateHost.error).toEqual({
      code: -32602,
      message:
        'Invalid file part: file part "internal.pdf" could not be fetched: the URL points at a private or loopback address',
    });

    const redirected = await send([{ url: `${baseUrl}/bounce` }]);
    expect(redirected.error.message).toContain(
      "the URL points at a private or loopback address",
    );

    const missing = await send([{ url: `${baseUrl}/nope.pdf` }]);
    expect(missing.error.message).toContain("the server answered HTTP 404");

    const notHttp = await send([{ url: "file:///etc/passwd" }]);
    expect(notHttp.error.message).toContain("the URL must use https");

    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("task history names the files without carrying their bytes", async () => {
    const baseUrl = await serveFiles({
      "/files/report.pdf": { body: PDF_BYTES, contentType: "application/pdf" },
    });

    const body = await send(
      [
        { text: "look at both" },
        {
          raw: PNG_BYTES.toString("base64"),
          mediaType: "image/png",
          filename: "shot.png",
        },
        { url: `${baseUrl}/files/report.pdf` },
      ],
      { returnImmediately: true },
    );

    expect(body.result.task.history[0].parts).toEqual([
      { text: "look at both" },
      { text: `[file: shot.png (image/png, ${PNG_BYTES.byteLength} bytes)]` },
      {
        url: `${baseUrl}/files/report.pdf`,
        filename: "report.pdf",
        mediaType: "application/pdf",
      },
    ]);
  });

  test("an Agent Runtime task stores the files as inputs for its container", async ({
    makeInternalAgent,
  }) => {
    const runtimeAgent = await makeInternalAgent({
      organizationId,
      runtime: {
        image: "example.invalid/runtime-agent:test",
        command: null,
        inferenceProtocol: "openai_responses",
        backend: "kubernetes",
        steerMode: "pipe",
        privileged: false,
        environment: null,
        credentials: null,
        ttlHours: null,
        idleTimeoutMinutes: null,
      },
    });
    agentId = runtimeAgent.id;
    // The container launch reads the task's inputs when it starts, so they
    // must already be stored by the time it is called.
    let inputsAtLaunch: Awaited<
      ReturnType<typeof AgentRunInputModel.findByTaskId>
    > = [];
    mockRunTaskInAgentRuntime.mockImplementationOnce(
      async (params: { taskId: string }) => {
        inputsAtLaunch = await AgentRunInputModel.findByTaskId(params.taskId);
        return agentReply("runtime answer");
      },
    );

    const body = await send([
      { text: "what does the screenshot show?" },
      {
        raw: PNG_BYTES.toString("base64"),
        mediaType: "image/png",
        filename: "shot.png",
      },
    ]);

    const taskId = body.result.task.id;
    expect(body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(inputsAtLaunch).toHaveLength(1);
    expect(inputsAtLaunch[0]).toMatchObject({
      taskId,
      organizationId,
      uploadedByUserId: userId,
      originalName: "shot.png",
      mimeType: "image/png",
      fileSize: PNG_BYTES.byteLength,
      runtimePath: expect.stringMatching(
        new RegExp(`/attachments/${taskId}/shot\\.png$`),
      ),
    });
    expect(Buffer.from(inputsAtLaunch[0].fileData).equals(PNG_BYTES)).toBe(
      true,
    );
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });
});
