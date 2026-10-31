import { createHash } from "node:crypto";
import { Readable } from "node:stream";
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
import { ApiError } from "@/types";
import agentRuntimeRoutes from "./agent-runtime.routes";

setupTestCacheManager();

describe("/api/agent-workspace-transfers/:transferId/content", () => {
  const ctx = useRouteTestApp(agentRuntimeRoutes);

  beforeEach(() => {
    vi.spyOn(agentSandboxApi, "isInstalled", "get").mockReturnValue(true);
  });

  test.for([
    "idle",
    "suspended",
  ] as const)("downloads and resumes binary files while the workspace is %s", async (state, {
    makeAgent,
  }) => {
    const taskId = await retainedRun({
      makeAgent,
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      state,
    });
    const resume = vi
      .spyOn(agentRuntimeManager, "resumeWorkspace")
      .mockResolvedValue(undefined);
    const bytes = Buffer.alloc(5 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index++)
      bytes[index] = index % 256;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    vi.spyOn(
      agentRuntimeManager,
      "runWorkspaceTransferCommand",
    ).mockResolvedValue({
      transfer_id: "binary-snapshot",
      path: "artifacts/archive.tar.gz",
      size: bytes.length,
      sha256,
      ino: "1",
      mtime_ns: "1",
    });
    vi.spyOn(
      agentRuntimeManager,
      "readWorkspaceTransferRange",
    ).mockImplementation(async ({ offset }) => ({
      stdout: Readable.from([bytes.subarray(offset)]),
      completed: Promise.resolve(),
    }));
    const started = await ctx.app.inject({
      method: "POST",
      url: `/api/agent-runs/${taskId}/workspace/transfers`,
      payload: { direction: "download", path: "artifacts/archive.tar.gz" },
    });
    expect(started.statusCode, started.body).toBe(200);
    const { token, contentUrl } = started.json();
    for (const offset of [0, 1024]) {
      const response = await ctx.app.inject({
        method: "GET",
        url: contentUrl,
        headers: {
          authorization: `Bearer ${token}`,
          ...(offset ? { range: `bytes=${offset}-` } : {}),
        },
      });
      expect(response.statusCode, response.body.slice(0, 500)).toBe(
        offset ? 206 : 200,
      );
      expect(response.rawPayload.equals(bytes.subarray(offset))).toBe(true);
      expect(response.headers.etag).toBe(`"${sha256}"`);
    }
    expect(resume).toHaveBeenCalledTimes(state === "suspended" ? 1 : 0);
  });

  test.for([
    409, 500,
  ])("a failed download preserves its %i error before any bytes are sent", async (statusCode, {
    makeAgent,
  }) => {
    const taskId = await retainedRun({
      makeAgent,
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
    vi.spyOn(
      agentRuntimeManager,
      "runWorkspaceTransferCommand",
    ).mockResolvedValue({
      transfer_id: "unavailable-snapshot",
      path: "artifacts/archive.tar.gz",
      size: 5 * 1024 * 1024,
      sha256: "a".repeat(64),
      ino: "1",
      mtime_ns: "1",
    });
    vi.spyOn(
      agentRuntimeManager,
      "readWorkspaceTransferRange",
    ).mockImplementation(async () => ({
      stdout: new Readable({
        read() {
          this.destroy(
            statusCode === 409
              ? new ApiError(409, "The pinned export is no longer available")
              : new Error("The pinned export is no longer available"),
          );
        },
      }),
      completed: Promise.resolve(),
    }));
    const started = await ctx.app.inject({
      method: "POST",
      url: `/api/agent-runs/${taskId}/workspace/transfers`,
      payload: { direction: "download", path: "artifacts/archive.tar.gz" },
    });
    expect(started.statusCode, started.body).toBe(200);
    const { token, contentUrl } = started.json();
    const response = await ctx.app.inject({
      method: "GET",
      url: contentUrl,
      headers: { authorization: `Bearer ${token}`, range: "bytes=1024-" },
    });
    expect(response.statusCode, response.body).toBe(statusCode);
    expect(response.json()).toMatchObject({
      error: { message: "The pinned export is no longer available" },
    });
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-range"]).toBeUndefined();
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers["accept-ranges"]).toBeUndefined();
    expect(Number(response.headers["content-length"])).toBe(
      response.rawPayload.length,
    );
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
  state?: "idle" | "suspended";
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
    state: params.state ?? "idle",
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return task.id;
}
