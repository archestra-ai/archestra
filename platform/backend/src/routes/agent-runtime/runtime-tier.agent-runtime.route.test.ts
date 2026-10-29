import { vi } from "vitest";
import config from "@/config";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { ClusterLeaseHeldError } from "@/models/mcp-deployment-lease";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import {
  issueRuntimeBinding,
  RUNTIME_BINDING_HEADER,
} from "@/services/agent-runtime/runtime-identity";
import { beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useRouteTestApp } from "@/test/route-test-app";
import { drainBackgroundWork } from "@/utils/background-work";
import agentRuntimeRoutes from "./agent-runtime.routes";

setupTestCacheManager();

const LITE_IMAGE = "registry.example.test/lobster-env-codex-lite:abc";
const FULL_IMAGE = "registry.example.test/lobster-env-codex:abc";

describe("POST /api/agent-runtime/self/tier", () => {
  const ctx = useRouteTestApp(agentRuntimeRoutes);

  beforeEach(() => {
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
    const allowPrivileged = config.agentRuntime.allowPrivileged;
    config.agentRuntime.allowPrivileged = true;
    return () => {
      config.agentRuntime.allowPrivileged = allowPrivileged;
    };
  });

  test("moves the caller's workspace to the Full tier and continues the turn there", async ({
    makeAgent,
  }) => {
    const run = await liveTurn({ makeAgent, ctx });
    const switchTier = vi
      .spyOn(backend, "switchWorkspaceTier")
      .mockImplementation(async ({ onStarted }) => {
        onStarted?.(true);
        return true;
      });

    const response = await post(run.binding, { tier: "full" });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toEqual({ tier: "full", switching: true });
    await drainBackgroundWork();
    expect(switchTier).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: "full",
        settings: {
          image: FULL_IMAGE,
          privileged: true,
          resources: {
            cpuRequest: "3500m",
            memoryRequest: "12Gi",
            memoryLimit: "18Gi",
          },
        },
        resumePrompt: expect.stringContaining("Full tier"),
      }),
    );
    const { shouldResume, session } = switchTier.mock.calls[0][0];
    expect(session.taskId).toBe(run.taskId);
    expect(await shouldResume()).toBe(true);
    await A2ATaskModel.updateState(run.taskId, "TASK_STATE_CANCELED");
    expect(await shouldResume()).toBe(false);
  });

  test("answers without a switch when the workspace already runs the tier", async ({
    makeAgent,
  }) => {
    const run = await liveTurn({ makeAgent, ctx });
    vi.spyOn(backend, "switchWorkspaceTier").mockImplementation(
      async ({ onStarted }) => {
        onStarted?.(false);
        return false;
      },
    );

    const response = await post(run.binding, { tier: "light" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ tier: "light", switching: false });
  });

  test("refuses a request while another switch of the run is in progress", async ({
    makeAgent,
  }) => {
    const run = await liveTurn({ makeAgent, ctx });
    vi.spyOn(backend, "switchWorkspaceTier").mockRejectedValue(
      new ClusterLeaseHeldError("agent-run-tier-switch", "run"),
    );

    const response = await post(run.binding, { tier: "full" });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.message).toContain("already in progress");
  });

  test("refuses a missing or forged binding and a turn that is no longer current", async ({
    makeAgent,
  }) => {
    const run = await liveTurn({ makeAgent, ctx });
    const switchTier = vi.spyOn(backend, "switchWorkspaceTier");

    expect((await post(undefined, { tier: "full" })).statusCode).toBe(401);
    expect(
      (await post(`${run.binding.slice(0, -2)}xx`, { tier: "full" }))
        .statusCode,
    ).toBe(401);

    await AgentWorkspaceModel.release({
      workloadName: run.workloadName,
      taskId: run.taskId,
      suspended: false,
    });
    const ended = await post(run.binding, { tier: "full" });
    expect(ended.statusCode, ended.body).toBe(409);
    expect(switchTier).not.toHaveBeenCalled();
  });

  test("refuses an Agent without a Full tier", async ({ makeAgent }) => {
    const run = await liveTurn({ makeAgent, ctx, fullTier: null });
    const response = await post(run.binding, { tier: "full" });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.message).toContain("no Full tier");
  });

  test("refuses a privileged Full tier the operator disabled", async ({
    makeAgent,
  }) => {
    const run = await liveTurn({ makeAgent, ctx });
    config.agentRuntime.allowPrivileged = false;
    const response = await post(run.binding, { tier: "full" });
    expect(response.statusCode, response.body).toBe(403);
  });

  function post(binding: string | undefined, payload: { tier: string }) {
    return ctx.app.inject({
      method: "POST",
      url: "/api/agent-runtime/self/tier",
      headers: binding ? { [RUNTIME_BINDING_HEADER]: binding } : {},
      payload,
    });
  }
});

async function liveTurn(params: {
  makeAgent: (overrides: Record<string, unknown>) => Promise<{ id: string }>;
  ctx: { organizationId: string; user: { id: string } };
  fullTier?: null;
}) {
  const { organizationId } = params.ctx;
  const userId = params.ctx.user.id;
  const agent = await params.makeAgent({
    organizationId,
    authorId: userId,
    runtime: {
      image: LITE_IMAGE,
      command: null,
      inferenceProtocol: "openai_responses",
      backend: "kubernetes",
      steerMode: "tmux_keys",
      privileged: false,
      resources: {
        cpuRequest: "2",
        memoryRequest: "4Gi",
        memoryLimit: "8Gi",
      },
      fullTier:
        params.fullTier === null
          ? null
          : {
              image: FULL_IMAGE,
              privileged: true,
              resources: {
                cpuRequest: "3500m",
                memoryRequest: "12Gi",
                memoryLimit: "18Gi",
              },
            },
      environment: null,
      credentials: null,
      ttlHours: 1,
      idleTimeoutMinutes: 5,
    },
  });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: userId,
  });
  const task = await A2ATaskModel.createForRun({
    contextId: context.id,
    agentId: agent.id,
  });
  await A2ATaskModel.updateState(task.id, "TASK_STATE_WORKING");
  const workloadName = `agent-run-${task.id.slice(0, 8)}`;
  await AgentRunModel.create({
    organizationId,
    agentId: agent.id,
    taskId: task.id,
    actorKind: "user",
    actorId: userId,
    actorUserId: userId,
    backend: "kubernetes",
    runtimeScope: "archestra-dev",
    workloadName,
  });
  const workspace = await AgentWorkspaceModel.create({
    id: task.id,
    organizationId,
    agentId: agent.id,
    actorKind: "user",
    actorId: userId,
    backend: "kubernetes",
    runtimeScope: "archestra-dev",
    workloadName,
    activeTaskId: task.id,
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const binding = issueRuntimeBinding({
    secret: config.openappa.offerSigningSecret,
    organizationId,
    workspaceId: workspace.id,
    workloadName,
    taskId: task.id,
    agentId: agent.id,
    actorKind: "user",
    actorId: userId,
    expiresAt: Date.now() + 3600_000,
  });
  if (!binding) throw new Error("test deployment has no signing secret");
  return { taskId: task.id, workloadName, binding };
}
