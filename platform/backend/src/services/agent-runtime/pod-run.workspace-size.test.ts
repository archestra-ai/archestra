import { HttpResponse, http } from "msw";
import config from "@/config";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import { afterEach, expect, test, vi } from "@/test";
import { useMswServer } from "@/test/msw";
import type { AgentRunLimits, ResolvedAgentRuntime } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import type { AgentRunLaunchSpec } from "./backends";
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

const RECORDED_LIMITS = {
  tier: "M",
  idleTimeoutMinutes: 60,
  maxDurationHours: 24,
  maxCostUsd: null,
} satisfies AgentRunLimits;

test.for([
  {
    name: "a new run records its tier's volume and is told that size",
    prior: null,
    told: 60,
  },
  {
    name: "a continuation is told the volume recorded when its workspace was created, not the tier's size now",
    prior: { ...RECORDED_LIMITS, workspaceGiB: 40 },
    told: 40,
  },
  {
    name: "a continuation of a workspace from before sizes were recorded is told nothing about its volume",
    prior: RECORDED_LIMITS,
    told: undefined,
  },
])("$name", async ({ prior, told }, {
  makeOrganization,
  makeAdmin,
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
  makeAgent,
}) => {
  config.agentRuntime.platformBaseUrl = "https://platform.example.test";
  vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
  vi.spyOn(backend, "assertReady").mockResolvedValue();
  const org = await makeOrganization();
  // Tier M (the default) gives its runs 60 GiB today.
  await OrganizationModel.patch(org.id, {
    agentRuntimeTiers: {
      tiers: [
        { name: "S", cpuRequest: 2, cpuLimit: null, warmSpares: 0 },
        {
          name: "M",
          cpuRequest: 4,
          cpuLimit: null,
          warmSpares: 0,
          workspaceGiB: 60,
        },
      ],
      defaultTier: "M",
    },
  });
  const user = await makeAdmin();
  await makeMember(user.id, org.id, { role: "admin" });
  const secret = await makeSecret({ secret: { apiKey: "test-upstream-key" } });
  const key = await makeLlmProviderApiKey(org.id, secret.id, {
    provider: "openai",
  });
  const model = await ModelModel.create({
    externalId: "openai/workspace-size-model",
    provider: "openai",
    modelId: "workspace-size-model",
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
    image: "test-agent:v1",
    command: null,
    inferenceProtocol: "openai_chat",
    backend: "kubernetes",
    steerMode: "pipe",
    privileged: false,
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
  if (prior) {
    const previous = await AgentRunModel.create({
      organizationId: org.id,
      agentId: agent.id,
      taskId: previousTask.id,
      actorKind: "user",
      actorId: user.id,
      backend: "kubernetes",
      runtimeScope: backend.resolveRuntimeScope({}),
      workloadName: `size-${task.id}`,
      runtimeLimits: prior,
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
  // Capture the spec the backend gets, then stop: the run record and the
  // spec are what this test is about.
  let launched: AgentRunLaunchSpec | undefined;
  const capture = async (spec: AgentRunLaunchSpec) => {
    launched = spec;
    throw new Error("captured");
  };
  vi.spyOn(backend, "launch").mockImplementation(capture);
  vi.spyOn(backend, "continueRun").mockImplementation(({ spec }) =>
    capture(spec),
  );
  vi.spyOn(backend, "teardown").mockResolvedValue();
  vi.spyOn(backend, "releaseRun").mockResolvedValue();
  vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);

  await expect(
    runTaskInAgentRuntime({
      runtime,
      taskId: task.id,
      agentId: agent.id,
      actor: { kind: "user", id: user.id, organizationId: org.id },
      organizationId: org.id,
      runMode: "one_shot",
      task: "Check the volume",
      modelId: null,
      llmApiKeyId: null,
      ...(prior ? { resumeFromTaskId: previousTask.id } : {}),
    }),
  ).rejects.toThrow("captured");

  const run = await AgentRunModel.findByTaskId(task.id);
  expect(run?.runtimeLimits?.workspaceGiB).toBe(told);
  if (!launched) throw new Error("Expected a launch spec");
  const prompt = launched.secretEnv.ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT;
  const own = JSON.parse(launched.env.ARCHESTRA_AGENT_RUNTIME_TIERS).find(
    (tier: { current?: boolean }) => tier.current,
  );
  if (told === undefined) {
    expect(prompt).not.toContain("The workspace volume is");
    expect(own).not.toHaveProperty("workspace_gib");
  } else {
    expect(prompt).toContain(
      `The workspace volume is ${told} GiB in all, including any Docker data.`,
    );
    expect(own.workspace_gib).toBe(told);
  }
  // A new workspace's volume is created at its tier's size.
  if (!prior) expect(launched.workspaceStorageSize).toBe("60Gi");
});
