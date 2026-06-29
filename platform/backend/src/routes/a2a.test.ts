import { vi } from "vitest";
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

describe("a2a routes", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async ({ makeInternalAgent }) => {
    const agent = await makeInternalAgent();
    mockValidateMCPGatewayToken.mockResolvedValue({
      organizationId: agent.organizationId,
      userId: null,
    });
    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "msg-1",
      text: "agent-response",
    });

    app = createFastifyInstance();
    const { default: a2aRoutes } = await import("./a2a");
    await app.register(a2aRoutes);

    (app as FastifyInstanceWithZod & { __agentId: string }).__agentId =
      agent.id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    mockExecuteA2AMessage.mockReset();
    mockValidateMCPGatewayToken.mockReset();
    await app.close();
  });

  test("forwards extracted text when body is a JSON-RPC envelope", async () => {
    const agentId = (app as FastifyInstanceWithZod & { __agentId: string })
      .__agentId;

    const response = await app.inject({
      method: "POST",
      url: `/v1/a2a/${agentId}`,
      headers: { authorization: "Bearer test-token" },
      payload: {
        jsonrpc: "2.0",
        id: 42,
        method: "message/send",
        params: {
          message: {
            parts: [
              { kind: "text", text: "hello" },
              { kind: "text", text: "world" },
            ],
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
    expect(mockExecuteA2AMessage.mock.calls[0][0]).toMatchObject({
      agentId,
      message: "hello\nworld",
    });
    expect(response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 42,
      result: {
        messageId: "msg-1",
        role: "agent",
        parts: [{ kind: "text", text: "agent-response" }],
      },
    });
  });

  test("passes through stringified body when payload is not JSON-RPC", async () => {
    const agentId = (app as FastifyInstanceWithZod & { __agentId: string })
      .__agentId;
    const webhookPayload = { event: "ping", data: { foo: "bar" } };

    const response = await app.inject({
      method: "POST",
      url: `/v1/a2a/${agentId}`,
      headers: { authorization: "Bearer test-token" },
      payload: webhookPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
    expect(mockExecuteA2AMessage.mock.calls[0][0]).toMatchObject({
      agentId,
      message: JSON.stringify(webhookPayload),
    });
    expect(response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        messageId: "msg-1",
        role: "agent",
        parts: [{ kind: "text", text: "agent-response" }],
      },
    });
  });
});
