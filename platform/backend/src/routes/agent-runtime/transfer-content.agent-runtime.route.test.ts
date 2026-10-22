import { createHash } from "node:crypto";
import { vi } from "vitest";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import { agentSandboxApi } from "@/k8s/agent-runtime/sandbox-api";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useRouteTestApp } from "@/test/route-test-app";
import agentRuntimeRoutes from "./agent-runtime.routes";

setupTestCacheManager();

describe("/api/agent-workspace-transfers/:transferId/content", () => {
  const ctx = useRouteTestApp(agentRuntimeRoutes);

  beforeEach(() => {
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
  });

  test("a request with the wrong token, no bearer or the wrong direction is not found", async ({
    makeAgent,
  }) => {
    const taskId = await retainedRun({
      makeAgent,
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
    const bytes = Buffer.from("probe");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const helper = vi
      .spyOn(agentRuntimeManager, "runWorkspaceTransferCommand")
      .mockImplementation(async ({ args }) => {
        if (args[0] === "stat")
          return { ok: true, path: args[1], present: false };
        throw new Error(`unexpected helper call: ${args.join(" ")}`);
      });
    const started = await ctx.app.inject({
      method: "POST",
      url: `/api/agent-runs/${taskId}/workspace/transfers`,
      payload: {
        direction: "upload",
        path: "probe/hello.txt",
        size: bytes.length,
        sha256,
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    const { token, contentUrl } = started.json();

    const refused = [
      { method: "PUT" as const, authorization: `Bearer ${token.slice(1)}` },
      { method: "PUT" as const, authorization: undefined },
      { method: "GET" as const, authorization: `Bearer ${token}` },
    ];
    for (const attempt of refused) {
      const response = await ctx.app.inject({
        method: attempt.method,
        url: contentUrl,
        headers: {
          ...(attempt.authorization
            ? { authorization: attempt.authorization }
            : {}),
          ...(attempt.method === "PUT"
            ? { "content-type": "application/octet-stream" }
            : {}),
        },
        ...(attempt.method === "PUT" ? { payload: bytes } : {}),
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({
        error: { message: "Transfer not found" },
      });
    }
    // None of them reached the workspace.
    expect(helper).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Helpers
// =============================================================================

/** A retained, idle run whose owner may move files in and out of it. */
async function retainedRun(params: {
  makeAgent: (overrides: Record<string, unknown>) => Promise<{ id: string }>;
  organizationId: string;
  userId: string;
}): Promise<string> {
  const { organizationId, userId } = params;
  const agent = await params.makeAgent({
    organizationId,
    authorId: userId,
    runtime: {
      image: "runtime:test",
      command: null,
      inferenceProtocol: "openai_chat",
      backend: "kubernetes",
      steerMode: "tmux_keys",
      privileged: false,
      resources: null,
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
  const workloadName = `agent-run-${task.id}`;
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
  await AgentWorkspaceModel.create({
    organizationId,
    agentId: agent.id,
    actorKind: "user",
    actorId: userId,
    backend: "kubernetes",
    runtimeScope: "archestra-dev",
    workloadName,
    state: "idle",
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return task.id;
}
