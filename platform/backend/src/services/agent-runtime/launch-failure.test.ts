import { HttpResponse, http } from "msw";
import { A2AProtocolTaskState } from "@/agents/a2a/a2a-protocol";
import config from "@/config";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
import { afterEach, expect, test, vi } from "@/test";
import { useMswServer } from "@/test/msw";
import type { ResolvedAgentRuntime } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import { kubernetesAgentRuntimeBackendDriver as backend } from "./backends/kubernetes";
import { runTaskInAgentRuntime } from "./pod-run";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
useMswServer(
  http.post("http://127.0.0.1:9000/v1/openai/:agentId/chat/completions", () =>
    HttpResponse.json(
      { error: { message: "Title unavailable" } },
      { status: 400 },
    ),
  ),
);
afterEach(drainBackgroundWork);

test.for([
  "initial",
  "continuation",
  "stop-failure",
] as const)("failed %s launch never exposes a potentially running workspace for another claim", async (mode, {
  makeOrganization,
  makeAdmin,
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
  makeAgent,
}) => {
  config.agentRuntime.platformBaseUrl = "https://platform.example.test";
  vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
  const org = await makeOrganization();
  const user = await makeAdmin();
  await makeMember(user.id, org.id, { role: "admin" });
  const secret = await makeSecret({ secret: { apiKey: "test-upstream-key" } });
  const key = await makeLlmProviderApiKey(org.id, secret.id, {
    provider: "openai",
  });
  const model = await ModelModel.create({
    externalId: "openai/test-model",
    provider: "openai",
    modelId: "test-model",
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    lastSyncedAt: new Date(),
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [model.id]);
  const agent = await makeAgent({
    organizationId: org.id,
    authorId: user.id,
    agentType: "agent",
    modelId: model.id,
    llmApiKeyId: key.id,
  });
  const runtime: ResolvedAgentRuntime = {
    agentId: agent.id,
    organizationId: org.id,
    environmentId: null,
    secretId: null,
    image: "test-agent:latest",
    command: null,
    inferenceProtocol: "openai_chat",
    backend: "kubernetes",
    steerMode: "pipe",
    privileged: false,
    resources: null,
    environment: null,
    credentials: null,
    ttlHours: null,
    maxCostUsd: null,
    idleTimeoutMinutes: null,
  };
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const previousTask = await A2ATaskModel.createForRun({
    contextId: context.id,
    agentId: agent.id,
  });
  const task = await A2ATaskModel.createForRun({
    contextId: context.id,
    agentId: agent.id,
  });
  if (mode !== "initial") {
    const previous = await AgentRunModel.create({
      organizationId: org.id,
      agentId: agent.id,
      taskId: previousTask.id,
      actorKind: "user",
      actorId: user.id,
      backend: "kubernetes",
      runtimeScope: backend.resolveRuntimeScope({}),
      workloadName: `failure-${task.id}`,
    });
    await AgentRunModel.close({ id: previous.id });
    await AgentWorkspaceModel.create({
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      backend: "kubernetes",
      runtimeScope: previous.runtimeScope,
      workloadName: previous.workloadName,
      state: "idle",
      lastTaskId: previousTask.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
  }
  vi.spyOn(backend, "launch").mockRejectedValue(
    new Error("publication connection lost"),
  );
  vi.spyOn(backend, "continueRun").mockRejectedValue(
    new Error("publication connection lost"),
  );
  vi.spyOn(backend, "teardown").mockResolvedValue();
  const release = vi.spyOn(backend, "releaseRun").mockResolvedValue();
  const stop = vi.spyOn(backend, "stopRun").mockImplementation(async (run) => {
    expect(
      (await AgentWorkspaceModel.findByWorkloadName(run.workloadName))
        ?.activeTaskId,
    ).toBe(task.id);
    if (mode === "stop-failure") throw new Error("cluster unavailable");
  });
  await expect(
    runTaskInAgentRuntime({
      runtime,
      taskId: task.id,
      agentId: agent.id,
      actor: { kind: "user", id: user.id, organizationId: org.id },
      organizationId: org.id,
      runMode: "one_shot",
      task: "Test launch failure",
      modelId: null,
      llmApiKeyId: null,
      ...(mode === "initial" ? {} : { resumeFromTaskId: previousTask.id }),
    }),
  ).rejects.toThrow("publication connection lost");
  const run = await AgentRunModel.findByTaskId(task.id);
  if (!run) throw new Error("Expected persisted run");
  const workspace = await AgentWorkspaceModel.findByWorkloadName(
    run.workloadName,
  );
  expect(workspace?.state).toBe(
    mode === "initial"
      ? "deleted"
      : mode === "stop-failure"
        ? "active"
        : "idle",
  );
  expect(Boolean(run.endedAt)).toBe(mode !== "stop-failure");
  expect(stop).toHaveBeenCalledTimes(mode === "initial" ? 0 : 1);
  expect(release).toHaveBeenCalledTimes(mode === "continuation" ? 1 : 0);
  if (mode === "stop-failure") expect(workspace?.activeTaskId).toBe(task.id);
});

test("a throttled launch settles the task as failed before its workspace cleanup is visible", async ({
  makeOrganization,
  makeAdmin,
  makeMember,
  makeAgent,
}) => {
  config.agentRuntime.platformBaseUrl = "https://platform.example.test";
  vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
  const org = await makeOrganization();
  const user = await makeAdmin();
  await makeMember(user.id, org.id, { role: "admin" });
  const agent = await makeAgent({
    organizationId: org.id,
    authorId: user.id,
    agentType: "agent",
  });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.createForRun({
    contextId: context.id,
    agentId: agent.id,
  });
  // The shape the Kubernetes client throws when the API server sheds load.
  vi.spyOn(backend, "launch").mockRejectedValue(
    Object.assign(new Error("HTTP-Code: 500"), {
      code: 500,
      body: JSON.stringify({
        kind: "Status",
        status: "Failure",
        message:
          "rpc error: code = ResourceExhausted desc = stream terminated by RST_STREAM with error code: ENHANCE_YOUR_CALM",
        code: 500,
      }),
    }),
  );
  let taskDuringCleanup: Awaited<ReturnType<typeof A2ATaskModel.findById>>;
  vi.spyOn(backend, "teardown").mockImplementation(async () => {
    // The workspace is "deleting" now, which is what the reconciler acts on.
    taskDuringCleanup = await A2ATaskModel.findById(task.id);
  });

  await expect(
    runTaskInAgentRuntime({
      runtime: {
        agentId: agent.id,
        organizationId: org.id,
        environmentId: null,
        secretId: null,
        image: "test-agent:latest",
        command: null,
        inferenceProtocol: "openai_chat",
        backend: "kubernetes",
        steerMode: "pipe",
        privileged: false,
        resources: null,
        environment: null,
        credentials: null,
        ttlHours: null,
        maxCostUsd: null,
        idleTimeoutMinutes: null,
      },
      taskId: task.id,
      agentId: agent.id,
      actor: { kind: "user", id: user.id, organizationId: org.id },
      organizationId: org.id,
      runMode: "one_shot",
      task: "Test throttled launch",
      modelId: null,
      llmApiKeyId: null,
    }),
  ).rejects.toThrow("Kubernetes API was overloaded or unavailable");

  expect(taskDuringCleanup?.state).toBe(A2AProtocolTaskState.Failed);
  expect(taskDuringCleanup?.statusReason).toContain(
    "Start the run again in a minute",
  );
  expect(taskDuringCleanup?.statusReason).toContain("ENHANCE_YOUR_CALM");
});
