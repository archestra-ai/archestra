import { vi } from "vitest";
import type { A2AExecuteParams } from "@/agents/a2a-executor";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const { mockExecuteA2AMessage, mockValidateMCPGatewayToken } = vi.hoisted(
  () => ({
    mockExecuteA2AMessage: vi.fn(),
    mockValidateMCPGatewayToken: vi.fn(),
  }),
);

vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: (...args: unknown[]) => mockExecuteA2AMessage(...args),
}));

vi.mock("@/routes/mcp-gateway.utils", async () => {
  const actual = await vi.importActual<
    typeof import("@/routes/mcp-gateway.utils")
  >("@/routes/mcp-gateway.utils");
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
      final: boolean;
      status: {
        state: string;
        message?: { parts?: { text?: string }[] };
      };
    };
    message?: { parts?: { text?: string }[] };
    task?: unknown;
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

function streamingPayload(id: number, text: string) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "SendStreamingMessage",
    params: {
      message: {
        // a2a_message.id is a uuid column, so persisted message ids must be uuids.
        messageId: crypto.randomUUID(),
        role: "ROLE_USER",
        parts: [{ text }],
      },
    },
  };
}

describe("a2a v2 streaming route", () => {
  let app: FastifyInstanceWithZod;
  let agentId: string;

  beforeEach(async ({ makeInternalAgent, makeUser, makeMember }) => {
    const agent = await makeInternalAgent();
    const user = await makeUser();
    // getById (used when resolving the actor from the token) requires an org
    // membership, so enroll the user in the agent's organization.
    await makeMember(user.id, agent.organizationId);
    agentId = agent.id;

    mockValidateMCPGatewayToken.mockResolvedValue({
      organizationId: agent.organizationId,
      userId: user.id,
    });

    // The mocked executor forwards two deltas then returns the buffered result
    // the manager persists and the route frames as the terminal event.
    mockExecuteA2AMessage.mockImplementation(
      async (params: A2AExecuteParams) => {
        params.onTextDelta?.("Hello ");
        params.onTextDelta?.("world");
        // The persisted agent message id must be a uuid (a2a_message.id column).
        const messageId = crypto.randomUUID();
        return {
          messageId,
          text: "Hello world",
          finishReason: "stop",
          responseUiMessage: {
            id: messageId,
            role: "assistant",
            parts: [{ type: "text", text: "Hello world" }],
          },
        };
      },
    );

    app = createFastifyInstance();
    const { default: a2aV2Routes } = await import("./a2a-v2");
    await app.register(a2aV2Routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    mockExecuteA2AMessage.mockReset();
    mockValidateMCPGatewayToken.mockReset();
    await app.close();
  });

  test("advertises the streaming capability in the agent card", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v2/a2a/${agentId}/.well-known/agent-card.json`,
      headers: { authorization: "Bearer test-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().capabilities.streaming).toBe(true);
  });

  test("SendStreamingMessage streams incremental deltas then a terminal completed event over SSE", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agentId}`,
      headers: { authorization: "Bearer test-token" },
      payload: streamingPayload(7, "hi"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");

    const events = parseSseEvents(response.body);
    // Every frame is a well-formed JSON-RPC response echoing the request id.
    for (const event of events) {
      expect(event.jsonrpc).toBe("2.0");
      expect(event.id).toBe(7);
    }

    // First frame: an immediate "working" signal with no message.
    expect(events[0].result?.statusUpdate?.status.state).toBe(
      "TASK_STATE_WORKING",
    );
    expect(events[0].result?.statusUpdate?.status.message).toBeUndefined();

    // Interim frames carry the incremental text deltas in order.
    const deltaTexts = events
      .filter(
        (e) =>
          e.result?.statusUpdate?.final === false &&
          e.result.statusUpdate.status.message,
      )
      .flatMap((e) =>
        (e.result?.statusUpdate?.status.message?.parts ?? []).map(
          (p) => p.text,
        ),
      );
    expect(deltaTexts).toEqual(["Hello ", "world"]);

    // Terminal frame: final=true, completed, carrying the authoritative message.
    const finalEvent = events.find(
      (e) => e.result?.statusUpdate?.final === true,
    );
    expect(finalEvent?.result?.statusUpdate?.status.state).toBe(
      "TASK_STATE_COMPLETED",
    );
    expect(
      finalEvent?.result?.statusUpdate?.status.message?.parts?.[0].text,
    ).toBe("Hello world");
    // The terminal frame is the last one emitted.
    expect(events[events.length - 1]).toBe(finalEvent);
  });

  test("reuses a shared streamed task id across all status updates", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agentId}`,
      headers: { authorization: "Bearer test-token" },
      payload: streamingPayload(8, "hi"),
    });

    const taskIds = parseSseEvents(response.body)
      .map((e) => e.result?.statusUpdate?.taskId)
      .filter((id): id is string => typeof id === "string");
    expect(taskIds.length).toBeGreaterThan(0);
    expect(new Set(taskIds).size).toBe(1);
  });

  test("returns a buffered JSON-RPC error (not an SSE stream) when the token is unauthorized", async () => {
    mockValidateMCPGatewayToken.mockResolvedValue(null);

    const response = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agentId}`,
      headers: { authorization: "Bearer test-token" },
      payload: streamingPayload(9, "hi"),
    });

    expect(response.headers["content-type"]).not.toContain("text/event-stream");
    const body = response.json();
    expect(body.error).toBeDefined();
    expect(body.result).toBeUndefined();
    // The agent run must never start when the actor cannot be resolved.
    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });
});
