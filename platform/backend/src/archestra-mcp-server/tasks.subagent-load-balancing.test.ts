import {
  TOOL_START_AGENT_RUN_FULL_NAME,
  TOOL_TRANSFER_CREDENTIAL_FULL_NAME,
} from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import {
  buildAgentSystemPrompt,
  SUBAGENT_LOAD_BALANCING_INSTRUCTION,
} from "@/agents/agent-system-prompt";
import { CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentExcludedSubagentModel,
  AgentModel,
  AgentRunModel,
  AgentToolModel,
  AgentVersionModel,
  AgentWorkspaceModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
  ToolModel,
} from "@/models";
import type { AgentRunLaunchSpec } from "@/services/agent-runtime/backends";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import {
  resolveAgentRuntime,
  runTaskInAgentRuntime,
} from "@/services/agent-runtime/pod-run";
import {
  agentRunFailure,
  tagAgentRunFailure,
} from "@/services/agent-runtime/run-failure";
import { subagentLoadBalancer } from "@/services/agent-runtime/subagent-load-balancer";
import { restoreAgentVersion } from "@/services/agent-version-restore";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import { type Agent, type AgentRuntime, SelectAgentSchema } from "@/types";
import { AgentConfigSnapshotSchema } from "@/types/agent-version";
import { drainBackgroundWork } from "@/utils/background-work";
import { type ArchestraContext, executeArchestraTool } from ".";

setupTestCacheManager();

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
useMswServer(
  http.post("http://127.0.0.1:9000/v1/openai/:agentId/chat/completions", () =>
    HttpResponse.json(
      { error: { message: "Title unavailable" } },
      { status: 400 },
    ),
  ),
);

afterEach(async () => {
  await drainBackgroundWork();
  vi.restoreAllMocks();
});

function runtimeConfig(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    image: "ghcr.io/archestra/agent:latest",
    command: null,
    inferenceProtocol: "openai_chat",
    backend: "kubernetes",
    steerMode: "pipe",
    privileged: false,
    environment: null,
    credentials: null,
    ttlHours: null,
    idleTimeoutMinutes: null,
    ...overrides,
  };
}

