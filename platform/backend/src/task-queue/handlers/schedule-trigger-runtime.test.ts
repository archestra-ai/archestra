import config from "@/config";
import {
  A2ATaskModel,
  AgentRunModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  ProjectModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
} from "@/models";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import type { AgentRunCompletion } from "@/services/agent-runtime/backends/types";
import { afterEach, expect, test, vi } from "@/test";
import { handleCheckDueScheduleTriggers } from "./check-due-schedule-triggers-handler";
import { handleScheduleTriggerRunExecution } from "./schedule-trigger-run-handler";

afterEach(() => vi.restoreAllMocks());

// Exercise the scheduler, task lifecycle, launch-spec construction and real DB.
// Only the external container driver and model-provider network are replaced.
test.for([
  "succeeded",
  "failed",
] as const)("scheduled runtime launches once and records %s only after the workload settles", async (outcome, {
  makeOrganization,
  makeAdmin,
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
  makeInternalAgent,
  makeScheduleTrigger,
  makeScheduleTriggerRun,
}) => {
  config.agentRuntime.enabled = true;
  config.agentRuntime.platformBaseUrl = "https://platform.example.test";
  vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
  vi.spyOn(backend, "resolveRuntimeScope").mockReturnValue("test-runtime");
  const launch = vi.spyOn(backend, "launch").mockResolvedValue();
  vi.spyOn(backend, "stageInputs").mockResolvedValue();
  vi.spyOn(backend, "waitUntilRunning").mockResolvedValue();
  vi.spyOn(backend, "streamOutput").mockImplementation(
    async ({ destination }) => {
      destination.end("Dependency review complete.\n");
    },
  );
  vi.spyOn(backend, "snapshotOutput").mockImplementation(
    async ({ destination }) => {
      destination.end("Dependency review complete.\n");
    },
  );
  vi.spyOn(backend, "releaseRun").mockResolvedValue();
  vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);
  let finish!: (result: AgentRunCompletion) => void;
  const completion = new Promise<AgentRunCompletion>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(backend, "waitForCompletion").mockReturnValue(completion);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("model unavailable", { status: 400 })),
  );

  const org = await makeOrganization();
  const actor = await makeAdmin();
  await makeMember(actor.id, org.id, { role: "admin" });
  const secret = await makeSecret({ secret: { apiKey: "test-provider-key" } });
  const key = await makeLlmProviderApiKey(org.id, secret.id, {
    provider: "openai",
  });
  const model = await ModelModel.create({
    externalId: "openai/test-runtime-model",
    provider: "openai",
    modelId: "test-runtime-model",
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    lastSyncedAt: new Date(),
  });
  await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [model.id]);
  const agent = await makeInternalAgent({
    organizationId: org.id,
    authorId: actor.id,
    modelId: model.id,
    llmApiKeyId: key.id,
    runtime: {
      image: "example.test/dependency-worker:1",
      command: ["dependency-worker"],
      inferenceProtocol: "openai_responses",
      backend: "kubernetes",
      steerMode: "pipe",
      privileged: false,
      resources: null,
      environment: null,
      credentials: null,
      ttlHours: null,
      idleTimeoutMinutes: null,
    },
  });
  const project = await ProjectModel.create({
    organizationId: org.id,
    userId: actor.id,
    name: "Dependency maintenance",
  });
  const trigger = await makeScheduleTrigger({
    organizationId: org.id,
    agentId: agent.id,
    actorUserId: actor.id,
    projectId: project.id,
    enabled: false,
  });
  const run = await makeScheduleTriggerRun(trigger.id);

  await Promise.all([
    handleScheduleTriggerRunExecution({ runId: run.id }),
    handleScheduleTriggerRunExecution({ runId: run.id }),
  ]);
  const launched = await ScheduleTriggerRunModel.findById(run.id);
  expect(launched).toMatchObject({
    status: "running",
    completedAt: null,
    chatConversationId: null,
  });
  expect(launched?.runtimeTaskId).toEqual(expect.any(String));
  const taskId = launched?.runtimeTaskId as string;
  await expect.poll(() => launch.mock.calls.length).toBe(1);
  expect(launch.mock.calls[0][0]).toMatchObject({
    image: agent.runtime?.image,
  });
  expect(launch.mock.calls[0][0].env.ARCHESTRA_AGENT_RUNTIME_MODE).toBe(
    "one_shot",
  );
  expect(await AgentRunModel.findByTaskId(taskId)).toMatchObject({
    actorUserId: actor.id,
    projectId: project.id,
  });

  await handleScheduleTriggerRunExecution({ runId: run.id });
  await handleCheckDueScheduleTriggers();
  expect(launch).toHaveBeenCalledTimes(1);
  expect((await ScheduleTriggerRunModel.findById(run.id))?.status).toBe(
    "running",
  );

  // The launch queue has returned, but another due tick must still see work.
  await ScheduleTriggerModel.update(trigger.id, {
    enabled: true,
    lastExecutedAt: new Date(Date.now() - 120_000),
  });
  await handleCheckDueScheduleTriggers();
  const overlapping = await ScheduleTriggerRunModel.listByTrigger({
    organizationId: org.id,
    triggerId: trigger.id,
  });
  expect(
    overlapping.find((candidate) => candidate.id !== run.id),
  ).toMatchObject({
    status: "failed",
    error: "Skipped: previous run was still in progress",
  });
  await ScheduleTriggerModel.update(trigger.id, { enabled: false });

  finish({
    outcome,
    reason: outcome === "failed" ? "Container exited with code 1" : undefined,
  });
  await expect
    .poll(async () => (await A2ATaskModel.findById(taskId))?.state)
    .toBe(
      outcome === "succeeded" ? "TASK_STATE_COMPLETED" : "TASK_STATE_FAILED",
    );
  // A later scheduler instance uses only durable state, even for disabled triggers.
  await handleCheckDueScheduleTriggers();
  const settled = await ScheduleTriggerRunModel.findById(run.id);
  expect(settled?.status).toBe(outcome === "succeeded" ? "success" : "failed");
  expect(settled?.completedAt).toBeInstanceOf(Date);
  if (outcome === "failed")
    expect(settled?.error).toContain("Container exited with code 1");
  await handleCheckDueScheduleTriggers();
  expect((await ScheduleTriggerRunModel.findById(run.id))?.completedAt).toEqual(
    settled?.completedAt,
  );

  // Runtime configuration must never silently fall back to foreground execution.
  config.agentRuntime.enabled = false;
  const disabled = await makeScheduleTriggerRun(trigger.id);
  await handleScheduleTriggerRunExecution({ runId: disabled.id });
  expect(await ScheduleTriggerRunModel.findById(disabled.id)).toMatchObject({
    status: "failed",
    error: expect.stringContaining("Agent Runtime is disabled"),
  });
});
