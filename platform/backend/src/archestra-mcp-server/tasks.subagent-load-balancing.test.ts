import {
  TOOL_START_AGENT_RUN_FULL_NAME,
  TOOL_TRANSFER_CREDENTIAL_FULL_NAME,
} from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { A2AManager } from "@/agents/a2a/a2a-manager";
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
import { agentRunFailure } from "@/services/agent-runtime/run-failure";
import { restoreAgentVersion } from "@/services/agent-version-restore";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { Agent, AgentRuntime } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import { type ArchestraContext, executeArchestraTool } from ".";

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
        algorithm: "ordered",
        retries: 0,
        fallbackEnabled: true,
        maxFallbacks: null,
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

  test("intersects exclude_agent_ids with assigned subagents so foreign IDs do not exhaust maxFallbacks", async ({
    makeAgent,
  }) => {
    const subagentA = await createRuntimeSubagent(makeAgent, "Subagent A");
    const subagentB = await createRuntimeSubagent(makeAgent, "Subagent B");
    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "ordered",
        retries: 0,
        fallbackEnabled: true,
        maxFallbacks: 0,
      },
    });

    await mockDetachedTaskStart();

    // Passing a foreign agent_id in exclude_agent_ids must not count against maxFallbacks=0.
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

    // Passing an actually assigned subagent ID when maxFallbacks=0 is refused.
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
        algorithm: "ordered",
        retries: 1,
        fallbackEnabled: true,
        maxFallbacks: 1,
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

  test("snapshots and restores subagentLoadBalancing across agent versions", async () => {
    const initialPolicy = {
      enabled: true,
      algorithm: "weighted" as const,
      weights: { "00000000-0000-4000-8000-000000000001": 5 },
      retries: 2,
      fallbackEnabled: true,
      maxFallbacks: 1,
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
        maxFallbacks: null,
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
    }> = [];
    let attemptCount = 0;

    vi.spyOn(backend, "launch").mockImplementation(
      async (spec: AgentRunLaunchSpec) => {
        attemptCount += 1;
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
    // Attempt 1: Subagent A on default tier S -> OOM killed
    expect(launchedSpecs[0]?.agentId).toBe(subagentA.id);
    expect(launchedSpecs[0]?.tier).toBe("S");
    expect(launchedSpecs[0]?.secretEnv.GH_TOKEN).toBe("ghs_ephemeral_token_A");
    // Attempt 2: Subagent A escalated to tier M after OOM -> evicted (retriable)
    expect(launchedSpecs[1]?.agentId).toBe(subagentA.id);
    expect(launchedSpecs[1]?.tier).toBe("M");
    expect(launchedSpecs[1]?.secretEnv.GH_TOKEN).toBe("ghs_ephemeral_token_A");
    // Attempt 3: Subagent A retry 1/1 on tier M -> failed
    expect(launchedSpecs[2]?.agentId).toBe(subagentA.id);
    expect(launchedSpecs[2]?.tier).toBe("M");
    expect(launchedSpecs[2]?.secretEnv.GH_TOKEN).toBe("ghs_ephemeral_token_A");
    // Attempt 4: Failover to Subagent B with its ephemeral credential
    expect(launchedSpecs[3]?.agentId).toBe(subagentB.id);
    expect(launchedSpecs[3]?.tier).toBe("S");
    expect(launchedSpecs[3]?.secretEnv.GH_TOKEN).toBe("ghs_ephemeral_token_B");

    // Task and final AgentRun record now reflect the winning fallback subagent (Subagent B)
    const updatedTask = await A2ATaskModel.findById(task.id);
    expect(updatedTask?.agentId).toBe(subagentB.id);
    const finalRun = await AgentRunModel.findByTaskId(task.id);
    expect(finalRun?.agentId).toBe(subagentB.id);
    expect(finalRun?.endedAt).not.toBeNull();
  });

  test("fails over cleanly when backend.launch rejects on the first subagent after closing the run and workspace", async ({
    makeAgent,
  }) => {
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

    const launchedAgentIds: string[] = [];
    vi.spyOn(backend, "launch").mockImplementation(
      async (spec: AgentRunLaunchSpec) => {
        launchedAgentIds.push(spec.agentRuntimeId);
        if (spec.agentRuntimeId === subagentA.id) {
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
    expect(launchedAgentIds).toEqual([subagentA.id, subagentB.id]);

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
        algorithm: "ordered",
        retries: 1,
        fallbackEnabled: true,
        maxFallbacks: null,
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
});
