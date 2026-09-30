import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
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
import { afterEach, expect, type TestFixtures, test, vi } from "@/test";
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
  const { launch, finish, org, actor, agent, project, trigger } =
    await setUpRuntimeSchedule({
      makeOrganization,
      makeAdmin,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeInternalAgent,
      makeScheduleTrigger,
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
    error: expect.stringMatching(
      new RegExp(`^Skipped: run ${run.id} was still in progress \\(started `),
    ),
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

test("a scheduled runtime run that never finishes is stopped at its time limit and the schedule resumes", async ({
  makeOrganization,
  makeAdmin,
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
  makeInternalAgent,
  makeScheduleTrigger,
  makeScheduleTriggerRun,
}) => {
  const timeoutMinutes = config.agentRuntime.scheduledRunTimeoutMinutes;
  try {
    const { launch, org, trigger } = await setUpRuntimeSchedule({
      makeOrganization,
      makeAdmin,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
      makeInternalAgent,
      makeScheduleTrigger,
    });
    const stopRun = vi.mocked(backend.stopRun);
    const run = await makeScheduleTriggerRun(trigger.id);
    await handleScheduleTriggerRunExecution({ runId: run.id });
    const taskId = (await ScheduleTriggerRunModel.findById(run.id))
      ?.runtimeTaskId as string;
    await expect.poll(() => launch.mock.calls.length).toBe(1);
    // The workload never completes: the agent sits idle, as a client does
    // when it returns to its prompt without ending the turn.

    config.agentRuntime.scheduledRunTimeoutMinutes = 240;
    await makeDue(trigger.id);
    await handleCheckDueScheduleTriggers();
    const skipped = (
      await ScheduleTriggerRunModel.listByTrigger({
        organizationId: org.id,
        triggerId: trigger.id,
      })
    ).find((candidate) => candidate.id !== run.id);
    expect(skipped?.error).toMatch(
      new RegExp(
        `^Skipped: run ${run.id} was still in progress .*A scheduled run is stopped after 4 h\\.$`,
      ),
    );
    expect(stopRun).not.toHaveBeenCalled();

    // The run outlives the limit.
    config.agentRuntime.scheduledRunTimeoutMinutes = 30;
    await db
      .update(schema.scheduleTriggerRunsTable)
      .set({ startedAt: new Date(Date.now() - 31 * 60_000) })
      .where(eq(schema.scheduleTriggerRunsTable.id, run.id));
    await makeDue(trigger.id);
    await handleCheckDueScheduleTriggers();

    const reason =
      "The scheduled run was stopped after 30 min, its time limit.";
    expect(await A2ATaskModel.findById(taskId)).toMatchObject({
      state: "TASK_STATE_FAILED",
      statusReason: reason,
    });
    expect(await ScheduleTriggerRunModel.findById(run.id)).toMatchObject({
      status: "failed",
      error: reason,
    });
    expect(stopRun).toHaveBeenCalled();

    // The same tick starts the next run instead of recording another skip.
    const runs = await ScheduleTriggerRunModel.listByTrigger({
      organizationId: org.id,
      triggerId: trigger.id,
    });
    expect(runs.filter((candidate) => candidate.status === "running")).toEqual([
      expect.objectContaining({ runKind: "due" }),
    ]);
  } finally {
    config.agentRuntime.scheduledRunTimeoutMinutes = timeoutMinutes;
  }
});

// =============================================================================
// Internal
// =============================================================================

/**
 * A runtime agent with a scheduled trigger, backed by the real scheduler, task
 * lifecycle and DB. Only the container driver and model network are replaced;
 * the workload completes when the test calls `finish`.
 */
async function setUpRuntimeSchedule({
  makeOrganization,
  makeAdmin,
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
  makeInternalAgent,
  makeScheduleTrigger,
}: Pick<
  TestFixtures,
  | "makeOrganization"
  | "makeAdmin"
  | "makeMember"
  | "makeSecret"
  | "makeLlmProviderApiKey"
  | "makeInternalAgent"
  | "makeScheduleTrigger"
>) {
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
  return { launch, finish, org, actor, agent, project, trigger };
}

async function makeDue(triggerId: string) {
  await ScheduleTriggerModel.update(triggerId, {
    enabled: true,
    lastExecutedAt: new Date(Date.now() - 120_000),
  });
}
