import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import type { A2AExecuteParams } from "@/agents/a2a-executor";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const {
  mockExecuteA2AMessage,
  mockRunTaskInBackground,
  mockValidateMCPGatewayToken,
} = vi.hoisted(() => ({
  mockExecuteA2AMessage: vi.fn(),
  mockRunTaskInBackground: vi.fn(),
  mockValidateMCPGatewayToken: vi.fn(),
}));

vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: (...args: unknown[]) => mockExecuteA2AMessage(...args),
}));

vi.mock("@/services/runners/pod-execution", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/runners/pod-execution")
  >("@/services/runners/pod-execution");
  return {
    ...actual,
    runTaskInBackground: (...args: unknown[]) =>
      mockRunTaskInBackground(...args),
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

type SseEvent = {
  jsonrpc: string;
  id: string | number;
  result?: {
    statusUpdate?: {
      taskId: string;
      contextId?: string;
      final?: boolean;
      status: {
        state: string;
        timestamp?: string;
        message?: { parts?: { text?: string }[] };
      };
    };
    artifactUpdate?: {
      taskId: string;
      contextId?: string;
      artifact: {
        artifactId: string;
        name?: string;
        parts: { text?: string }[];
      };
      append?: boolean;
      lastChunk?: boolean;
    };
    message?: { parts?: { text?: string }[] };
    task?: {
      id: string;
      contextId?: string;
      status: { state: string };
      artifacts?: { parts: { text?: string }[] }[];
    };
  };
  error?: { code: number; message: string };
};

function parseSseEvents(body: string): SseEvent[] {
  return body
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data:"))
    .map((chunk) => JSON.parse(chunk.slice("data:".length).trim()) as SseEvent);
}

function jsonRpc(id: number, method: string, params: unknown) {
  return { jsonrpc: "2.0" as const, id, method, params };
}

function userMessage(text: string, extra?: Record<string, unknown>) {
  return {
    messageId: crypto.randomUUID(),
    role: "ROLE_USER",
    parts: [{ text }],
    ...extra,
  };
}

function mockExecutorText(text: string) {
  mockExecuteA2AMessage.mockImplementation(async (params: A2AExecuteParams) => {
    params.onTextDelta?.(text);
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
  });
}

/** Executor gated on an explicit release; release awaits invocation. */
function mockExecutorGated() {
  let release: ((text: string) => void) | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  mockExecuteA2AMessage.mockImplementation(
    (params: A2AExecuteParams) =>
      new Promise((resolve, reject) => {
        params.abortSignal?.addEventListener("abort", () =>
          reject(new Error("run aborted")),
        );
        release = (text: string) => {
          params.onTextDelta?.(text);
          const messageId = crypto.randomUUID();
          resolve({
            messageId,
            text,
            finishReason: "stop",
            responseUiMessage: {
              id: messageId,
              role: "assistant",
              parts: [{ type: "text", text }],
            },
          });
        };
        markStarted();
      }),
  );
  return {
    release: async (text: string) => {
      await started;
      release?.(text);
    },
  };
}

describe("a2a v2 task methods", () => {
  let app: FastifyInstanceWithZod;
  let agentId: string;
  let organizationId: string;
  let userId: string;
  const previousBackgroundExecutionEnabled =
    config.agentBackgroundExecution.enabled;

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

    app = createFastifyInstance();
    const { default: a2aV2Routes } = await import("./v2");
    await app.register(a2aV2Routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    mockExecuteA2AMessage.mockReset();
    mockRunTaskInBackground.mockReset();
    mockValidateMCPGatewayToken.mockReset();
    config.agentBackgroundExecution.enabled =
      previousBackgroundExecutionEnabled;
    await app.close();
  });

  async function rpc(id: number, method: string, params: unknown) {
    const response = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agentId}`,
      headers: { authorization: "Bearer test-token" },
      payload: jsonRpc(id, method, params),
    });
    return response.json();
  }

  async function pollTaskUntil(
    taskId: string,
    state: string,
    timeoutMs = 5000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const body = await rpc(99, "GetTask", { id: taskId });
      if (body.result?.status?.state === state) return body.result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Task ${taskId} never reached ${state}`);
  }

  test("returnImmediately hands back the task handle, GetTask polls it to completion with artifacts", async () => {
    const gate = mockExecutorGated();

    const body = await rpc(1, "SendMessage", {
      message: userMessage("long question"),
      configuration: { returnImmediately: true },
    });

    // The handle returns before any answer exists.
    expect(body.result.message).toBeUndefined();
    const task = body.result.task;
    expect(task.id).toEqual(expect.any(String));
    expect(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"]).toContain(
      task.status.state,
    );

    await gate.release("here is your answer");
    const settled = await pollTaskUntil(task.id, "TASK_STATE_COMPLETED");
    expect(settled.artifacts).toEqual([
      {
        artifactId: expect.any(String),
        name: "agent-response",
        parts: [{ text: "here is your answer" }],
      },
    ]);
    expect(settled.status.timestamp).toEqual(expect.any(String));
  });

  test("SendMessage returns a durable Task when the Agent uses background execution", async ({
    makeInternalAgent,
  }) => {
    config.agentBackgroundExecution.enabled = true;
    const backgroundAgent = await makeInternalAgent({
      organizationId,
      backgroundExecution: {
        image: "example.invalid/background-agent:test",
        command: null,
        inferenceProtocol: "openai_responses",
        backend: "kubernetes",
        steerMode: "pipe",
        privileged: false,
        resources: null,
        environment: null,
        credentials: null,
        ttlHours: null,
        idleTimeoutMinutes: null,
      },
    });
    agentId = backgroundAgent.id;
    mockRunTaskInBackground.mockImplementationOnce(
      async (params: { onTextDelta?: (delta: string) => void }) => {
        params.onTextDelta?.("background answer");
        const messageId = crypto.randomUUID();
        return {
          messageId,
          text: "background answer",
          finishReason: "stop",
          responseUiMessage: {
            id: messageId,
            role: "assistant",
            parts: [{ type: "text", text: "background answer" }],
          },
        };
      },
    );

    const body = await rpc(2, "SendMessage", {
      message: userMessage("run this in the execution backend"),
    });

    expect(body.result.message).toBeUndefined();
    expect(body.result.task).toMatchObject({
      id: expect.any(String),
      status: { state: "TASK_STATE_COMPLETED" },
      artifacts: [
        {
          name: "agent-response",
          parts: [{ text: "background answer" }],
        },
      ],
    });
    expect(mockRunTaskInBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: backgroundAgent.id,
        taskId: body.result.task.id,
        actor: {
          id: userId,
          kind: "user",
          organizationId,
        },
        deployment: expect.objectContaining({
          agentId: backgroundAgent.id,
        }),
        executionMode: "one_shot",
      }),
    );
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("CancelTask: unknown id is -32001, active task cancels to a returned Task, terminal is -32002", async () => {
    const unknown = await rpc(2, "CancelTask", { id: crypto.randomUUID() });
    expect(unknown.error).toMatchObject({ code: -32001 });

    const gate = mockExecutorGated();
    const created = await rpc(3, "SendMessage", {
      message: userMessage("cancel me"),
      configuration: { returnImmediately: true },
    });
    const taskId = created.result.task.id;

    const canceled = await rpc(4, "CancelTask", { id: taskId });
    expect(canceled.result.status.state).toBe("TASK_STATE_CANCELED");

    const again = await rpc(5, "CancelTask", { id: taskId });
    expect(again.error).toMatchObject({ code: -32002 });

    // The run's late completion cannot overwrite the cancellation.
    await gate.release("too late");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await rpc(6, "GetTask", { id: taskId });
    expect(after.result.status.state).toBe("TASK_STATE_CANCELED");
  });

  test("ListTasks pages with the v1.0 response shape and rejects malformed cursors", async () => {
    mockExecutorText("answer");
    for (let i = 0; i < 2; i++) {
      const body = await rpc(10 + i, "SendMessage", {
        message: userMessage(`q${i}`),
        configuration: { returnImmediately: true },
      });
      await pollTaskUntil(body.result.task.id, "TASK_STATE_COMPLETED");
    }

    const page = await rpc(20, "ListTasks", { pageSize: 1 });
    expect(page.result.tasks).toHaveLength(1);
    expect(page.result.pageSize).toBe(1);
    expect(page.result.totalSize).toBe(2);
    expect(page.result.nextPageToken).not.toBe("");

    const page2 = await rpc(21, "ListTasks", {
      pageSize: 1,
      pageToken: page.result.nextPageToken,
    });
    expect(page2.result.tasks).toHaveLength(1);
    expect(page2.result.tasks[0].id).not.toBe(page.result.tasks[0].id);

    const bad = await rpc(22, "ListTasks", { pageToken: "garbage" });
    expect(bad.error).toMatchObject({ code: -32602 });
  });

  test("A2A-Version: 1.0 streams the spec lifecycle shape: task frame first, artifact chunks, no final field", async () => {
    mockExecutorText("Hello world");

    const response = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agentId}`,
      headers: {
        authorization: "Bearer test-token",
        "a2a-version": "1.0",
      },
      payload: jsonRpc(30, "SendStreamingMessage", {
        message: userMessage("hi"),
      }),
    });

    expect(response.statusCode).toBe(200);
    const events = parseSseEvents(response.body);

    // Lifecycle stream shape: MUST begin with the Task object.
    expect(events[0].result?.task?.id).toEqual(expect.any(String));
    const taskId = events[0].result?.task?.id as string;

    // No frame carries the pre-1.0 `final` field.
    for (const event of events) {
      expect(event.result?.statusUpdate?.final).toBeUndefined();
    }

    // Artifact chunks arrive as artifactUpdate frames and reconstruct the
    // answer; the seal frame carries the authoritative content.
    const artifactFrames = events.filter((e) => e.result?.artifactUpdate);
    expect(artifactFrames.length).toBeGreaterThan(0);
    const seal = artifactFrames.find(
      (e) => e.result?.artifactUpdate?.lastChunk,
    );
    expect(seal?.result?.artifactUpdate?.artifact.parts).toEqual([
      { text: "Hello world" },
    ]);

    // The stream closes on the terminal status update, and the streamed task
    // id is real: GetTask resolves it.
    const last = events[events.length - 1];
    expect(last.result?.statusUpdate?.status.state).toBe(
      "TASK_STATE_COMPLETED",
    );
    const fetched = await rpc(31, "GetTask", { id: taskId });
    expect(fetched.result.status.state).toBe("TASK_STATE_COMPLETED");
  });

  test("headerless (legacy) streams keep the pre-task shape: statusUpdate first, final flags, no artifact frames", async () => {
    mockExecutorText("Hello world");

    const response = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agentId}`,
      headers: { authorization: "Bearer test-token" },
      payload: jsonRpc(40, "SendStreamingMessage", {
        message: userMessage("hi"),
      }),
    });

    const events = parseSseEvents(response.body);
    expect(events[0].result?.statusUpdate?.status.state).toBe(
      "TASK_STATE_WORKING",
    );
    expect(events[0].result?.statusUpdate?.final).toBe(false);
    expect(events.some((e) => e.result?.artifactUpdate)).toBe(false);
    expect(events.some((e) => e.result?.task)).toBe(false);
    const last = events[events.length - 1];
    expect(last.result?.statusUpdate?.final).toBe(true);
    expect(last.result?.statusUpdate?.status.state).toBe(
      "TASK_STATE_COMPLETED",
    );
    expect(last.result?.statusUpdate?.status.message?.parts?.[0]?.text).toBe(
      "Hello world",
    );
  });

  test("SubscribeToTask on a terminal task is a plain -32004 JSON-RPC error", async () => {
    mockExecutorText("done");
    const created = await rpc(50, "SendMessage", {
      message: userMessage("quick"),
      configuration: { returnImmediately: true },
    });
    await pollTaskUntil(created.result.task.id, "TASK_STATE_COMPLETED");

    const response = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agentId}`,
      headers: { authorization: "Bearer test-token" },
      payload: jsonRpc(51, "SubscribeToTask", { id: created.result.task.id }),
    });
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json().error).toMatchObject({ code: -32004 });
  });

  test("a dropped streaming client no longer kills the run, and SubscribeToTask rejoins it live", async () => {
    const gate = mockExecutorGated();

    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/v2/a2a/${agentId}`;

    // Open a streaming send with a real socket and read the first frame.
    const streamController = new AbortController();
    const streamResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        "a2a-version": "1.0",
      },
      body: JSON.stringify(
        jsonRpc(60, "SendStreamingMessage", {
          message: userMessage("slow question"),
        }),
      ),
      signal: streamController.signal,
    });
    const reader = streamResponse.body?.getReader();
    if (!reader) throw new Error("expected stream body");
    let buffer = "";
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
    }
    const firstFrame = parseSseEvents(buffer)[0];
    const taskId = firstFrame?.result?.task?.id;
    if (!taskId) throw new Error("expected initial task frame");

    // Drop the client mid-run. The run must keep going.
    streamController.abort();

    // Rejoin via SubscribeToTask on a fresh socket.
    const subscribeResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(jsonRpc(61, "SubscribeToTask", { id: taskId })),
    });
    const subscribeReader = subscribeResponse.body?.getReader();
    if (!subscribeReader) throw new Error("expected subscribe body");

    // First frame is the current Task snapshot.
    let subscribeBuffer = "";
    while (!subscribeBuffer.includes("\n\n")) {
      const { value, done } = await subscribeReader.read();
      if (done) break;
      subscribeBuffer += new TextDecoder().decode(value);
    }
    const snapshot = parseSseEvents(subscribeBuffer)[0];
    expect(snapshot?.result?.task?.id).toBe(taskId);
    expect(snapshot?.result?.task?.status.state).toBe("TASK_STATE_WORKING");

    // Let the run finish; the subscriber receives events until the terminal
    // status and the stream closes.
    await gate.release("survived the disconnect");
    while (true) {
      const { value, done } = await subscribeReader.read();
      if (done) break;
      subscribeBuffer += new TextDecoder().decode(value);
    }
    const frames = parseSseEvents(subscribeBuffer);
    const terminal = frames[frames.length - 1];
    expect(terminal.result?.statusUpdate?.status.state).toBe(
      "TASK_STATE_COMPLETED",
    );

    // And the durable record agrees: the disconnected run completed.
    const fetched = await rpc(62, "GetTask", { id: taskId });
    expect(fetched.result.status.state).toBe("TASK_STATE_COMPLETED");
    expect(fetched.result.artifacts?.[0]?.parts).toEqual([
      { text: "survived the disconnect" },
    ]);
  });
});
