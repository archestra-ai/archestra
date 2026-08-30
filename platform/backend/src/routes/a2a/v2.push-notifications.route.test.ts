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

describe("a2a v2 push notification configs", () => {
  let app: FastifyInstanceWithZod;
  let agentId: string;
  let taskId: string;

  beforeEach(async ({ makeInternalAgent, makeUser, makeMember }) => {
    const agent = await makeInternalAgent();
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    agentId = agent.id;

    mockValidateMCPGatewayToken.mockResolvedValue({
      organizationId: agent.organizationId,
      userId: user.id,
    });
    mockExecuteA2AMessage.mockImplementation(
      async (_params: A2AExecuteParams) => {
        const messageId = crypto.randomUUID();
        return {
          messageId,
          text: "done",
          finishReason: "stop",
          responseUiMessage: {
            id: messageId,
            role: "assistant",
            parts: [{ type: "text", text: "done" }],
          },
        };
      },
    );

    app = createFastifyInstance();
    const { default: a2aV2Routes } = await import("./v2");
    await app.register(a2aV2Routes);

    const created = await rpc("SendMessage", {
      message: {
        messageId: crypto.randomUUID(),
        role: "ROLE_USER",
        parts: [{ text: "hi" }],
      },
      configuration: { returnImmediately: true },
    });
    taskId = created.result.task.id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    mockExecuteA2AMessage.mockReset();
    mockValidateMCPGatewayToken.mockReset();
    await app.close();
  });

  async function rpc(method: string, params: unknown) {
    const response = await app.inject({
      method: "POST",
      url: `/v2/a2a/${agentId}`,
      headers: { authorization: "Bearer test-token" },
      payload: { jsonrpc: "2.0", id: 1, method, params },
    });
    return response.json();
  }

  const create = (config: Record<string, unknown>) =>
    rpc("CreateTaskPushNotificationConfig", {
      taskId,
      pushNotificationConfig: config,
    });

  test("registers a config and never echoes the credentials back", async () => {
    const created = await create({
      url: "https://hooks.example.com/a2a",
      token: "corr-1",
      authentication: { scheme: "Bearer", credentials: "super-secret" },
    });

    const config = created.result.pushNotificationConfig;
    expect(config.id).toEqual(expect.any(String));
    expect(config.url).toBe("https://hooks.example.com/a2a");
    expect(config.token).toBe("corr-1");
    // The scheme is useful to the caller; the credential is write-only.
    expect(config.authentication).toEqual({ scheme: "Bearer" });
    expect(JSON.stringify(created)).not.toContain("super-secret");

    const fetched = await rpc("GetTaskPushNotificationConfig", {
      taskId,
      id: config.id,
    });
    expect(JSON.stringify(fetched)).not.toContain("super-secret");
    expect(fetched.result.pushNotificationConfig.authentication).toEqual({
      scheme: "Bearer",
    });
  });

  test("re-registering an existing id updates in place instead of duplicating", async () => {
    const first = (await create({ url: "https://hooks.example.com/one" }))
      .result.pushNotificationConfig;

    const again = await create({
      id: first.id,
      url: "https://hooks.example.com/two",
    });
    expect(again.result.pushNotificationConfig.id).toBe(first.id);

    const listed = await rpc("ListTaskPushNotificationConfigs", { taskId });
    expect(listed.result.configs).toHaveLength(1);
    expect(listed.result.configs[0].pushNotificationConfig.url).toBe(
      "https://hooks.example.com/two",
    );
  });

  test("lists and deletes configs", async () => {
    const a = (await create({ url: "https://hooks.example.com/a" })).result
      .pushNotificationConfig;
    await create({ url: "https://hooks.example.com/b" });

    expect(
      (await rpc("ListTaskPushNotificationConfigs", { taskId })).result.configs,
    ).toHaveLength(2);

    await rpc("DeleteTaskPushNotificationConfig", { taskId, id: a.id });
    expect(
      (await rpc("ListTaskPushNotificationConfigs", { taskId })).result.configs,
    ).toHaveLength(1);

    // A deleted config is gone, not merely hidden.
    expect(
      (await rpc("GetTaskPushNotificationConfig", { taskId, id: a.id })).error
        .code,
    ).toBe(-32001);
    expect(
      (await rpc("DeleteTaskPushNotificationConfig", { taskId, id: a.id }))
        .error.code,
    ).toBe(-32001);
  });

  test.for([
    ["a malformed url", "definitely-not-a-url"],
    ["a non-web scheme", "ftp://example.com/hook"],
    // Rejected even in local development: pointing the server at cloud
    // metadata or a cluster-internal address is the SSRF this guards.
    ["cloud metadata", "http://169.254.169.254/latest/meta-data"],
    ["an RFC1918 address", "http://10.1.2.3/hook"],
  ])("refuses to register %s", async ([, url]) => {
    const result = await create({ url: url as string });
    expect(result.error.code).toBe(-32602);
    expect(
      (await rpc("ListTaskPushNotificationConfigs", { taskId })).result.configs,
    ).toHaveLength(0);
  });

  test("configs are scoped to their task", async () => {
    const config = (await create({ url: "https://hooks.example.com/a" })).result
      .pushNotificationConfig;

    const otherTask = (
      await rpc("SendMessage", {
        message: {
          messageId: crypto.randomUUID(),
          role: "ROLE_USER",
          parts: [{ text: "second" }],
        },
        configuration: { returnImmediately: true },
      })
    ).result.task.id;

    // Another task cannot read a config that is not its own.
    expect(
      (
        await rpc("GetTaskPushNotificationConfig", {
          taskId: otherTask,
          id: config.id,
        })
      ).error.code,
    ).toBe(-32001);
    expect(
      (await rpc("ListTaskPushNotificationConfigs", { taskId: otherTask }))
        .result.configs,
    ).toHaveLength(0);
  });

  test("an unknown task is indistinguishable from an unauthorized one", async () => {
    const result = await rpc("ListTaskPushNotificationConfigs", {
      taskId: crypto.randomUUID(),
    });
    expect(result.error.code).toBe(-32001);
  });
});
