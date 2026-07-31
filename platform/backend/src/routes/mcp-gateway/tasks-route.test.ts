/**
 * MCP Tasks extension through the real gateway route.
 *
 * The contract these pin: a call from a Tasks-declaring client that outlives
 * the threshold answers with a durable task handle, and the eventual result is
 * exactly what a synchronous caller would have received; everyone else keeps
 * the blocking behavior they always had. Threshold is dropped to 60ms via the
 * config mock so slow-vs-fast is deterministic without ten-second sleeps.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    // The task threshold derives from the one timeout knob: min(10s,
    // timeout/2). 120ms ⇒ a 60ms threshold, so slow-vs-fast is deterministic.
    mcpGateway: { toolCallTimeoutMs: 120 },
  }),
);

import mcpClient from "@/clients/mcp-client";
import { McpGatewayTaskModel, TeamTokenModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import mcpGatewayRoutes from "./index";

const TOOL_NAME = "tracker__slow_report";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const TASKS_META = {
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { "io.modelcontextprotocol/tasks": {} },
  },
};

describe("MCP Gateway - Tasks extension", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  async function seed(fixtures: {
    makeAgent: (a?: object) => Promise<{ id: string }>;
    makeOrganization: () => Promise<{ id: string }>;
    makeInternalMcpCatalog: (a: object) => Promise<{ id: string }>;
    makeTool: (a: object) => Promise<{ id: string }>;
    makeAgentTool: (a: string, b: string) => Promise<unknown>;
  }) {
    const agent = await fixtures.makeAgent();
    const org = await fixtures.makeOrganization();
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    const catalog = await fixtures.makeInternalMcpCatalog({
      organizationId: org.id,
      name: "tracker",
    });
    const tool = await fixtures.makeTool({
      catalogId: catalog.id,
      name: TOOL_NAME,
      parameters: { type: "object", properties: {} },
    });
    await fixtures.makeAgentTool(agent.id, tool.id);
    return { agent, org, token };
  }

  function mockUpstream(delayMs: number) {
    const captured: { signal?: AbortSignal } = {};
    vi.spyOn(mcpClient, "executeToolCallForOwner").mockImplementation(
      async (toolCall, _owner, _auth, options) => {
        captured.signal = (
          options as { abortSignal?: AbortSignal }
        )?.abortSignal;
        await sleep(delayMs);
        return {
          id: (toolCall as { id: string }).id,
          name: TOOL_NAME,
          content: [{ type: "text", text: "report ready" }],
          isError: false,
        } as never;
      },
    );
    return captured;
  }

  function callTool(params: {
    agentId: string;
    token: string;
    meta?: Record<string, unknown>;
    id?: number;
  }) {
    return app.inject({
      method: "POST",
      url: `/v1/mcp/${params.agentId}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${params.token}`,
      },
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: TOOL_NAME,
          arguments: {},
          ...(params.meta && { _meta: params.meta }),
        },
        id: params.id ?? 1,
      },
    });
  }

  function taskMethod(params: {
    agentId: string;
    token: string;
    method: string;
    taskId: string;
  }) {
    return app.inject({
      method: "POST",
      url: `/v1/mcp/${params.agentId}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${params.token}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": params.method,
      },
      payload: {
        jsonrpc: "2.0",
        method: params.method,
        params: { taskId: params.taskId },
        id: 99,
      },
    });
  }

  async function pollUntilTerminal(params: {
    agentId: string;
    token: string;
    taskId: string;
  }): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await taskMethod({ ...params, method: "tasks/get" });
      const task = response.json().result.task as Record<string, unknown>;
      if (task.status !== "working") return task;
      await sleep(25);
    }
    throw new Error("task never reached a terminal status");
  }

  test("a slow call from a Tasks client detaches into a task whose result matches the synchronous one", async ({
    makeAgent,
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
  }) => {
    const { agent, token } = await seed({
      makeAgent,
      makeOrganization,
      makeInternalMcpCatalog,
      makeTool,
      makeAgentTool,
    });
    mockUpstream(250);

    const response = await callTool({
      agentId: agent.id,
      token: token.value,
      meta: TASKS_META,
    });

    expect(response.statusCode).toBe(200);
    const { result } = response.json();
    expect(result.resultType).toBe("task");
    expect(result.task).toMatchObject({
      status: "working",
      pollIntervalMs: expect.any(Number),
      ttlMs: expect.any(Number),
    });

    const task = await pollUntilTerminal({
      agentId: agent.id,
      token: token.value,
      taskId: result.task.taskId,
    });

    expect(task.status).toBe("completed");
    // The stored result is the full response a synchronous caller gets —
    // envelope included.
    expect(task.result).toMatchObject({
      resultType: "complete",
      content: [{ type: "text", text: "report ready" }],
    });
  });

  test("a fast call from a Tasks client stays synchronous", async ({
    makeAgent,
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
  }) => {
    const { agent, token } = await seed({
      makeAgent,
      makeOrganization,
      makeInternalMcpCatalog,
      makeTool,
      makeAgentTool,
    });
    mockUpstream(5);

    // The threshold races the WHOLE route execution — policy checks and DB
    // reads included, not just the mocked upstream — so on a loaded CI
    // runner the file-level 60ms threshold can lapse before even a fast call
    // finishes, flipping this test's result into a task. Give this test
    // alone a threshold no loaded runner can cross; taskSyncThresholdMs()
    // reads config live, so the override takes effect immediately.
    const config = (await import("@/config")).default;
    const previousTimeoutMs = config.mcpGateway.toolCallTimeoutMs;
    config.mcpGateway.toolCallTimeoutMs = 20 * 60 * 1000; // threshold caps at 10s
    try {
      const { result } = (
        await callTool({
          agentId: agent.id,
          token: token.value,
          meta: TASKS_META,
        })
      ).json();

      // Task creation is server-directed, and for a call that finished inside
      // the threshold the server directs "no".
      expect(result.resultType).toBe("complete");
      expect(result.content).toEqual([{ type: "text", text: "report ready" }]);
    } finally {
      config.mcpGateway.toolCallTimeoutMs = previousTimeoutMs;
    }
  });

  test("a client that never declared the extension keeps blocking behavior", async ({
    makeAgent,
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
  }) => {
    const { agent, token } = await seed({
      makeAgent,
      makeOrganization,
      makeInternalMcpCatalog,
      makeTool,
      makeAgentTool,
    });
    mockUpstream(250);

    const { result } = (
      await callTool({ agentId: agent.id, token: token.value })
    ).json();

    // The spec forbids returning a task to a client that did not declare
    // support — the slow call just blocks, as it always did.
    expect(result.resultType).not.toBe("task");
    expect(result.content).toEqual([{ type: "text", text: "report ready" }]);
  });

  test("tasks/cancel cancels the row and aborts the running upstream call", async ({
    makeAgent,
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
  }) => {
    const { agent, token } = await seed({
      makeAgent,
      makeOrganization,
      makeInternalMcpCatalog,
      makeTool,
      makeAgentTool,
    });
    const captured = mockUpstream(2_000);

    const { result } = (
      await callTool({
        agentId: agent.id,
        token: token.value,
        meta: TASKS_META,
      })
    ).json();
    expect(result.resultType).toBe("task");

    const cancel = await taskMethod({
      agentId: agent.id,
      token: token.value,
      method: "tasks/cancel",
      taskId: result.task.taskId,
    });
    // Acknowledged with an empty result, per the extension.
    expect(cancel.json().result).toMatchObject({ resultType: "complete" });

    const after = await taskMethod({
      agentId: agent.id,
      token: token.value,
      method: "tasks/get",
      taskId: result.task.taskId,
    });
    expect(after.json().result.task.status).toBe("cancelled");
    // Same-replica cancellation reaches the upstream call itself.
    expect(captured.signal?.aborted).toBe(true);
  });

  test("another principal's task is indistinguishable from a missing one", async ({
    makeAgent,
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
  }) => {
    const { agent, org, token } = await seed({
      makeAgent,
      makeOrganization,
      makeInternalMcpCatalog,
      makeTool,
      makeAgentTool,
    });
    mockUpstream(400);

    const { result } = (
      await callTool({
        agentId: agent.id,
        token: token.value,
        meta: TASKS_META,
      })
    ).json();
    expect(result.resultType).toBe("task");

    const otherToken = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Other Token",
      teamId: null,
      isOrganizationToken: true,
    });

    const response = await taskMethod({
      agentId: agent.id,
      token: otherToken.value,
      method: "tasks/get",
      taskId: result.task.taskId,
    });
    expect(response.json().error).toMatchObject({ code: -32602 });
    expect(response.json().error.message).toContain("Unknown task");
  });

  test("an expired task is gone even for its owner", async ({
    makeAgent,
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
  }) => {
    const { agent, token } = await seed({
      makeAgent,
      makeOrganization,
      makeInternalMcpCatalog,
      makeTool,
      makeAgentTool,
    });

    // Minted directly with an already-passed expiry: the row exists, and
    // expiry alone must make it unservable.
    const expired = await McpGatewayTaskModel.create({
      agentId: agent.id,
      principal: `token:${token.token.id}`,
      toolName: TOOL_NAME,
      ttlMs: -1_000,
    });

    const response = await taskMethod({
      agentId: agent.id,
      token: token.value,
      method: "tasks/get",
      taskId: expired.id,
    });
    expect(response.json().error).toMatchObject({ code: -32602 });
  });

  test("a tool that elicits after detaching fails the task with an actionable reason", async ({
    makeAgent,
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
  }) => {
    const { agent, token } = await seed({
      makeAgent,
      makeOrganization,
      makeInternalMcpCatalog,
      makeTool,
      makeAgentTool,
    });

    // Upstream asks for interactive input only after the call has already
    // been detached as a task — nobody is connected to answer.
    vi.spyOn(mcpClient, "executeToolCallForOwner").mockImplementation(
      async (_toolCall, _owner, _auth, options) => {
        await sleep(150);
        return (await (
          options as {
            elicitationHandler: (r: unknown) => Promise<never>;
          }
        ).elicitationHandler({
          method: "elicitation/create",
          params: { mode: "form", message: "Which project?" },
        })) as never;
      },
    );

    const { result } = (
      await callTool({
        agentId: agent.id,
        token: token.value,
        meta: {
          "io.modelcontextprotocol/clientCapabilities": {
            elicitation: {},
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
        },
      })
    ).json();
    expect(result.resultType).toBe("task");

    const task = await pollUntilTerminal({
      agentId: agent.id,
      token: token.value,
      taskId: result.task.taskId,
    });

    expect(task.status).toBe("failed");
    expect((task.error as { message: string }).message).toContain(
      "interactive input",
    );
  });

  test("task methods do not exist for legacy clients", async ({
    makeAgent,
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
  }) => {
    const { agent, token } = await seed({
      makeAgent,
      makeOrganization,
      makeInternalMcpCatalog,
      makeTool,
      makeAgentTool,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.value}`,
      },
      payload: {
        jsonrpc: "2.0",
        method: "tasks/get",
        params: { taskId: "00000000-0000-0000-0000-000000000000" },
        id: 1,
      },
    });

    expect(response.json().error).toMatchObject({ code: -32601 });
  });

  test("the sync threshold derives from the single timeout knob", async () => {
    const { taskSyncThresholdMs } = await import("./tasks");
    // toolCallTimeoutMs is mocked to 120 ⇒ half of it.
    expect(taskSyncThresholdMs()).toBe(60);
  });

  test("server/discover advertises the Tasks extension on 2026-07-28", async ({
    makeAgent,
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
  }) => {
    const { agent, token } = await seed({
      makeAgent,
      makeOrganization,
      makeInternalMcpCatalog,
      makeTool,
      makeAgentTool,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.value}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      payload: { jsonrpc: "2.0", method: "server/discover", id: 5 },
    });

    expect(response.json().result.capabilities.extensions).toHaveProperty(
      "io.modelcontextprotocol/tasks",
    );
  });
});
