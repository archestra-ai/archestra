import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  McpToolCallModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import interactionRoutes from "./interaction";

describe("GET /api/llm-proxy-logs/sessions/:sessionId/handoffs", () => {
  const ctx = useRouteTestApp(interactionRoutes);
  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
  });
  const read = (sessionId: string) =>
    ctx.app.inject({
      method: "GET",
      url: `/api/llm-proxy-logs/sessions/${encodeURIComponent(sessionId)}/handoffs`,
    });

  test("links the client session and the run's session, with each change of hands", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      name: "Platform Coder",
    });
    const run = await makeRun({
      agentId: agent.id,
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      workloadName: "agent-run-fix-flake-1",
    });
    await AgentRunModel.setOriginLlmSessionId({
      taskId: run.taskId,
      originLlmSessionId: LOCAL,
    });
    // The first writer wins: nothing re-points a run at another session.
    await AgentRunModel.setOriginLlmSessionId({
      taskId: run.taskId,
      originLlmSessionId: "another-session",
    });

    const call = (name: string, args: Record<string, unknown>, result = {}) =>
      McpToolCallModel.create({
        agentId: agent.id,
        userId: ctx.user.id,
        sessionId: LOCAL,
        mcpServerName: name.split("__")[0],
        method: "tools/call",
        toolCall: { id: crypto.randomUUID(), name, arguments: args },
        toolResult: { isError: false, ...result },
      });
    const start = await call(
      "archestra__start_agent_run",
      { message: "Fix the flaky test" },
      { structuredContent: { run: { run_id: run.taskId } } },
    );
    // A follow-up while the run holds the work is not a move.
    await call("archestra__steer_agent_run", { run_id: run.taskId });
    // Sending a file to the run is not taking the work back.
    await call("archestra__transfer_workspace_file", {
      run_id: run.taskId,
      direction: "upload",
    });
    const pull = await call("archestra__transfer_workspace_file", {
      run_id: run.taskId,
      direction: "download",
    });
    await call("archestra__cancel_agent_run", { run_id: run.taskId });
    // Another server's tool of the same short name never counts.
    await call("other__steer_agent_run", { run_id: run.taskId });
    const steer = await call("archestra__steer_agent_run", {
      run_id: run.taskId,
    });

    const local = await read(LOCAL);
    expect(local.statusCode, local.body).toBe(200);
    expect(local.json()).toMatchObject({
      handedTo: [
        {
          runId: run.taskId,
          llmSessionId: "agent-run-fix-flake-1",
          originLlmSessionId: LOCAL,
          agentName: "Platform Coder",
        },
      ],
      handedFrom: null,
    });
    expect(
      local
        .json()
        .moves.map((m: { kind: string; mcpToolCallId: string }) => [
          m.kind,
          m.mcpToolCallId,
        ]),
    ).toEqual([
      ["push", start.id],
      ["pull", pull.id],
      ["steer", steer.id],
    ]);

    const remote = await read("agent-run-fix-flake-1");
    expect(remote.statusCode, remote.body).toBe(200);
    expect(remote.json()).toMatchObject({
      handedTo: [],
      handedFrom: { runId: run.taskId, originLlmSessionId: LOCAL },
    });
    expect(remote.json().moves).toEqual(local.json().moves);
  });

  test("shows a member only their own runs", async ({
    makeAgent,
    makeUser,
  }) => {
    const agent = await makeAgent({ organizationId: ctx.organizationId });
    const someoneElse = await makeUser();
    const run = await makeRun({
      agentId: agent.id,
      organizationId: ctx.organizationId,
      userId: someoneElse.id,
      workloadName: "agent-run-someone-else",
    });
    await AgentRunModel.setOriginLlmSessionId({
      taskId: run.taskId,
      originLlmSessionId: LOCAL,
    });

    for (const sessionId of [LOCAL, "agent-run-someone-else"]) {
      const response = await read(sessionId);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        handedTo: [],
        handedFrom: null,
        moves: [],
      });
    }
  });

  test("a run started without a known session links to nothing", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId: ctx.organizationId });
    await makeRun({
      agentId: agent.id,
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      workloadName: "agent-run-unlinked",
    });
    const response = await read("agent-run-unlinked");
    expect(response.json()).toEqual({
      handedTo: [],
      handedFrom: null,
      moves: [],
    });
  });
});

const LOCAL = "c7d2e9a4-5b1f-4e8a-9c3d-6f2a1b8e4d70";

async function makeRun(params: {
  agentId: string;
  organizationId: string;
  userId: string;
  workloadName: string;
}) {
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: params.userId,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: params.agentId,
    state: "TASK_STATE_WORKING",
  });
  return AgentRunModel.create({
    taskId: task.id,
    agentId: params.agentId,
    organizationId: params.organizationId,
    actorKind: "user",
    actorId: params.userId,
    actorUserId: params.userId,
    backend: "kubernetes",
    runtimeScope: "test",
    workloadName: params.workloadName,
    title: "Fix the flaky test",
  });
}