describe("subagent load balancing, ephemeral grants, and runtime supervisor failover", () => {
  let organizationId: string;
  let actorId: string;
  let modelId: string;
  let llmApiKeyId: string;
  let gateway: Agent;
  let context: ArchestraContext;

  beforeEach(
    async ({
      makeAgent,
      makeLlmProviderApiKey,
      makeMember,
      makeOrganization,
      makeSecret,
      makeUser,
      seedAndAssignArchestraTools,
    }) => {
      config.agentRuntime.platformBaseUrl = "https://platform.example.test";
      vi.spyOn(agentRuntimeManager, "isEnabled", "get").mockReturnValue(true);
      vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
      vi.spyOn(backend, "assertReady").mockResolvedValue();

      const organization = await makeOrganization();
      organizationId = organization.id;
      const actor = await makeUser();
      actorId = actor.id;
      await makeMember(actorId, organizationId, { role: "admin" });

      const secret = await makeSecret({
        secret: { apiKey: "test-upstream-key" },
      });
      const key = await makeLlmProviderApiKey(organizationId, secret.id, {
        provider: "openai",
      });
      llmApiKeyId = key.id;
      const model = await ModelModel.create({
        externalId: `openai/lb-model-${organizationId.slice(0, 8)}`,
        provider: "openai",
        modelId: "lb-model",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        lastSyncedAt: new Date(),
      });
      modelId = model.id;
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
        model.id,
      ]);

      gateway = await makeAgent({
        name: "Code Review Gateway",
        organizationId,
        authorId: actorId,
        agentType: "mcp_gateway",
        accessAllSubagents: false,
      });
      await seedAndAssignArchestraTools(gateway.id);
      context = {
        agent: { id: gateway.id, name: gateway.name },
        agentId: gateway.id,
        userId: actorId,
        organizationId,
      };
    },
  );

  async function createRuntimeSubagent(
    makeAgent: (overrides: Record<string, unknown>) => Promise<Agent>,
    name: string,
    assignToGateway = true,
  ): Promise<Agent> {
    const subagent = await makeAgent({
      name,
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: runtimeConfig({
        allowAgentSuppliedCredentialValues: true,
        maxTier: "M",
      }),
    });
    if (assignToGateway) {
      const delegationTool = await ToolModel.findOrCreateDelegationTool(
        subagent.id,
      );
      await AgentToolModel.create(gateway.id, delegationTool.id);
    }
    return subagent;
  }

  async function mockDetachedTaskStart() {
    return vi
      .spyOn(A2AManager.prototype, "sendMessage")
      .mockImplementation(async (params) => {
        const a2aContext = await A2AContextModel.create({
          actorKind: params.actor.kind,
          actorId: params.actor.id,
        });
        const task = await A2ATaskModel.createForRun({
          contextId: a2aContext.id,
          agentId: params.agentId,
        });
        return {
          task: {
            id: task.id,
            contextId: a2aContext.id,
            status: { state: "TASK_STATE_WORKING" },
          },
        } as never;
      });
  }

  test("resolves candidate runtime subagents in All-agents mode while respecting exclusions", async ({
    makeAgent,
  }) => {
    await AgentModel.update(gateway.id, {
      accessAllSubagents: true,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
        retries: 0,
        fallbackEnabled: true,
      },
    });
    const subagentA = await createRuntimeSubagent(
      makeAgent,
      "Subagent A",
      false,
    );
    const subagentB = await createRuntimeSubagent(
      makeAgent,
      "Subagent B",
      false,
    );
    await AgentExcludedSubagentModel.replaceForAgent(gateway.id, [
      subagentA.id,
    ]);

    const sendSpy = await mockDetachedTaskStart();

    const result = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "Review this PR" },
      context,
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      run: {
        agent_id: subagentB.id,
      },
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]?.[0]).toMatchObject({
      agentId: subagentB.id,
    });
  });

  test("intersects exclude_agent_ids with assigned subagents so foreign IDs are ignored and fallbackEnabled=false refuses assigned exclusions", async ({
    makeAgent,
  }) => {
    const subagentA = await createRuntimeSubagent(makeAgent, "Subagent A");
    const subagentB = await createRuntimeSubagent(makeAgent, "Subagent B");
    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
        retries: 0,
        fallbackEnabled: false,
      },
    });

    await mockDetachedTaskStart();

    // Passing a foreign agent_id in exclude_agent_ids must not trigger a fallback refusal.
    const withForeignExclusion = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        message: "Review with foreign exclusion",
        exclude_agent_ids: ["00000000-0000-4000-8000-ffffffffffff"],
      },
      context,
    );
    expect(withForeignExclusion.isError).toBeFalsy();
    expect(withForeignExclusion.structuredContent).toMatchObject({
      run: {
        agent_id: subagentA.id,
      },
    });

    // Passing an actually assigned subagent ID when fallbackEnabled=false is refused.
    const withAssignedExclusion = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        message: "Review with assigned exclusion",
        exclude_agent_ids: [subagentA.id],
      },
      context,
    );
    expect(withAssignedExclusion.isError).toBe(true);
    expect(
      (withAssignedExclusion.content[0] as { text: string }).text,
    ).toContain(
      "No remaining fallback subagents are available on this gateway.",
    );
    expect(subagentB.id).toBeDefined();
  });

  test("consumes one-time ephemeral credential_grant_ids on start_agent_run and rejects reuse", async ({
    makeAgent,
  }) => {
    const subagentA = await createRuntimeSubagent(makeAgent, "Subagent A");
    const subagentB = await createRuntimeSubagent(makeAgent, "Subagent B");
    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
        retries: 1,
        fallbackEnabled: true,
      },
    });

    const mintResult = await executeArchestraTool(
      TOOL_TRANSFER_CREDENTIAL_FULL_NAME,
      {
        ephemeral: true,
        environment: [
          {
            key: "GH_TOKEN",
            type: "secret",
            value: "ghs_ephemeral_token_value",
          },
        ],
      },
      context,
    );
    expect(mintResult.isError).toBeFalsy();
    const grantId = (
      mintResult.structuredContent as { credential_grant_id: string }
    ).credential_grant_id;
    expect(typeof grantId).toBe("string");

    const sendSpy = await mockDetachedTaskStart();

    // A launch refused before a pod is started must NOT spend the grant.
    const refusedStart = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        message: "Refused launch with invalid tier",
        credential_grant_ids: [grantId],
        limits: { tier: "NONEXISTENT_TIER" },
      },
      context,
    );
    expect(refusedStart.isError).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();

    const firstStart = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        message: "Review PR with ephemeral token",
        credential_grant_ids: [grantId],
      },
      context,
    );
    expect(firstStart.isError).toBeFalsy();
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: subagentA.id,
        systemParams: expect.objectContaining({
          ephemeralCredentials: { GH_TOKEN: "ghs_ephemeral_token_value" },
          subagentExecutionPolicy: expect.objectContaining({
            retries: 1,
            fallbackAgentIds: [subagentB.id],
            ephemeralCredentialsByAgentId: {
              [subagentA.id]: { GH_TOKEN: "ghs_ephemeral_token_value" },
              [subagentB.id]: { GH_TOKEN: "ghs_ephemeral_token_value" },
            },
          }),
        }),
      }),
    );

    // Reusing the same one-time grant ID on a second call must fail.
    const secondStart = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        message: "Replay ephemeral grant",
        credential_grant_ids: [grantId],
      },
      context,
    );
    expect(secondStart.isError).toBe(true);
    expect((secondStart.content[0] as { text: string }).text).toContain(
      "expired, already consumed, or invalid",
    );
  });

  test("restores a consumed ephemeral grant with its remaining lifetime when a detached launch fails after returning its task handle", async ({
    makeAgent,
  }) => {
    const subagentA = await createRuntimeSubagent(makeAgent, "Subagent A");
    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
        retries: 0,
        fallbackEnabled: false,
      },
    });

    const mintResult = await executeArchestraTool(
      TOOL_TRANSFER_CREDENTIAL_FULL_NAME,
      {
        ephemeral: true,
        ttl_seconds: 60,
        environment: [
          {
            key: "GH_TOKEN",
            type: "secret",
            value: "ghs_detached_failure_token",
          },
        ],
      },
      context,
    );
    expect(mintResult.isError).toBeFalsy();
    const grantId = (
      mintResult.structuredContent as { credential_grant_id: string }
    ).credential_grant_id;

    let shouldFailLaunch = true;
    const launchedSecretEnvs: Array<Record<string, string>> = [];
    vi.spyOn(backend, "launch").mockImplementation(
      async (spec: AgentRunLaunchSpec) => {
        if (shouldFailLaunch) {
          throw new Error("Cluster unreachable before pod creation");
        }
        launchedSecretEnvs.push(spec.secretEnv);
      },
    );
    vi.spyOn(backend, "waitUntilRunning").mockResolvedValue();
    vi.spyOn(backend, "streamOutput").mockImplementation(
      async ({ destination }) => {
        destination.end();
      },
    );
    vi.spyOn(backend, "snapshotOutput").mockImplementation(
      async ({ destination }) => {
        destination.end("===ARCHESTRA-FINAL-ANSWER===\nDone");
      },
    );
    vi.spyOn(backend, "waitForCompletion").mockResolvedValue({
      outcome: "succeeded",
    });
    vi.spyOn(backend, "teardown").mockResolvedValue();
    vi.spyOn(backend, "releaseRun").mockResolvedValue();
    vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);

    // First detached start returns the task handle, then fails in backend.launch.
    const firstStart = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        agent_id: subagentA.id,
        message: "Run that fails to start a pod",
        credential_grant_ids: [grantId],
      },
      context,
    );
    expect(firstStart.isError).toBeFalsy();
    const firstTaskId = (
      firstStart.structuredContent as { run: { run_id: string } }
    ).run.run_id;

    // Wait for the detached background launch to settle to FAILED and restore the grant.
    await vi.waitFor(async () => {
      const task = await A2ATaskModel.findById(firstTaskId);
      expect(task?.state).toBe("TASK_STATE_FAILED");
    });

    // The grant was restored to the shared cache so a retry of start_agent_run succeeds.
    shouldFailLaunch = false;
    const retryStart = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        agent_id: subagentA.id,
        message: "Retry after detached launch failure",
        credential_grant_ids: [grantId],
      },
      context,
    );
    expect(retryStart.isError).toBeFalsy();
    const retryTaskId = (
      retryStart.structuredContent as { run: { run_id: string } }
    ).run.run_id;

    await vi.waitFor(async () => {
      const task = await A2ATaskModel.findById(retryTaskId);
      expect(task?.state).toBe("TASK_STATE_COMPLETED");
    });
    expect(launchedSecretEnvs).toHaveLength(1);
    expect(launchedSecretEnvs[0]?.GH_TOKEN).toBe("ghs_detached_failure_token");

    // Once a pod actually started, the grant remains spent.
    const replayAfterSuccess = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        agent_id: subagentA.id,
        message: "Replay after pod started",
        credential_grant_ids: [grantId],
      },
      context,
    );
    expect(replayAfterSuccess.isError).toBe(true);
    expect((replayAfterSuccess.content[0] as { text: string }).text).toContain(
      "expired, already consumed, or invalid",
    );
  });

  test("keeps a consumed ephemeral grant out of the shared cache while a retriable launch failure is retried", async ({
    makeAgent,
  }) => {
    const subagentA = await createRuntimeSubagent(makeAgent, "Subagent A");
    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
        retries: 1,
        fallbackEnabled: false,
      },
    });

    const mintResult = await executeArchestraTool(
      TOOL_TRANSFER_CREDENTIAL_FULL_NAME,
      {
        ephemeral: true,
        ttl_seconds: 60,
        environment: [
          {
            key: "GH_TOKEN",
            type: "secret",
            value: "ghs_retriable_launch_token",
          },
        ],
      },
      context,
    );
    expect(mintResult.isError).toBeFalsy();
    const grantId = (
      mintResult.structuredContent as { credential_grant_id: string }
    ).credential_grant_id;
    const grantCacheKey =
      `${CacheKey.EphemeralCredentialGrant}-${grantId}` as const;

    let launchAttempt = 0;
    let cachedBeforeSecondLaunch: unknown = "not-checked";
    const launchedSecretEnvs: Array<Record<string, string>> = [];
    vi.spyOn(backend, "launch").mockImplementation(
      async (spec: AgentRunLaunchSpec) => {
        launchAttempt += 1;
        if (launchAttempt === 1) {
          throw tagAgentRunFailure(
            new Error("Kubernetes API temporarily unavailable"),
            "launch.kubernetes_unavailable",
          );
        }
        cachedBeforeSecondLaunch = await cacheManager.get(grantCacheKey);
        launchedSecretEnvs.push(spec.secretEnv);
      },
    );
    vi.spyOn(backend, "waitUntilRunning").mockResolvedValue();
    vi.spyOn(backend, "streamOutput").mockImplementation(
      async ({ destination }) => {
        destination.end();
      },
    );
    vi.spyOn(backend, "snapshotOutput").mockImplementation(
      async ({ destination }) => {
        destination.end("===ARCHESTRA-FINAL-ANSWER===\nDone after retry");
      },
    );
    vi.spyOn(backend, "waitForCompletion").mockResolvedValue({
      outcome: "succeeded",
    });
    vi.spyOn(backend, "teardown").mockResolvedValue();
    vi.spyOn(backend, "releaseRun").mockResolvedValue();
    vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);

    const startResult = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        agent_id: subagentA.id,
        message: "Run with transient k8s launch failure",
        credential_grant_ids: [grantId],
      },
      context,
    );
    expect(startResult.isError).toBeFalsy();
    const taskId = (
      startResult.structuredContent as { run: { run_id: string } }
    ).run.run_id;

    await vi.waitFor(async () => {
      const task = await A2ATaskModel.findById(taskId);
      expect(task?.state).toBe("TASK_STATE_COMPLETED");
    });

    expect(launchAttempt).toBe(2);
    expect(cachedBeforeSecondLaunch).toBeUndefined();
    expect(launchedSecretEnvs).toHaveLength(1);
    expect(launchedSecretEnvs[0]?.GH_TOKEN).toBe("ghs_retriable_launch_token");
  });

  test("snapshots and restores subagentLoadBalancing across agent versions", async () => {
    const initialPolicy = {
      enabled: true,
      algorithm: "weighted" as const,
      weights: { "00000000-0000-4000-8000-000000000001": 5 },
      retries: 2,
      fallbackEnabled: true,
    };
    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: initialPolicy,
    });
    const v2 = await AgentVersionModel.findByAgentAndVersion({
      agentId: gateway.id,
      version: 2,
      organizationId,
    });
    expect(v2?.snapshot.subagentLoadBalancing).toEqual(initialPolicy);

    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: false,
        algorithm: "round_robin",
        retries: 0,
        fallbackEnabled: false,
      },
    });

    await restoreAgentVersion({
      agentId: gateway.id,
      organizationId,
      version: 2,
      userId: actorId,
    });

    const restored = await AgentModel.findById(gateway.id);
    expect(restored?.subagentLoadBalancing).toEqual(initialPolicy);

    // A legacy stored row or version snapshot with retries: 5 parses as 3 through response schemas
    const parsedAgent = SelectAgentSchema.parse({
      ...restored,
      subagentLoadBalancing: { ...initialPolicy, retries: 5 },
    });
    expect(parsedAgent.subagentLoadBalancing?.retries).toBe(3);

    const parsedSnapshot = AgentConfigSnapshotSchema.parse({
      ...v2?.snapshot,
      subagentLoadBalancing: { ...initialPolicy, retries: 5 },
    });
    expect(parsedSnapshot.subagentLoadBalancing?.retries).toBe(3);
  });

  test("task supervisor escalates tier on OOM retry and fails over to fallback subagent on persistent failure", async ({
    makeAgent,
  }) => {
    await OrganizationModel.patch(organizationId, {
      agentRuntimeTiers: {
        tiers: [
          { name: "S", cpuRequest: 2, cpuLimit: null, warmSpares: 0 },
          { name: "M", cpuRequest: 4, cpuLimit: null, warmSpares: 0 },
        ],
        defaultTier: "S",
      },
    });

    const subagentA = await createRuntimeSubagent(makeAgent, "Subagent A");
    const subagentB = await createRuntimeSubagent(makeAgent, "Subagent B");

    const a2aContext = await A2AContextModel.create({
      actorKind: "user",
      actorId,
    });
    const task = await A2ATaskModel.createForRun({
      contextId: a2aContext.id,
      agentId: subagentA.id,
    });

    const launchedSpecs: Array<{
      agentId: string;
      tier: string;
      secretEnv: Record<string, string>;
      replacePriorAttempt: boolean;
      workspaceAgentId: string | undefined;
      workspaceState: string | undefined;
    }> = [];
    const postCompletionReplacementChecks: Array<{
      priorRunPresentBeforeCreate: boolean;
      reapedDuringGap: number;
      workspaceAfterRunCreateTransaction: null | object;
    }> = [];
    let attemptCount = 0;

    const origCreateRun = AgentRunModel.create.bind(AgentRunModel);
    vi.spyOn(AgentRunModel, "create").mockImplementation(async (run) => {
      if (run.replacePriorAttempt) {
        const priorRun = await AgentRunModel.findByTaskId(task.id);
        const reapedDuringGap = await A2ATaskModel.reapStaleRunning({
          staleMs: -60_000,
          statusReason: "Orphaned",
          buildEventPayload: () => ({}),
        });
        const created = await origCreateRun(run);
        const workspaceAfterRunCreateTransaction =
          await AgentWorkspaceModel.findById(task.id);
        postCompletionReplacementChecks.push({
          priorRunPresentBeforeCreate: Boolean(priorRun?.endedAt),
          reapedDuringGap,
          workspaceAfterRunCreateTransaction,
        });
        return created;
      }
      return origCreateRun(run);
    });

    vi.spyOn(backend, "launch").mockImplementation(
      async (spec: AgentRunLaunchSpec) => {
        attemptCount += 1;
        const workspace = await AgentWorkspaceModel.findById(task.id);
        const tiers = JSON.parse(
          spec.env.ARCHESTRA_AGENT_RUNTIME_TIERS,
        ) as Array<{
          name: string;
          current?: boolean;
        }>;
        const currentTier = tiers.find((t) => t.current)?.name ?? "unknown";
        launchedSpecs.push({
          agentId: spec.agentRuntimeId,
          tier: currentTier,
          secretEnv: spec.secretEnv,
          replacePriorAttempt: Boolean(spec.replacePriorAttempt),
          workspaceAgentId: workspace?.agentId,
          workspaceState: workspace?.state,
        });
      },
    );
    vi.spyOn(backend, "waitUntilRunning").mockResolvedValue();
    vi.spyOn(backend, "streamOutput").mockImplementation(
      async ({ destination }) => {
        destination.end();
      },
    );
    vi.spyOn(backend, "snapshotOutput").mockImplementation(
      async ({ destination }) => {
        destination.end(
          attemptCount === 4
            ? "===ARCHESTRA-FINAL-ANSWER===\nReview completed on Subagent B"
            : "Killed",
        );
      },
    );
    vi.spyOn(backend, "waitForCompletion").mockImplementation(async () => {
      if (attemptCount === 1) {
        return {
          outcome: "failed",
          reason: "The pod ran out of memory (OOMKilled).",
          failure: agentRunFailure("pod.oom_killed"),
        };
      }
      if (attemptCount === 2) {
        return {
          outcome: "failed",
          reason: "The pod was evicted.",
          failure: agentRunFailure("pod.evicted"),
        };
      }
      if (attemptCount === 3) {
        return {
          outcome: "failed",
          reason: "Process exited with code 1",
          failure: agentRunFailure("turn.exit_status"),
        };
      }
      return {
        outcome: "succeeded",
      };
    });
    vi.spyOn(backend, "teardown").mockResolvedValue();
    vi.spyOn(backend, "releaseRun").mockResolvedValue();
    vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);

    const runtimeA = resolveAgentRuntime(subagentA);
    if (!runtimeA) throw new Error("Expected subagentA runtime");
    const result = await runTaskInAgentRuntime({
      runtime: runtimeA,
      taskId: task.id,
      agentId: subagentA.id,
      actor: { kind: "user", id: actorId, organizationId },
      organizationId,
      runMode: "one_shot",
      task: "Review PR #42",
      modelId,
      llmApiKeyId,
      ephemeralCredentials: { GH_TOKEN: "ghs_ephemeral_token_A" },
      subagentExecutionPolicy: {
        retries: 1,
        fallbackAgentIds: [subagentB.id],
        ephemeralCredentialsByAgentId: {
          [subagentA.id]: { GH_TOKEN: "ghs_ephemeral_token_A" },
          [subagentB.id]: { GH_TOKEN: "ghs_ephemeral_token_B" },
        },
      },
    });

    expect(result.text).toBe("Review completed on Subagent B");
    expect(launchedSpecs).toHaveLength(4);
    // Attempt 1: Subagent A on default tier S -> OOM killed in waitForCompletion
    expect(launchedSpecs[0]?.agentId).toBe(subagentA.id);
    expect(launchedSpecs[0]?.tier).toBe("S");
    expect(launchedSpecs[0]?.secretEnv.GH_TOKEN).toBe("ghs_ephemeral_token_A");
    expect(launchedSpecs[0]?.replacePriorAttempt).toBe(false);
    expect(launchedSpecs[0]?.workspaceAgentId).toBe(subagentA.id);
    expect(launchedSpecs[0]?.workspaceState).toBe("active");
    // Attempt 2: Subagent A escalated to tier M after OOM -> evicted in waitForCompletion
    expect(launchedSpecs[1]?.agentId).toBe(subagentA.id);
    expect(launchedSpecs[1]?.tier).toBe("M");
    expect(launchedSpecs[1]?.secretEnv.GH_TOKEN).toBe("ghs_ephemeral_token_A");
    expect(launchedSpecs[1]?.replacePriorAttempt).toBe(true);
    expect(launchedSpecs[1]?.workspaceAgentId).toBe(subagentA.id);
    expect(launchedSpecs[1]?.workspaceState).toBe("active");
    // Attempt 3: Subagent A retry 1/1 on tier M -> failed in waitForCompletion
    expect(launchedSpecs[2]?.agentId).toBe(subagentA.id);
    expect(launchedSpecs[2]?.tier).toBe("M");
    expect(launchedSpecs[2]?.secretEnv.GH_TOKEN).toBe("ghs_ephemeral_token_A");
    expect(launchedSpecs[2]?.replacePriorAttempt).toBe(true);
    expect(launchedSpecs[2]?.workspaceAgentId).toBe(subagentA.id);
    expect(launchedSpecs[2]?.workspaceState).toBe("active");
    // Attempt 4: Failover to Subagent B with its ephemeral credential
    expect(launchedSpecs[3]?.agentId).toBe(subagentB.id);
    expect(launchedSpecs[3]?.tier).toBe("S");
    expect(launchedSpecs[3]?.secretEnv.GH_TOKEN).toBe("ghs_ephemeral_token_B");
    expect(launchedSpecs[3]?.replacePriorAttempt).toBe(true);
    expect(launchedSpecs[3]?.workspaceAgentId).toBe(subagentB.id);
    expect(launchedSpecs[3]?.workspaceState).toBe("active");

    expect(postCompletionReplacementChecks).toEqual([
      {
        priorRunPresentBeforeCreate: true,
        reapedDuringGap: 0,
        workspaceAfterRunCreateTransaction: null,
      },
      {
        priorRunPresentBeforeCreate: true,
        reapedDuringGap: 0,
        workspaceAfterRunCreateTransaction: null,
      },
      {
        priorRunPresentBeforeCreate: true,
        reapedDuringGap: 0,
        workspaceAfterRunCreateTransaction: null,
      },
    ]);

    // Task, final AgentRun record, and workspace row now reflect the winning fallback subagent (Subagent B)
    const updatedTask = await A2ATaskModel.findById(task.id);
    expect(updatedTask?.agentId).toBe(subagentB.id);
    const finalRun = await AgentRunModel.findByTaskId(task.id);
    expect(finalRun?.agentId).toBe(subagentB.id);
    expect(finalRun?.endedAt).not.toBeNull();
    const finalWorkspace = await AgentWorkspaceModel.findById(task.id);
    expect(finalWorkspace?.agentId).toBe(subagentB.id);
    expect(finalWorkspace?.state).toBe("idle");
  });

  test("fails over cleanly when backend.launch rejects on the first subagent after OOM escalation and retry while keeping the task working and protected from orphan reaping", async ({
    makeAgent,
  }) => {
    await OrganizationModel.patch(organizationId, {
      agentRuntimeTiers: {
        tiers: [
          { name: "S", cpuRequest: 2, cpuLimit: null, warmSpares: 0 },
          { name: "M", cpuRequest: 4, cpuLimit: null, warmSpares: 0 },
        ],
        defaultTier: "S",
      },
    });

    const subagentA = await createRuntimeSubagent(makeAgent, "Subagent A");
    const subagentB = await createRuntimeSubagent(makeAgent, "Subagent B");

    const a2aContext = await A2AContextModel.create({
      actorKind: "user",
      actorId,
    });
    const task = await A2ATaskModel.createForRun({
      contextId: a2aContext.id,
      agentId: subagentA.id,
    });

    const launchedAttempts: Array<{
      agentId: string;
      tier: string;
      taskStateBeforeLaunch: string | undefined;
    }> = [];
    let launchAttempt = 0;

    vi.spyOn(backend, "launch").mockImplementation(
      async (spec: AgentRunLaunchSpec) => {
        launchAttempt += 1;
        const currentTask = await A2ATaskModel.findById(task.id);
        const tiers = JSON.parse(
          spec.env.ARCHESTRA_AGENT_RUNTIME_TIERS,
        ) as Array<{
          name: string;
          current?: boolean;
        }>;
        const currentTier = tiers.find((t) => t.current)?.name ?? "unknown";
        launchedAttempts.push({
          agentId: spec.agentRuntimeId,
          tier: currentTier,
          taskStateBeforeLaunch: currentTask?.state,
        });
        if (launchAttempt === 1) {
          throw tagAgentRunFailure(
            new Error("OOM during launch on Subagent A tier S"),
            "pod.oom_killed",
          );
        }
        if (launchAttempt === 2) {
          throw tagAgentRunFailure(
            new Error("Pod startup timed out on Subagent A tier M"),
            "launch.capacity_timeout",
          );
        }
        if (launchAttempt === 3) {
          throw new Error("Kubernetes pod publish failed on Subagent A");
        }
      },
    );
    vi.spyOn(backend, "waitUntilRunning").mockResolvedValue();
    vi.spyOn(backend, "streamOutput").mockImplementation(
      async ({ destination }) => {
        destination.end();
      },
    );
    vi.spyOn(backend, "snapshotOutput").mockImplementation(
      async ({ destination }) => {
        destination.end(
          "===ARCHESTRA-FINAL-ANSWER===\nFallback succeeded after launch failure",
        );
      },
    );
    vi.spyOn(backend, "waitForCompletion").mockResolvedValue({
      outcome: "succeeded",
    });
    const observedDuringTeardownGap: Array<{
      hasRunRow: boolean;
      workspaceState: string | undefined;
      reapedCount: number;
    }> = [];
    const origClose = AgentRunModel.close.bind(AgentRunModel);
    vi.spyOn(AgentRunModel, "close").mockImplementation(async (params) => {
      const closed = await origClose(params);
      if (launchAttempt < 4) {
        // Simulate a stale heartbeat between attempts and verify reapStaleRunning
        // spares the task because the closed agent_runs row remains in place
        // until the next attempt's AgentRunModel.create replaces it atomically.
        const runRow = await AgentRunModel.findByTaskId(task.id);
        const wsRow = await AgentWorkspaceModel.findById(task.id);
        const reapedCount = await A2ATaskModel.reapStaleRunning({
          staleMs: 0,
          statusReason: "Orphaned",
          buildEventPayload: () => ({}),
        });
        observedDuringTeardownGap.push({
          hasRunRow: Boolean(runRow),
          workspaceState: wsRow?.state,
          reapedCount,
        });
      }
      return closed;
    });
    vi.spyOn(backend, "teardown").mockResolvedValue();
    vi.spyOn(backend, "releaseRun").mockResolvedValue();
    vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);

    const runtimeA = resolveAgentRuntime(subagentA);
    if (!runtimeA) throw new Error("Expected subagentA runtime");
    const result = await runTaskInAgentRuntime({
      runtime: runtimeA,
      taskId: task.id,
      agentId: subagentA.id,
      actor: { kind: "user", id: actorId, organizationId },
      organizationId,
      runMode: "one_shot",
      task: "Review PR #43",
      modelId,
      llmApiKeyId,
      subagentExecutionPolicy: {
        retries: 1,
        fallbackAgentIds: [subagentB.id],
      },
    });

    expect(result.text).toBe("Fallback succeeded after launch failure");
    expect(launchedAttempts).toEqual([
      {
        agentId: subagentA.id,
        tier: "S",
        taskStateBeforeLaunch: "TASK_STATE_SUBMITTED",
      },
      {
        agentId: subagentA.id,
        tier: "M",
        taskStateBeforeLaunch: "TASK_STATE_SUBMITTED",
      },
      {
        agentId: subagentA.id,
        tier: "M",
        taskStateBeforeLaunch: "TASK_STATE_SUBMITTED",
      },
      {
        agentId: subagentB.id,
        tier: "S",
        taskStateBeforeLaunch: "TASK_STATE_SUBMITTED",
      },
    ]);
    expect(observedDuringTeardownGap).toHaveLength(3);
    for (const gap of observedDuringTeardownGap) {
      expect(gap.hasRunRow).toBe(true);
      expect(gap.workspaceState).toBe("deleted");
      expect(gap.reapedCount).toBe(0);
    }

    const updatedTask = await A2ATaskModel.findById(task.id);
    expect(updatedTask?.agentId).toBe(subagentB.id);
    const finalRun = await AgentRunModel.findByTaskId(task.id);
    expect(finalRun?.agentId).toBe(subagentB.id);
    expect(finalRun?.endedAt).not.toBeNull();
  });

  test("returns immediately on a permanent pre-launch refusal without walking to the next subagent", async ({
    makeAgent,
  }) => {
    await OrganizationModel.patch(organizationId, {
      agentRuntimeTiers: {
        tiers: [
          { name: "S", cpuRequest: 2, cpuLimit: null, warmSpares: 0 },
          { name: "M", cpuRequest: 4, cpuLimit: null, warmSpares: 0 },
          { name: "XL", cpuRequest: 8, cpuLimit: null, warmSpares: 0 },
        ],
        defaultTier: "S",
      },
    });

    const subagentA = await createRuntimeSubagent(makeAgent, "Subagent A");
    const subagentB = await makeAgent({
      name: "Subagent B (XL capable)",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: runtimeConfig({
        allowAgentSuppliedCredentialValues: true,
        maxTier: "XL",
      }),
    });
    const delegationToolB = await ToolModel.findOrCreateDelegationTool(
      subagentB.id,
    );
    await AgentToolModel.create(gateway.id, delegationToolB.id);

    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
        retries: 1,
        fallbackEnabled: true,
      },
    });

    const sendSpy = await mockDetachedTaskStart();

    const result = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        message: "Review with tier above Subagent A maxTier",
        limits: { tier: "XL" },
      },
      context,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("XL");
    expect(sendSpy).not.toHaveBeenCalled();
    expect(subagentA.id).toBeDefined();
  });

  test("persists round_robin rotation in PostgreSQL cache across any quantity of subagents and updates rotation on failover", async ({
    makeAgent,
  }) => {
    await Promise.all([
      createRuntimeSubagent(makeAgent, "Worker 1"),
      createRuntimeSubagent(makeAgent, "Worker 2"),
      createRuntimeSubagent(makeAgent, "Worker 3"),
      createRuntimeSubagent(makeAgent, "Worker 4"),
      createRuntimeSubagent(makeAgent, "Worker 5"),
    ]);
    const expectedOrder = await AgentModel.findAssignedRuntimeSubagentIds(
      gateway.id,
      gateway.environmentId,
    );
    expect(expectedOrder).toHaveLength(5);

    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
        retries: 0,
        fallbackEnabled: true,
      },
    });

    await mockDetachedTaskStart();

    const selectedIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await executeArchestraTool(
        TOOL_START_AGENT_RUN_FULL_NAME,
        { message: `Review #${i + 1}` },
        context,
      );
      expect(res.isError).toBeFalsy();
      const run = (res.structuredContent as { run: { agent_id: string } }).run;
      selectedIds.push(run.agent_id);
    }

    expect(selectedIds).toEqual([...expectedOrder, ...expectedOrder]);

    // Verify state is persisted in PostgreSQL keyv_cache
    const persisted = await subagentLoadBalancer.getState(gateway.id);
    expect(persisted?.dispatchCount).toBe(10);
    expect(persisted?.queue).toEqual(expectedOrder);

    // Simulate Worker 1 failing post-launch and failing over to Worker 2:
    // Worker 2 must be rotated to the back of the queue so the next request
    // picks Worker 3 rather than re-picking Worker 2.
    const nextRun = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "Review that fails over from Worker 1 to Worker 2" },
      context,
    );
    expect(
      (nextRun.structuredContent as { run: { agent_id: string } }).run.agent_id,
    ).toBe(expectedOrder[0]);

    await subagentLoadBalancer.recordCandidateClaimed({
      callerAgentId: gateway.id,
      claimedAgentId: expectedOrder[1] ?? "",
      assignedAgentIds: expectedOrder,
    });

    const afterFailover = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "Review after failover" },
      context,
    );
    expect(
      (afterFailover.structuredContent as { run: { agent_id: string } }).run
        .agent_id,
    ).toBe(expectedOrder[2]);
  });

  test("programmatically load-balances agent__* delegation tool calls and injects load-balancing system prompt when enabled on an orchestrator agent", async ({
    makeAgent,
  }) => {
    const orchestrator = await makeAgent({
      name: "Lobster Env",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      systemPrompt: "Which runtime should take this: Claude Code or Codex?",
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
        retries: 1,
        fallbackEnabled: true,
      },
    });

    const workerA = await makeAgent({
      name: "Lobster Claude Code",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: runtimeConfig({ maxTier: "M" }),
    });
    const workerB = await makeAgent({
      name: "Lobster Codex",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: runtimeConfig({ maxTier: "M" }),
    });
    const workerC = await makeAgent({
      name: "Lobster Grok",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: runtimeConfig({ maxTier: "M" }),
    });

    const toolA = await ToolModel.findOrCreateDelegationTool(workerA.id);
    const toolB = await ToolModel.findOrCreateDelegationTool(workerB.id);
    const toolC = await ToolModel.findOrCreateDelegationTool(workerC.id);
    await AgentToolModel.create(orchestrator.id, toolA.id);
    await AgentToolModel.create(orchestrator.id, toolB.id);
    await AgentToolModel.create(orchestrator.id, toolC.id);

    const assignedWorkerIds = await AgentModel.findAssignedRuntimeSubagentIds(
      orchestrator.id,
      orchestrator.environmentId,
    );
    const nameById = new Map([
      [workerA.id, workerA.name],
      [workerB.id, workerB.name],
      [workerC.id, workerC.name],
    ]);

    const prompt = await buildAgentSystemPrompt({
      agent: orchestrator,
      mcpTools: {},
      organizationId,
      userId: actorId,
      agentId: orchestrator.id,
    });
    expect(prompt).toContain(SUBAGENT_LOAD_BALANCING_INSTRUCTION);

    await mockDetachedTaskStart();
    const orchestratorContext: ArchestraContext = {
      agent: { id: orchestrator.id, name: orchestrator.name },
      agentId: orchestrator.id,
      userId: actorId,
      organizationId,
    };

    // Even if the orchestrator model invokes the same agent__* tool three times,
    // handleDelegation routes programmatically across all 3 assigned runtime workers.
    const delegationToolName = toolA.name;
    const r1 = await executeArchestraTool(
      delegationToolName,
      { message: "Task 1" },
      orchestratorContext,
    );
    const r2 = await executeArchestraTool(
      delegationToolName,
      { message: "Task 2" },
      orchestratorContext,
    );
    const r3 = await executeArchestraTool(
      delegationToolName,
      { message: "Task 3" },
      orchestratorContext,
    );

    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    expect(r3.isError).toBeFalsy();
    expect(r1.structuredContent).toMatchObject({
      run: {
        agent_id: assignedWorkerIds[0],
        agent_name: nameById.get(assignedWorkerIds[0] ?? ""),
      },
    });
    expect(r2.structuredContent).toMatchObject({
      run: {
        agent_id: assignedWorkerIds[1],
        agent_name: nameById.get(assignedWorkerIds[1] ?? ""),
      },
    });
    expect(r3.structuredContent).toMatchObject({
      run: {
        agent_id: assignedWorkerIds[2],
        agent_name: nameById.get(assignedWorkerIds[2] ?? ""),
      },
    });
  });

  test("rotates fallback tails across full rounds, claims fallbacks atomically, normalizes legacy ordered configs, and fails over past misconfigured primaries without pinning them", async ({
    makeAgent,
  }) => {
    const workerA = await createRuntimeSubagent(makeAgent, "Worker A");
    const workerB = await createRuntimeSubagent(makeAgent, "Worker B");
    const workerC = await createRuntimeSubagent(makeAgent, "Worker C");
    const assigned = await AgentModel.findAssignedRuntimeSubagentIds(
      gateway.id,
      gateway.environmentId,
    );
    expect(assigned).toHaveLength(3);
    const [a, b, c] = assigned as [string, string, string];

    // 1. Legacy "ordered" config normalizes to distributed round_robin and rotates
    //    both primaries and fallback tails across full rounds.
    const legacyConfig = {
      enabled: true,
      algorithm: "ordered",
      retries: 0,
      fallbackEnabled: true,
    } as unknown as NonNullable<Agent["subagentLoadBalancing"]>;

    const plannedRounds: string[][] = [];
    for (let i = 0; i < 6; i++) {
      const planned = await subagentLoadBalancer.planCandidates({
        callerAgentId: gateway.id,
        assignedAgentIds: assigned,
        config: legacyConfig,
      });
      plannedRounds.push(planned.candidateIds);
    }
    expect(plannedRounds).toEqual([
      [a, b, c],
      [b, c, a],
      [c, a, b],
      // Round 2 rotates the fallback tail so the first fallback alternates
      [a, c, b],
      [b, a, c],
      [c, b, a],
    ]);

    // 2. Concurrent/interleaved fallback claims on the same remaining candidate list
    //    atomically claim distinct workers instead of colliding on the first fallback.
    const [claim1, claim2] = await Promise.all([
      subagentLoadBalancer.claimNextFallbackCandidate({
        callerAgentId: gateway.id,
        remainingCandidateIds: [a, b],
        assignedAgentIds: assigned,
        plannedDispatchCount: -1,
      }),
      subagentLoadBalancer.claimNextFallbackCandidate({
        callerAgentId: gateway.id,
        remainingCandidateIds: [a, b],
        assignedAgentIds: assigned,
        plannedDispatchCount: -1,
      }),
    ]);
    expect(new Set([claim1.claimedAgentId, claim2.claimedAgentId])).toEqual(
      new Set([a, b]),
    );

    // 3. A primary with misconfigured admin credentials fails over to a healthy
    //    secondary when fallbackEnabled=true, and does not pin the broken primary
    //    when fallbackEnabled=false.
    await AgentModel.update(a, {
      runtime: runtimeConfig({
        credentials: [
          {
            key: "MISSING_ADMIN_SECRET",
            label: "Missing Admin Secret",
            scope: "shared",
            required: true,
          },
        ],
      }),
    });

    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
        retries: 0,
        fallbackEnabled: true,
      },
    });
    await mockDetachedTaskStart();

    // Ensure `a` is at the front of the queue by claiming `b` and `c` first
    await subagentLoadBalancer.recordCandidateClaimed({
      callerAgentId: gateway.id,
      claimedAgentId: b,
      assignedAgentIds: assigned,
    });
    await subagentLoadBalancer.recordCandidateClaimed({
      callerAgentId: gateway.id,
      claimedAgentId: c,
      assignedAgentIds: assigned,
    });

    // With fallbackEnabled=true, start_agent_run walks past misconfigured `a`
    // to the round-rotated first fallback (`c` on dispatchCount=11, round=3).
    const failoverResult = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "Should fail over past misconfigured primary a" },
      context,
    );
    expect(failoverResult.isError).toBeFalsy();
    expect(
      (failoverResult.structuredContent as { run: { agent_id: string } }).run
        .agent_id,
    ).toBe(c);

    // With fallbackEnabled=false, when `a` is at the front of the queue,
    // the call fails on `a`, but leaves `a` at the back of the queue so
    // the next call succeeds on a healthy worker rather than pinning `a`.
    await subagentLoadBalancer.recordCandidateClaimed({
      callerAgentId: gateway.id,
      claimedAgentId: b,
      assignedAgentIds: assigned,
    });
    await subagentLoadBalancer.recordCandidateClaimed({
      callerAgentId: gateway.id,
      claimedAgentId: c,
      assignedAgentIds: assigned,
    });
    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
        retries: 0,
        fallbackEnabled: false,
      },
    });

    const failedOnA = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "Hits misconfigured primary a with fallback disabled" },
      context,
    );
    expect(failedOnA.isError).toBe(true);

    const nextCallOnHealthy = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "Advances past misconfigured primary a to healthy b" },
      context,
    );
    expect(nextCallOnHealthy.isError).toBeFalsy();
    expect(
      (nextCallOnHealthy.structuredContent as { run: { agent_id: string } }).run
        .agent_id,
    ).toBe(b);
    expect([workerA.id, workerB.id, workerC.id]).toContain(b);
  });

  test("skips subagents whose personal subscription credentials the acting user lacks before claiming or creating a failed task", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeMember,
    makeSecret,
    makeUser,
  }) => {
    const otherUser = await makeUser();
    await makeMember(otherUser.id, organizationId, { role: "member" });

    // Other user's personal SuperGrok (x-premium) subscription key
    const grokSecret = await makeSecret({
      secret: { apiKey: "xai-subscription:other-user-supergrok" },
    });
    const otherUserGrokKey = await makeLlmProviderApiKey(
      organizationId,
      grokSecret.id,
      {
        provider: "xai",
        name: "SuperGrok",
        userId: otherUser.id,
      },
    );
    const grokModel = await ModelModel.create({
      externalId: "xai/grok-4.20-0309-reasoning",
      provider: "xai",
      modelId: "grok-4.20-0309-reasoning",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
      otherUserGrokKey.id,
      [grokModel.id],
    );

    // Org-wide Kimi Code key usable by any user
    const kimiSecret = await makeSecret({
      secret: { apiKey: "kimi-org-wide-key" },
    });
    const orgKimiKey = await makeLlmProviderApiKey(
      organizationId,
      kimiSecret.id,
      {
        provider: "kimi-code",
        name: "Kimi Code",
      },
    );
    const kimiModel = await ModelModel.create({
      externalId: "kimi-code/kimi-for-coding",
      provider: "kimi-code",
      modelId: "kimi-for-coding",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(orgKimiKey.id, [
      kimiModel.id,
    ]);

    // Acting user's personal GitHub Copilot key
    const copilotSecret = await makeSecret({
      secret: { apiKey: "ghu_acting_user_copilot" },
    });
    const actorCopilotKey = await makeLlmProviderApiKey(
      organizationId,
      copilotSecret.id,
      {
        provider: "github-copilot",
        name: "GitHub Copilot",
        userId: actorId,
      },
    );
    const copilotModel = await ModelModel.create({
      externalId: "github-copilot/gpt-5.4",
      provider: "github-copilot",
      modelId: "gpt-5.4",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
      actorCopilotKey.id,
      [copilotModel.id],
    );

    // 1. Subagent pinned to another user's personal SuperGrok subscription
    const grokSubagent = await makeAgent({
      organizationId,
      name: "Lobster Code Review Grok",
      agentType: "agent",
      modelId: grokModel.id,
      llmApiKeyId: otherUserGrokKey.id,
      runtime: runtimeConfig({
        command: ["archestra-grok"],
        inferenceProtocol: "openai_chat",
      }),
    });

    // 2. Subagent using archestra-claude-code personal subscription (acting user not connected)
    const claudeSubagent = await makeAgent({
      organizationId,
      name: "Lobster Code Review Claude Code",
      agentType: "agent",
      runtime: runtimeConfig({
        command: ["archestra-claude-code"],
        inferenceProtocol: "anthropic",
        claudeCode: { authentication: "subscription" },
      }),
    });

    // 3. Subagent using archestra-codex (acting user has no ChatGPT Subscription)
    const codexSubagent = await makeAgent({
      organizationId,
      name: "Lobster Code Review Codex",
      agentType: "agent",
      runtime: runtimeConfig({
        command: ["archestra-codex"],
        inferenceProtocol: "openai_responses",
      }),
    });

    // 4. Subagent using org-wide Kimi Code key (ready)
    const kimiSubagent = await makeAgent({
      organizationId,
      name: "Lobster Code Review Kimi",
      agentType: "agent",
      modelId: kimiModel.id,
      llmApiKeyId: orgKimiKey.id,
      runtime: runtimeConfig({
        command: ["archestra-kimi"],
        inferenceProtocol: "openai_chat",
      }),
    });

    // 5. Subagent using acting user's GitHub Copilot key (ready)
    const copilotSubagent = await makeAgent({
      organizationId,
      name: "Lobster Code Review Copilot",
      agentType: "agent",
      modelId: copilotModel.id,
      llmApiKeyId: null,
      runtime: runtimeConfig({
        command: ["archestra-copilot"],
        inferenceProtocol: "openai_chat",
      }),
    });

    for (const subagent of [
      grokSubagent,
      claudeSubagent,
      codexSubagent,
      kimiSubagent,
      copilotSubagent,
    ]) {
      const delegationTool = await ToolModel.findOrCreateDelegationTool(
        subagent.id,
      );
      await AgentToolModel.create(gateway.id, delegationTool.id);
    }

    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
        retries: 0,
        fallbackEnabled: true,
      },
    });
    const mockedStart = await mockDetachedTaskStart();

    const selectedAgentIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await executeArchestraTool(
        TOOL_START_AGENT_RUN_FULL_NAME,
        { message: `Review PR #${i + 1}` },
        context,
      );
      expect(result.isError).toBeFalsy();
      const agentId = (
        result.structuredContent as { run: { agent_id: string } }
      ).run.agent_id;
      selectedAgentIds.push(agentId);
    }

    // Only the two ready subagents (Kimi and Copilot) are ever claimed or launched,
    // alternating cleanly in round-robin order with zero failed task rows.
    expect(selectedAgentIds).toEqual([
      kimiSubagent.id,
      copilotSubagent.id,
      kimiSubagent.id,
      copilotSubagent.id,
    ]);
    expect(mockedStart).toHaveBeenCalledTimes(4);
  });
});
