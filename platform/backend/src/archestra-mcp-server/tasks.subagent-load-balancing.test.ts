import {
  getArchestraToolFullName,
  isLoadBalancedRuntimeRouterTool,
  LOAD_BALANCED_RUNTIME_ROUTER_META_KEY,
  SELF_FORK_TOOL_NAME,
  SKILL_TOOL_PREFIX,
  SUBAGENT_LOAD_BALANCING_RETRIES,
  TOOL_GET_AGENT_RUN_FULL_NAME,
  TOOL_POST_AGENT_RUN_FILE_FULL_NAME,
  TOOL_POST_AGENT_RUN_MESSAGE_FULL_NAME,
  TOOL_READ_WORKSPACE_FILE_SHORT_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
  TOOL_START_AGENT_RUN_FULL_NAME,
  TOOL_STEER_AGENT_RUN_FULL_NAME,
  TOOL_TRANSFER_CREDENTIAL_FULL_NAME,
  TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME,
  TOOL_WRITE_WORKSPACE_FILE_SHORT_NAME,
} from "@archestra/shared";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { context as otelContext, trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Tool as AiTool } from "ai";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { A2AManager } from "@/agents/a2a/a2a-manager";
import * as a2aExecutor from "@/agents/a2a-executor";
import {
  buildAgentSystemPrompt,
  SUBAGENT_LOAD_BALANCING_INSTRUCTION,
} from "@/agents/agent-system-prompt";
import { serviceAccountUserId } from "@/auth/service-account-user-id";
import { CacheKey, cacheManager } from "@/cache-manager";
import * as chatMcpClient from "@/clients/chat-mcp-client";
import {
  buildAgentDelegationTool,
  buildMcpGatewayTool,
  type ChatToolContext,
} from "@/clients/chat-tool-builder";
import { ToolCallRepeatTracker } from "@/clients/tool-call-repeat-tracker";
import config from "@/config";
import db, { schema } from "@/database";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentExcludedSubagentModel,
  AgentExcludedToolModel,
  AgentModel,
  AgentRunModel,
  AgentToolModel,
  AgentVersionModel,
  AgentWorkspaceModel,
  LlmProviderApiKeyModelLinkModel,
  McpToolCallModel,
  ModelModel,
  OrganizationModel,
  SkillModel,
  ToolModel,
} from "@/models";
import ClaudeCodeAccountModel from "@/models/claude-code-account";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import OpenAppaSessionModel from "@/models/openappa-session";
import { startActiveChatSpan } from "@/observability/tracing";
import { openappaActor } from "@/openappa/actor";
import { signRuntimeToolProof } from "@/openappa/runtime-tool-claims";
import * as openappaService from "@/openappa/service";
import { buildAgentMcpToolList } from "@/routes/mcp-gateway/utils";
import { secretManager } from "@/secrets-manager";
import type { AgentRunLaunchSpec } from "@/services/agent-runtime/backends";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import { claudeCodeAccountManager } from "@/services/agent-runtime/claude-code-account";
import {
  resolveAgentRuntime,
  runTaskInAgentRuntime,
} from "@/services/agent-runtime/pod-run";
import { bindRunProviderKey } from "@/services/agent-runtime/preflight";
import {
  agentRunFailure,
  tagAgentRunFailure,
} from "@/services/agent-runtime/run-failure";
import {
  createRuntimeCredentialDefinition,
  setRuntimeCredentialConnection,
} from "@/services/agent-runtime/runtime-credentials";
import { subagentLoadBalancer } from "@/services/agent-runtime/subagent-load-balancer";
import { restoreAgentVersion } from "@/services/agent-version-restore";
import { modelSyncService } from "@/services/model-sync";
import { ResourcePermissions } from "@/services/resource-permissions";
import { getSessionHandoffs } from "@/services/session-handoffs";
import {
  accessGrants,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import { type Agent, type AgentRuntime, SelectAgentSchema } from "@/types";
import { AgentConfigSnapshotSchema } from "@/types/agent-version";
import { drainBackgroundWork } from "@/utils/background-work";
import {
  type ArchestraContext,
  archestraMcpBranding,
  executeArchestraTool,
} from ".";
import { getAgentTools, getListedAgentTools } from "./delegation";

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

const originalOpenappaEnabled = config.openappa.enabled;
const originalOfferSigningSecret = config.openappa.offerSigningSecret;

afterEach(async () => {
  await drainBackgroundWork();
  config.openappa.enabled = originalOpenappaEnabled;
  config.openappa.offerSigningSecret = originalOfferSigningSecret;
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

  test("coerces legacy All-agents weighted policies to round_robin during planning and on unrelated updates", async ({
    makeAgent,
  }) => {
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
    const legacyPolicy = {
      enabled: true,
      algorithm: "weighted" as const,
      weights: {
        [subagentA.id]: 100,
        [subagentB.id]: 1,
      },
    };
    // Seed a legacy row directly in Postgres to bypass model normalization.
    await db
      .update(schema.agentsTable)
      .set({
        accessAllSubagents: true,
        subagentLoadBalancing: legacyPolicy,
      })
      .where(eq(schema.agentsTable.id, gateway.id));

    await mockDetachedTaskStart();

    // Two consecutive runs alternate evenly (round_robin) instead of sending
    // both to the 100-weight subagent.
    const firstRun = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "First legacy weighted run" },
      context,
    );
    const secondRun = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "Second legacy weighted run" },
      context,
    );
    expect(firstRun.isError).toBeFalsy();
    expect(secondRun.isError).toBeFalsy();
    const firstAgentId = (
      firstRun.structuredContent as { run: { agent_id: string } }
    ).run.agent_id;
    const secondAgentId = (
      secondRun.structuredContent as { run: { agent_id: string } }
    ).run.agent_id;
    expect(new Set([firstAgentId, secondAgentId])).toEqual(
      new Set([subagentA.id, subagentB.id]),
    );

    // An unrelated update heals the stored policy to round_robin.
    const updated = await AgentModel.update(gateway.id, {
      description: "Unrelated metadata edit",
    });
    expect(updated?.subagentLoadBalancing).toEqual({
      enabled: true,
      algorithm: "round_robin",
      weights: legacyPolicy.weights,
    });
  });

  test("intersects exclude_agent_ids with assigned subagents so foreign IDs are ignored and assigned exclusions always fail over until none remain", async ({
    makeAgent,
  }) => {
    const subagentA = await createRuntimeSubagent(makeAgent, "Subagent A");
    const subagentB = await createRuntimeSubagent(makeAgent, "Subagent B");
    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
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

    // Failover is always enabled: excluding subagentA routes to subagentB.
    const withAssignedExclusion = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        message: "Review with assigned exclusion",
        exclude_agent_ids: [subagentA.id],
      },
      context,
    );
    expect(withAssignedExclusion.isError).toBeFalsy();
    expect(withAssignedExclusion.structuredContent).toMatchObject({
      run: {
        agent_id: subagentB.id,
      },
    });

    // Excluding every assigned subagent returns the exhausted fallback error.
    const withAllExcluded = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        message: "Review with all assigned subagents excluded",
        exclude_agent_ids: [subagentA.id, subagentB.id],
      },
      context,
    );
    expect(withAllExcluded.isError).toBe(true);
    expect((withAllExcluded.content[0] as { text: string }).text).toContain(
      "No remaining fallback subagents are available on this gateway.",
    );
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
            retries: SUBAGENT_LOAD_BALANCING_RETRIES,
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

    // Legacy stored rows or version snapshots carrying removed retry/failover fields strip them cleanly
    const parsedAgent = SelectAgentSchema.parse({
      ...restored,
      subagentLoadBalancing: {
        ...initialPolicy,
        retries: 5,
        fallbackEnabled: false,
      },
    });
    expect(parsedAgent.subagentLoadBalancing).toEqual(initialPolicy);

    const parsedSnapshot = AgentConfigSnapshotSchema.parse({
      ...v2?.snapshot,
      subagentLoadBalancing: {
        ...initialPolicy,
        retries: 5,
        fallbackEnabled: false,
      },
    });
    expect(parsedSnapshot.subagentLoadBalancing).toEqual(initialPolicy);
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
    const persisted = await subagentLoadBalancer.getState(gateway.id, {
      userId: actorId,
    });
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
      scopeKey: { userId: actorId },
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

    const sendSpy = await mockDetachedTaskStart();
    const orchestratorContext: ArchestraContext = {
      agent: { id: orchestrator.id, name: orchestrator.name },
      agentId: orchestrator.id,
      userId: actorId,
      organizationId,
    };

    // Even if the orchestrator model invokes the same agent__* tool three times,
    // handleDelegation routes programmatically across all 3 assigned runtime workers
    // with hard-coded retries (2) and failover across the remaining workers.
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
    expect(sendSpy.mock.calls[0]?.[0]).toMatchObject({
      agentId: assignedWorkerIds[0],
      systemParams: expect.objectContaining({
        subagentExecutionPolicy: expect.objectContaining({
          retries: SUBAGENT_LOAD_BALANCING_RETRIES,
          fallbackAgentIds: [assignedWorkerIds[1], assignedWorkerIds[2]],
        }),
      }),
    });
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
    } as unknown as NonNullable<Agent["subagentLoadBalancing"]>;

    const plannedRounds: string[][] = [];
    for (let i = 0; i < 6; i++) {
      const planned = await subagentLoadBalancer.planCandidates({
        callerAgentId: gateway.id,
        assignedAgentIds: assigned,
        config: legacyConfig,
        scopeKey: { userId: actorId },
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
        scopeKey: { userId: actorId },
      }),
      subagentLoadBalancer.claimNextFallbackCandidate({
        callerAgentId: gateway.id,
        remainingCandidateIds: [a, b],
        assignedAgentIds: assigned,
        plannedDispatchCount: -1,
        scopeKey: { userId: actorId },
      }),
    ]);
    expect(new Set([claim1.claimedAgentId, claim2.claimedAgentId])).toEqual(
      new Set([a, b]),
    );

    // 3. A primary with misconfigured admin credentials always fails over to a
    //    healthy secondary.
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
      },
    });
    await mockDetachedTaskStart();

    // Ensure `a` is at the front of the queue by claiming `b` and `c` first
    await subagentLoadBalancer.recordCandidateClaimed({
      callerAgentId: gateway.id,
      claimedAgentId: b,
      assignedAgentIds: assigned,
      scopeKey: { userId: actorId },
    });
    await subagentLoadBalancer.recordCandidateClaimed({
      callerAgentId: gateway.id,
      claimedAgentId: c,
      assignedAgentIds: assigned,
      scopeKey: { userId: actorId },
    });

    // start_agent_run walks past misconfigured `a` to the round-rotated first
    // fallback (`c` on dispatchCount=11, round=3).
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

    // Subsequent call continues rotating across healthy workers without pinning `a`.
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

  test("surfaces the model-readiness refusal message when start_agent_run targets an unready Codex subagent", async ({
    makeAgent,
  }) => {
    const codexSubagent = await makeAgent({
      organizationId,
      name: "Lobster Code Review Codex",
      agentType: "agent",
      runtime: runtimeConfig({
        command: ["archestra-codex"],
        inferenceProtocol: "openai_responses",
      }),
    });
    const delegationTool = await ToolModel.findOrCreateDelegationTool(
      codexSubagent.id,
    );
    await AgentToolModel.create(gateway.id, delegationTool.id);

    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    const mockedStart = await mockDetachedTaskStart();

    const result = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { agent_id: codexSubagent.id, message: "Review PR #99" },
      context,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "Connect your own ChatGPT Subscription",
    );
    expect(mockedStart).not.toHaveBeenCalled();
  });

  test("skips unready fallback subagents during in-place runtime failover and updates the active chat span to the winning fallback", async ({
    makeAgent,
  }) => {
    await OrganizationModel.patch(organizationId, {
      agentRuntimeTiers: {
        tiers: [{ name: "S", cpuRequest: 2, cpuLimit: null, warmSpares: 0 }],
        defaultTier: "S",
      },
    });

    const subagentA = await createRuntimeSubagent(makeAgent, "Subagent A");
    const unreadyCodexFallback = await makeAgent({
      organizationId,
      name: "Unready Codex Fallback",
      agentType: "agent",
      runtime: runtimeConfig({
        command: ["archestra-codex"],
        inferenceProtocol: "openai_responses",
      }),
    });
    const subagentC = await createRuntimeSubagent(makeAgent, "Subagent C");

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
          "===ARCHESTRA-FINAL-ANSWER===\nReview completed on Subagent C",
        );
      },
    );
    vi.spyOn(backend, "waitForCompletion").mockResolvedValue({
      outcome: "succeeded",
    });
    vi.spyOn(backend, "teardown").mockResolvedValue();
    vi.spyOn(backend, "releaseRun").mockResolvedValue();
    vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);

    const exporter = new InMemorySpanExporter();
    const originalProvider = trace.getTracerProvider();
    trace.disable();
    const sdk = new NodeSDK({
      autoDetectResources: false,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      logRecordProcessors: [],
    });
    sdk.start();

    try {
      const runtimeA = resolveAgentRuntime(subagentA);
      if (!runtimeA) throw new Error("Expected subagentA runtime");
      const result = await startActiveChatSpan({
        agentId: subagentA.id,
        agentName: subagentA.name,
        agentType: subagentA.agentType ?? undefined,
        sessionId: a2aContext.id,
        callback: () =>
          runTaskInAgentRuntime({
            runtime: runtimeA,
            taskId: task.id,
            agentId: subagentA.id,
            actor: { kind: "user", id: actorId, organizationId },
            organizationId,
            runMode: "one_shot",
            task: "Review PR #44",
            modelId,
            llmApiKeyId,
            subagentExecutionPolicy: {
              retries: 0,
              fallbackAgentIds: [unreadyCodexFallback.id, subagentC.id],
            },
          }),
      });

      expect(result.text).toBe("Review completed on Subagent C");
      expect(launchedAgentIds).toEqual([subagentA.id, subagentC.id]);

      const updatedTask = await A2ATaskModel.findById(task.id);
      expect(updatedTask?.agentId).toBe(subagentC.id);

      const chatSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name === "chat Subagent C");
      expect(chatSpan).toBeDefined();
      expect(chatSpan?.attributes).toMatchObject({
        "gen_ai.agent.id": subagentC.id,
        "gen_ai.agent.name": "Subagent C",
        "archestra.subagent.initial_agent_id": subagentA.id,
        "archestra.subagent.initial_agent_name": "Subagent A",
        "archestra.subagent.failover_count": 1,
      });
    } finally {
      await sdk.shutdown();
      trace.disable();
      otelContext.disable();
      trace.setGlobalTracerProvider(originalProvider);
    }
  });

  test("isolates round_robin, weighted round-robin, and random queues/seeds per user/team/org and fixes failover queue inversion", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    await createRuntimeSubagent(makeAgent, "Worker A");
    await createRuntimeSubagent(makeAgent, "Worker B");
    await createRuntimeSubagent(makeAgent, "Worker C");
    await createRuntimeSubagent(makeAgent, "Worker D");
    const assigned = await AgentModel.findAssignedRuntimeSubagentIds(
      gateway.id,
      gateway.environmentId,
    );
    expect(assigned).toHaveLength(4);
    const [a, b, c, d] = assigned as [string, string, string, string];

    const userAlice = await makeUser();
    const userBob = await makeUser();
    await makeMember(userAlice.id, organizationId, { role: "admin" });
    await makeMember(userBob.id, organizationId, { role: "admin" });

    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    await mockDetachedTaskStart();

    const aliceContext: ArchestraContext = {
      ...context,
      userId: userAlice.id,
      tokenAuth: {
        tokenId: "tok-alice",
        teamId: "team-engineering",
        isOrganizationToken: false,
        userId: userAlice.id,
        organizationId,
      },
    };
    const bobContext: ArchestraContext = {
      ...context,
      userId: userBob.id,
    };

    // 1. Per-user round_robin isolation: even when Bob excludes [a, b, c] so Bob
    //    only ever runs on [d], Alice's round-robin queue across [a, b, c, d]
    //    rotates in exact 1:1:1:1 order without any skew or starvation from Bob.
    const aliceSelected: string[] = [];
    const bobSelected: string[] = [];
    for (let i = 0; i < 4; i++) {
      const aliceRun = await executeArchestraTool(
        TOOL_START_AGENT_RUN_FULL_NAME,
        { message: `Alice PR #${i + 1}` },
        aliceContext,
      );
      expect(aliceRun.isError).toBeFalsy();
      aliceSelected.push(
        (aliceRun.structuredContent as { run: { agent_id: string } }).run
          .agent_id,
      );

      const bobRun = await executeArchestraTool(
        TOOL_START_AGENT_RUN_FULL_NAME,
        {
          message: `Bob PR #${i + 1}`,
          exclude_agent_ids: [a, b, c],
        },
        bobContext,
      );
      expect(bobRun.isError).toBeFalsy();
      bobSelected.push(
        (bobRun.structuredContent as { run: { agent_id: string } }).run
          .agent_id,
      );
    }

    expect(aliceSelected).toEqual([a, b, c, d]);
    expect(bobSelected).toEqual([d, d, d, d]);

    const aliceState = await subagentLoadBalancer.getState(gateway.id, {
      userId: userAlice.id,
      teamId: "team-engineering",
      organizationId,
    });
    const bobState = await subagentLoadBalancer.getState(gateway.id, {
      userId: userBob.id,
      organizationId,
    });
    expect(aliceState?.dispatchCount).toBe(4);
    expect(bobState?.dispatchCount).toBe(4);

    // Verify new round_robin scopes phase-shift their initial queue so distinct
    // principals do not all hit `a` on their first run (Charlie -> `c`, Dave -> `d`).
    const charliePlan = await subagentLoadBalancer.planCandidates({
      callerAgentId: gateway.id,
      assignedAgentIds: assigned,
      config: {
        enabled: true,
        algorithm: "round_robin",
      },
      scopeKey: { userId: "charlie-first-run", organizationId },
    });
    const davePlan = await subagentLoadBalancer.planCandidates({
      callerAgentId: gateway.id,
      assignedAgentIds: assigned,
      config: {
        enabled: true,
        algorithm: "round_robin",
      },
      scopeKey: { userId: "dave-first-run", organizationId },
    });
    expect(charliePlan.claimedPrimaryAgentId).toBe(c);
    expect(davePlan.claimedPrimaryAgentId).toBe(d);

    // 2. Per-scope weighted round-robin (Smooth Weighted Round-Robin) across
    //    user, team, and org scopes, with phase-shifted initial SWRR state and
    //    unlaunched claim rollback.
    const weightedConfig = {
      enabled: true,
      algorithm: "weighted" as const,
      weights: { [a]: 3, [b]: 2, [c]: 1 },
    };
    const teamScope = { teamId: "team-platform", organizationId };
    const orgScope = { organizationId };
    const threePool = [a, b, c];

    const teamPrimaries: string[] = [];
    const orgPrimaries: string[] = [];
    for (let i = 0; i < 6; i++) {
      const teamPlan = await subagentLoadBalancer.planCandidates({
        callerAgentId: gateway.id,
        assignedAgentIds: threePool,
        config: weightedConfig,
        scopeKey: teamScope,
      });
      teamPrimaries.push(teamPlan.claimedPrimaryAgentId ?? "");

      if (i % 2 === 0) {
        const orgPlan = await subagentLoadBalancer.planCandidates({
          callerAgentId: gateway.id,
          assignedAgentIds: threePool,
          config: weightedConfig,
          scopeKey: orgScope,
        });
        orgPrimaries.push(orgPlan.claimedPrimaryAgentId ?? "");
      }
    }

    // Team scope (scopeOffset=0) gets exact 3:2:1 smoothly interleaved distribution: [a, b, c, a, b, a]
    expect(teamPrimaries).toEqual([a, b, c, a, b, a]);
    // Org scope (scopeOffset=1) is phase-shifted by 1 SWRR step so its first 3 runs are [b, c, a]
    expect(orgPrimaries).toEqual([b, c, a]);

    // Verify releaseUnlaunchedClaim subtracts the refused claim's own SWRR delta:
    // - Sequential rollback: re-selects `b` (step 4 of [b, c, a, b, a, a]) instead of advancing to `a`.
    const orgUnlaunchedPlan = await subagentLoadBalancer.planCandidates({
      callerAgentId: gateway.id,
      assignedAgentIds: threePool,
      config: weightedConfig,
      scopeKey: orgScope,
    });
    expect(orgUnlaunchedPlan.dispatchCount).toBe(4);
    expect(orgUnlaunchedPlan.claimedPrimaryAgentId).toBe(b);
    await subagentLoadBalancer.releaseUnlaunchedClaim({
      callerAgentId: gateway.id,
      claimedAgentId: orgUnlaunchedPlan.claimedPrimaryAgentId,
      scopeKey: orgScope,
    });
    const orgRetryPlan = await subagentLoadBalancer.planCandidates({
      callerAgentId: gateway.id,
      assignedAgentIds: threePool,
      config: weightedConfig,
      scopeKey: orgScope,
    });
    expect(orgRetryPlan.dispatchCount).toBe(4);
    expect(orgRetryPlan.claimedPrimaryAgentId).toBe(b);

    // - Concurrent rollback in the same scope: Plan 1 claims `a` and Plan 2 claims `b`
    //   before Plan 1 is refused and calls releaseUnlaunchedClaim(a). Releasing `a`
    //   subtracts `a`'s delta while preserving `b`'s launched step, so Plan 3 claims `a`
    //   (not `b` again).
    const concurrentPlan1 = await subagentLoadBalancer.planCandidates({
      callerAgentId: gateway.id,
      assignedAgentIds: threePool,
      config: weightedConfig,
      scopeKey: teamScope,
    });
    const concurrentPlan2 = await subagentLoadBalancer.planCandidates({
      callerAgentId: gateway.id,
      assignedAgentIds: threePool,
      config: weightedConfig,
      scopeKey: teamScope,
    });
    expect(concurrentPlan1.claimedPrimaryAgentId).toBe(a);
    expect(concurrentPlan2.claimedPrimaryAgentId).toBe(b);
    await subagentLoadBalancer.releaseUnlaunchedClaim({
      callerAgentId: gateway.id,
      claimedAgentId: concurrentPlan1.claimedPrimaryAgentId,
      scopeKey: teamScope,
    });
    const postReleasePlan = await subagentLoadBalancer.planCandidates({
      callerAgentId: gateway.id,
      assignedAgentIds: threePool,
      config: weightedConfig,
      scopeKey: teamScope,
    });
    expect(postReleasePlan.claimedPrimaryAgentId).toBe(a);

    // 3. Per-scope random queues/seeds in keyv_cache produce deterministic,
    //    distinct per-scope candidate sequences.
    const randomConfig = {
      enabled: true,
      algorithm: "random" as const,
    };
    const fixedRandomCallerId = "00000000-0000-0000-0000-000000000042";
    const randomUser1Primaries: string[] = [];
    const randomUser1Orders: string[][] = [];
    const randomUser2Orders: string[][] = [];
    for (let i = 0; i < 4; i++) {
      const planned1 = await subagentLoadBalancer.planCandidates({
        callerAgentId: fixedRandomCallerId,
        assignedAgentIds: assigned,
        config: randomConfig,
        scopeKey: { userId: "random-user-1" },
      });
      const planned2 = await subagentLoadBalancer.planCandidates({
        callerAgentId: fixedRandomCallerId,
        assignedAgentIds: assigned,
        config: randomConfig,
        scopeKey: { userId: "random-user-2" },
      });
      expect([...planned1.candidateIds].sort()).toEqual([...assigned].sort());
      expect([...planned2.candidateIds].sort()).toEqual([...assigned].sort());
      randomUser1Primaries.push(planned1.claimedPrimaryAgentId ?? "");
      randomUser1Orders.push(planned1.candidateIds);
      randomUser2Orders.push(planned2.candidateIds);
    }
    const randomUser1State = await subagentLoadBalancer.getState(
      fixedRandomCallerId,
      {
        userId: "random-user-1",
      },
    );
    expect(randomUser1State?.dispatchCount).toBe(4);
    expect(randomUser1Primaries).toEqual([c, b, d, a]);
    expect(randomUser1Orders).not.toEqual(randomUser2Orders);
    expect(
      new Set(randomUser1Orders.map((o) => o.join(","))).size,
    ).toBeGreaterThan(1);

    // 4. Failover queue inversion fix: when primary `a` fails and fails over to `b`,
    //    `b` is placed BEFORE `a` at the back of the queue (`[c, d, b, a]`) so all
    //    healthy workers (`c`, `d`, `b`) get their normal primary turn before `a`
    //    is probed again, and on `a`'s next failure `c` (not `b`) absorbs the failover.
    const failoverScope = "user:failover-inversion-check";
    const rrConfig = {
      enabled: true,
      algorithm: "round_robin" as const,
    };
    const plan1 = await subagentLoadBalancer.planCandidates({
      callerAgentId: gateway.id,
      assignedAgentIds: assigned,
      config: rrConfig,
      scopeKey: failoverScope,
    });
    expect(plan1.claimedPrimaryAgentId).toBe(a);

    // Simulate `a` failing and claiming fallback `b`
    const claim1 = await subagentLoadBalancer.claimNextFallbackCandidate({
      callerAgentId: gateway.id,
      scopeKey: failoverScope,
      remainingCandidateIds: [b, c, d],
      assignedAgentIds: assigned,
      plannedDispatchCount: plan1.dispatchCount,
      failedAgentId: a,
    });
    expect(claim1.claimedAgentId).toBe(b);

    const stateAfterFailover = await subagentLoadBalancer.getState(
      gateway.id,
      failoverScope,
    );
    expect(stateAfterFailover?.queue).toEqual([c, d, b, a]);

    // Next 3 primary dispatches must be c, d, b (in exact order) before failed `a` is reached again
    const nextThreePrimaries: string[] = [];
    for (let i = 0; i < 3; i++) {
      const nextPlan = await subagentLoadBalancer.planCandidates({
        callerAgentId: gateway.id,
        assignedAgentIds: assigned,
        config: rrConfig,
        scopeKey: failoverScope,
      });
      nextThreePrimaries.push(nextPlan.claimedPrimaryAgentId ?? "");
    }
    expect(nextThreePrimaries).toEqual([c, d, b]);

    // On the 5th dispatch, `a` is reached again and its queue-ordered fallback is `c` (not `b`)
    const plan5 = await subagentLoadBalancer.planCandidates({
      callerAgentId: gateway.id,
      assignedAgentIds: assigned,
      config: rrConfig,
      scopeKey: failoverScope,
    });
    expect(plan5.claimedPrimaryAgentId).toBe(a);
    const claim5 = await subagentLoadBalancer.claimNextFallbackCandidate({
      callerAgentId: gateway.id,
      scopeKey: failoverScope,
      remainingCandidateIds: [b, c, d],
      assignedAgentIds: assigned,
      plannedDispatchCount: -1,
      failedAgentId: a,
    });
    expect(claim5.claimedAgentId).toBe(c);
  });

  test("allows archestra-claude-code-runtime to use personal Claude subscriptions and enforces preflight model-link parity with lazy subscription sync", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    // 1. Subagent configured with command=["archestra-claude-code-runtime"] and
    //    claudeCode.authentication="subscription"
    const claudeRuntimeSubagent = await makeAgent({
      organizationId,
      name: "Lobster Code Review Claude Code Runtime",
      agentType: "agent",
      runtime: runtimeConfig({
        command: ["archestra-claude-code-runtime"],
        inferenceProtocol: "anthropic",
        claudeCode: { authentication: "subscription", model: "opus" },
      }),
    });

    // 2. Subagent configured with command=["archestra-codex"] selecting a model
    //    ("gpt-5.4") that is linked on the agent's configured key, but NOT linked to
    //    the acting user's personal ChatGPT Subscription even after lazy sync
    const unlinkedCodexModel = await ModelModel.create({
      externalId: "openai/gpt-5.4",
      provider: "openai",
      modelId: "gpt-5.4",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(llmApiKeyId, [
      unlinkedCodexModel.id,
    ]);
    const chatgptSecret = await makeSecret({
      secret: { apiKey: "chatgpt-oauth:user-token" },
    });
    const actorChatgptKey = await makeLlmProviderApiKey(
      organizationId,
      chatgptSecret.id,
      {
        provider: "openai",
        name: "ChatGPT Subscription",
        userId: actorId,
      },
    );
    const codexSubagent = await makeAgent({
      organizationId,
      name: "Lobster Code Review Codex Runtime",
      agentType: "agent",
      modelId: unlinkedCodexModel.id,
      llmApiKeyId,
      runtime: runtimeConfig({
        command: ["archestra-codex"],
        inferenceProtocol: "openai_responses",
      }),
    });

    // 3. Subagent configured with SuperGrok (x-premium) where the agent's configured
    //    admin key knows the model, and the acting user's personal SuperGrok subscription
    //    initially has 0 linked models and is lazily synced during preflight
    const grokModel = await ModelModel.create({
      externalId: "xai/grok-4.20-lazy-sync",
      provider: "xai",
      modelId: "grok-4.20-lazy-sync",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    const adminGrokSecret = await makeSecret({
      secret: { apiKey: "xai-subscription:admin-supergrok" },
    });
    const adminGrokKey = await makeLlmProviderApiKey(
      organizationId,
      adminGrokSecret.id,
      {
        provider: "xai",
        name: "SuperGrok",
        userId: null,
      },
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(adminGrokKey.id, [
      grokModel.id,
    ]);
    const grokSecret = await makeSecret({
      secret: { apiKey: "xai-subscription:actor-supergrok" },
    });
    const actorGrokKey = await makeLlmProviderApiKey(
      organizationId,
      grokSecret.id,
      {
        provider: "xai",
        name: "SuperGrok",
        userId: actorId,
      },
    );
    const grokSubagent = await makeAgent({
      organizationId,
      name: "Lobster Code Review Grok",
      agentType: "agent",
      modelId: grokModel.id,
      llmApiKeyId: adminGrokKey.id,
      runtime: runtimeConfig({
        command: ["archestra-grok"],
        inferenceProtocol: "openai_chat",
      }),
    });

    // Connect the acting user's personal Claude account for claudeRuntimeSubagent
    const claudeSecret = await makeSecret({
      secret: {
        accessToken: "sk-ant-oat01-connected-token",
        refreshToken: "sk-ant-ort01-connected-refresh",
      },
    });
    const resolvedClaudeRuntime = resolveAgentRuntime(claudeRuntimeSubagent);
    if (!resolvedClaudeRuntime) {
      throw new Error("Expected resolved runtime on claudeRuntimeSubagent");
    }
    const flowId = crypto.randomUUID();
    const claudeOwner = {
      organizationId,
      userId: actorId,
      agentId: claudeRuntimeSubagent.id,
    };
    await ClaudeCodeAccountModel.startFlow({
      owner: claudeOwner,
      flow: {
        flowId,
      },
    });
    await ClaudeCodeAccountModel.complete({
      owner: claudeOwner,
      flowId,
      secretId: claudeSecret.id,
      metadata: {
        models: [],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    const claudeStatus = await claudeCodeAccountManager.status({
      runtime: resolvedClaudeRuntime,
      userId: actorId,
      inspectFlow: false,
    });
    expect(claudeStatus.state).toBe("connected");

    // Verify a transient secret-read failure does NOT cache `{ subscriptionKind: null }`
    // for 5 minutes: if `getSecret` throws once, the subsequent runs still read the secret
    // and enforce the subscription model-link check instead of bypassing it.
    const sm = secretManager();
    const originalGetSecret = sm.getSecret.bind(sm);
    // An agent pinned to the actor's own ChatGPT key, on a runtime with no
    // subscription of its own: resolving the key reads its secret once, then
    // the link check reads it again, and that second read is the one failing.
    const getSecretSpy = vi
      .spyOn(sm, "getSecret")
      .mockImplementationOnce(originalGetSecret)
      .mockImplementationOnce(async () => {
        throw new Error("Transient secrets manager timeout");
      });
    await bindRunProviderKey({
      organizationId,
      actor: { kind: "user", id: actorId, organizationId },
      provider: "openai",
      model: "gpt-5.4",
      companyConnectionId: actorChatgptKey.id,
      account: { source: "agent", subscriptionKind: null },
      accountLock: null,
      runtimeCommand: null,
    });
    expect(getSecretSpy).toHaveBeenCalledTimes(2);
    getSecretSpy.mockImplementation(originalGetSecret);

    // Mock modelSyncService.syncModelsForApiKey so that:
    // - SuperGrok key lazily links grokModel on run 1 (1 call)
    // - ChatGPT Subscription key throws a transient network error on run 1 (1 call,
    //   verifying canLaunchAgentRuntimeModel catches sync errors without failing
    //   start_agent_run), then completes without linking gpt-5.4 on run 2 (1 call)
    //   and is cached for 5 minutes on runs 3 and 4 (0 calls).
    let chatgptSyncAttempts = 0;
    const syncSpy = vi
      .spyOn(modelSyncService, "syncModelsForApiKey")
      .mockImplementation(async ({ apiKeyId }) => {
        if (apiKeyId === actorGrokKey.id) {
          await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
            actorGrokKey.id,
            [grokModel.id],
          );
          return { syncedCount: 1, error: null } as never;
        }
        chatgptSyncAttempts += 1;
        if (chatgptSyncAttempts === 1) {
          throw new TypeError("fetch failed");
        }
        return { syncedCount: 0, error: null } as never;
      });

    for (const subagent of [
      claudeRuntimeSubagent,
      codexSubagent,
      grokSubagent,
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
      },
    });
    await mockDetachedTaskStart();

    const selectedIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await executeArchestraTool(
        TOOL_START_AGENT_RUN_FULL_NAME,
        { message: `Review PR #${i + 1}` },
        context,
      );
      expect(res.isError).toBeFalsy();
      selectedIds.push(
        (res.structuredContent as { run: { agent_id: string } }).run.agent_id,
      );
    }

    // `codexSubagent` (unlinked gpt-5.4 + transient sync error on run 1) is skipped during preflight,
    // while `claudeRuntimeSubagent` (archestra-claude-code-runtime with personal subscription)
    // and `grokSubagent` (lazily synced SuperGrok subscription) alternate in 1:1 round-robin,
    // and the 5-minute TTL cooldown prevents re-syncing the ChatGPT key on runs 3 and 4.
    expect(syncSpy).toHaveBeenCalledTimes(3);
    expect(selectedIds).toEqual([
      claudeRuntimeSubagent.id,
      grokSubagent.id,
      claudeRuntimeSubagent.id,
      grokSubagent.id,
    ]);
  });

  test("dispatches start_agent_run and transfer_credential through a delegated foreground load-balanced router agent on a single manual gateway", async ({
    makeAgent,
  }) => {
    const reviewSubagentA = await createRuntimeSubagent(
      makeAgent,
      "Code Review Subagent A",
      false,
    );
    const reviewSubagentB = await createRuntimeSubagent(
      makeAgent,
      "Code Review Subagent B",
      false,
    );

    // Foreground router agent (`runtime: null`, `subagentLoadBalancing.enabled: true`)
    const reviewRouter = await makeAgent({
      name: "Code Review Router",
      agentType: "agent",
      organizationId,
      authorId: actorId,
      environmentId: gateway.environmentId,
      accessAllSubagents: false,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    for (const subagent of [reviewSubagentA, reviewSubagentB]) {
      const tool = await ToolModel.findOrCreateDelegationTool(subagent.id);
      await AgentToolModel.create(reviewRouter.id, tool.id);
    }

    // Manual gateway (`accessAllSubagents: false`, `subagentLoadBalancing: null`)
    // delegates ONLY to the foreground router agent, not directly to the 2 runtime subagents.
    await AgentModel.update(gateway.id, {
      accessAllSubagents: false,
      subagentLoadBalancing: null,
    });
    const routerDelegationTool = await ToolModel.findOrCreateDelegationTool(
      reviewRouter.id,
    );
    await AgentToolModel.create(gateway.id, routerDelegationTool.id);

    // OpenAPPA runtime target discovery includes load-balanced router agents
    const runtimeTargets = await AgentModel.findRuntimeTargets(organizationId);
    expect(runtimeTargets.map((t) => t.id)).toContain(reviewRouter.id);

    const sendSpy = await mockDetachedTaskStart();

    // 1. Dispatch via router UUID and via `agent__code_review_router` tool name
    const expectedOrder = [reviewSubagentA.id, reviewSubagentB.id];
    const run1 = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        agent_id: reviewRouter.id,
        message: "Review PR #101 via router UUID",
      },
      context,
    );
    expect(run1.isError).toBeFalsy();
    const run1Data = run1.structuredContent as {
      run: { run_id: string; agent_id: string };
    };
    expect(run1Data.run.agent_id).toBe(expectedOrder[0]);
    expect(sendSpy.mock.calls[0]?.[0]).toMatchObject({
      agentId: expectedOrder[0],
      systemParams: expect.objectContaining({
        subagentExecutionPolicy: expect.objectContaining({
          retries: SUBAGENT_LOAD_BALANCING_RETRIES,
          fallbackAgentIds: [expectedOrder[1]],
        }),
      }),
    });

    const run2 = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        agent_id: "agent__code_review_router",
        message: "Review PR #102 via router slug",
      },
      context,
    );
    expect(run2.isError).toBeFalsy();
    const run2Data = run2.structuredContent as {
      run: { run_id: string; agent_id: string };
    };
    expect(run2Data.run.agent_id).toBe(expectedOrder[1]);

    // 2. Calling get_agent_run from the manual gateway succeeds via 1-hop router delegation access
    const getRun1 = await executeArchestraTool(
      TOOL_GET_AGENT_RUN_FULL_NAME,
      { run_id: run1Data.run.run_id },
      context,
    );
    expect(getRun1.isError).toBeFalsy();

    // 3. Minting an ephemeral credential grant targeting the router agent binds to the winning subagent
    const grantRes = await executeArchestraTool(
      TOOL_TRANSFER_CREDENTIAL_FULL_NAME,
      {
        agent_id: "agent__code_review_router",
        ephemeral: true,
        environment: [
          {
            key: "CODE_REVIEW_TOKEN",
            type: "secret",
            value: "ghs_ephemeral_router_secret",
          },
        ],
      },
      context,
    );
    expect(grantRes.isError).toBeFalsy();
    const grantId = (
      grantRes.structuredContent as { credential_grant_id: string }
    ).credential_grant_id;
    expect(grantId).toBeTruthy();

    const run3 = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        agent_id: "agent__code_review_router",
        credential_grant_ids: [grantId],
        message: "Review PR #103 with ephemeral credential",
      },
      context,
    );
    expect(run3.isError).toBeFalsy();
    expect(sendSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentId: expectedOrder[0],
        systemParams: expect.objectContaining({
          ephemeralCredentials: {
            CODE_REVIEW_TOKEN: "ghs_ephemeral_router_secret",
          },
        }),
      }),
    );

    // 4. An unassigned router agent is refused when the caller gateway has accessAllSubagents: false
    const unassignedRouter = await makeAgent({
      name: "Unassigned Router",
      agentType: "agent",
      organizationId,
      authorId: actorId,
      environmentId: gateway.environmentId,
      accessAllSubagents: false,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    const refusedRun = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        agent_id: unassignedRouter.id,
        message: "Should be refused",
      },
      context,
    );
    expect(refusedRun.isError).toBe(true);
    expect((refusedRun.content[0] as { text: string }).text).toContain(
      "is not an allowed subagent",
    );
  });

  test("Lobster Env foreground load-balancer agent skips unready *-runtime subagents (Codex without ChatGPT subscription, Copilot without personal GitHub Copilot, Kimi on Moonshot key) and dispatches to ready *-runtime subagents", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeSecret,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const adminUser = await makeUser();

    // Organization has a metered OpenAI key (`llmApiKeyId`), which Lobster Env itself uses,
    // but the acting user has NO personal ChatGPT subscription connected.
    // `archestra-codex-runtime` MUST NOT falsely report ready via the metered OpenAI key.
    const codexRuntimeSubagent = await makeAgent({
      organizationId,
      name: "Lobster Codex",
      agentType: "agent",
      modelId,
      llmApiKeyId,
      environmentId: gateway.environmentId,
      runtime: runtimeConfig({
        command: ["archestra-codex-runtime"],
        inferenceProtocol: "openai_responses",
      }),
    });

    // `archestra-copilot-runtime` configured with admin's personal Copilot key while actor has none
    // must be skipped during preflight (`providerRequiresPerUserCredential("github-copilot")`).
    const copilotModel = await ModelModel.create({
      externalId: "github-copilot/claude-sonnet-4.6",
      provider: "github-copilot",
      modelId: "claude-sonnet-4.6",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    const adminCopilotSecret = await makeSecret({
      secret: { apiKey: "ghu_admin_copilot_token" },
    });
    const adminCopilotKey = await makeLlmProviderApiKey(
      organizationId,
      adminCopilotSecret.id,
      {
        provider: "github-copilot",
        name: "GitHub Copilot",
        userId: adminUser.id,
      },
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
      adminCopilotKey.id,
      [copilotModel.id],
    );
    const unreadyCopilotSubagent = await makeAgent({
      organizationId,
      name: "Lobster Copilot",
      agentType: "agent",
      modelId: copilotModel.id,
      llmApiKeyId: adminCopilotKey.id,
      environmentId: gateway.environmentId,
      runtime: runtimeConfig({
        command: ["archestra-copilot-runtime"],
        inferenceProtocol: "openai_chat",
      }),
    });

    // `archestra-kimi-runtime` misconfigured on a Moonshot (`kimi`) model instead of `kimi-code`
    // must also be marked unready by `getAgentRuntimeProviderCompatibility`.
    const moonshotModel = await ModelModel.create({
      externalId: "kimi/kimi-k2-5-moonshot",
      provider: "kimi",
      modelId: "kimi-k2.5",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    const moonshotSecret = await makeSecret({
      secret: { apiKey: "sk-moonshot-test" },
    });
    const moonshotKey = await makeLlmProviderApiKey(
      organizationId,
      moonshotSecret.id,
      {
        provider: "kimi",
        name: "Moonshot Key",
        userId: null,
      },
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(moonshotKey.id, [
      moonshotModel.id,
    ]);
    const misconfiguredKimiSubagent = await makeAgent({
      organizationId,
      name: "Lobster Kimi Misconfigured",
      agentType: "agent",
      modelId: moonshotModel.id,
      llmApiKeyId: moonshotKey.id,
      environmentId: gateway.environmentId,
      runtime: runtimeConfig({
        command: ["archestra-kimi-runtime"],
        inferenceProtocol: "openai_chat",
      }),
    });

    // Ready `archestra-kimi-runtime` subagent with actor's Kimi Code key
    const kimiCodeModel = await ModelModel.create({
      externalId: "kimi-code/k3.1-pro",
      provider: "kimi-code",
      modelId: "k3.1-pro",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    const kimiCodeSecret = await makeSecret({
      secret: { apiKey: "sk-kimi-actor" },
    });
    const actorKimiKey = await makeLlmProviderApiKey(
      organizationId,
      kimiCodeSecret.id,
      {
        provider: "kimi-code",
        name: "Kimi Code",
        userId: actorId,
      },
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(actorKimiKey.id, [
      kimiCodeModel.id,
    ]);
    const readyKimiSubagent = await makeAgent({
      organizationId,
      name: "Lobster Kimi",
      agentType: "agent",
      modelId: kimiCodeModel.id,
      llmApiKeyId: actorKimiKey.id,
      environmentId: gateway.environmentId,
      runtime: runtimeConfig({
        command: ["archestra-kimi-runtime"],
        inferenceProtocol: "openai_chat",
      }),
    });

    // Ready `archestra-grok-runtime` subagent configured by admin, substituted with actor's personal SuperGrok subscription
    const grokRuntimeModel = await ModelModel.create({
      externalId: "xai/grok-4.7-runtime",
      provider: "xai",
      modelId: "grok-4.7-runtime",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    const adminGrokSecret = await makeSecret({
      secret: { apiKey: "xai-subscription:admin-grok-runtime" },
    });
    const adminGrokKey = await makeLlmProviderApiKey(
      organizationId,
      adminGrokSecret.id,
      {
        provider: "xai",
        name: "SuperGrok",
        userId: adminUser.id,
      },
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(adminGrokKey.id, [
      grokRuntimeModel.id,
    ]);
    const grokRuntimeSecret = await makeSecret({
      secret: { apiKey: "xai-subscription:actor-grok-runtime" },
    });
    const actorGrokRuntimeKey = await makeLlmProviderApiKey(
      organizationId,
      grokRuntimeSecret.id,
      {
        provider: "xai",
        name: "SuperGrok",
        userId: actorId,
      },
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
      actorGrokRuntimeKey.id,
      [grokRuntimeModel.id],
    );
    const readyGrokSubagent = await makeAgent({
      organizationId,
      name: "Lobster Grok",
      agentType: "agent",
      modelId: grokRuntimeModel.id,
      llmApiKeyId: adminGrokKey.id,
      environmentId: gateway.environmentId,
      runtime: runtimeConfig({
        command: ["archestra-grok-runtime"],
        inferenceProtocol: "openai_chat",
      }),
    });

    // Runtime-less load-balancer agent (`Lobster Env`)
    const lobsterEnv = await makeAgent({
      organizationId,
      name: "Lobster Env",
      agentType: "agent",
      modelId,
      llmApiKeyId,
      environmentId: gateway.environmentId,
      accessAllSubagents: false,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    for (const subagent of [
      codexRuntimeSubagent,
      unreadyCopilotSubagent,
      misconfiguredKimiSubagent,
      readyKimiSubagent,
      readyGrokSubagent,
    ]) {
      const delegationTool = await ToolModel.findOrCreateDelegationTool(
        subagent.id,
      );
      await AgentToolModel.create(lobsterEnv.id, delegationTool.id);
    }
    await seedAndAssignArchestraTools(lobsterEnv.id);

    await mockDetachedTaskStart();

    // Calling `start_agent_run` directly from `Lobster Env` (with `agent_id` omitted)
    // and delegating via `agent__lobster_codex` both route across ONLY the 2 ready `*-runtime` subagents.
    const lobsterEnvContext = {
      ...context,
      agent: { id: lobsterEnv.id, name: lobsterEnv.name },
      agentId: lobsterEnv.id,
    };

    const run1 = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "Task 1 via omitted agent_id" },
      lobsterEnvContext,
    );
    expect(run1.isError).toBeFalsy();
    const run1AgentId = (
      run1.structuredContent as { run: { agent_id: string } }
    ).run.agent_id;

    const run2 = await executeArchestraTool(
      "agent__lobster_codex",
      { message: "Task 2 via delegation tool" },
      lobsterEnvContext,
    );
    expect(run2.isError).toBeFalsy();
    const run2AgentId = (
      run2.structuredContent as { run: { agent_id: string } }
    ).run.agent_id;

    expect(new Set([run1AgentId, run2AgentId])).toEqual(
      new Set([readyKimiSubagent.id, readyGrokSubagent.id]),
    );
  });

  test("fails over across load-balanced candidates when a primary candidate requires admin-only shared credentials", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const memberUser = await makeUser();
    await makeMember(memberUser.id, organizationId, { role: "member" });

    await createRuntimeCredentialDefinition({
      organizationId,
      userId: actorId,
      definition: {
        key: "admin-only-shared-cred",
        name: "Admin-only shared credential",
        description: "",
        icon: null,
        allowPersonal: false,
        allowOrganization: true,
      },
    });
    await setRuntimeCredentialConnection({
      organizationId,
      userId: actorId,
      credentialId: "admin-only-shared-cred",
      scope: "organization",
      value: "shared-secret",
    });

    const adminOnlyCandidate = await makeAgent({
      name: "Admin-Only Candidate",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: runtimeConfig({
        credentials: [
          {
            key: "SHARED_ORG_SECRET",
            label: "Admin-only shared credential",
            scope: "shared",
            credentialId: "admin-only-shared-cred",
            required: false,
          },
        ],
      }),
    });
    await AgentToolModel.create(
      gateway.id,
      (await ToolModel.findOrCreateDelegationTool(adminOnlyCandidate.id)).id,
    );
    const openCandidate = await createRuntimeSubagent(
      makeAgent,
      "Open Candidate",
    );

    await AgentModel.update(gateway.id, {
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });

    const sendSpy = await mockDetachedTaskStart();

    // `memberUser` is a non-admin `member`, so `adminOnlyCandidate` fails preflight
    // with `SharedCredentialAccessDeniedError` (`credentials_admin_only`) and load
    // balancing must fail over to `openCandidate` instead of aborting.
    const result = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "Run on eligible worker" },
      { ...context, userId: memberUser.id },
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      run: {
        agent_id: openCandidate.id,
      },
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]?.[0]).toMatchObject({
      agentId: openCandidate.id,
    });
  });

  test("delegates from a foreground orchestrator to a load-balanced router subagent via agent__* without an intermediate subagent turn, binds the runtime run to the caller session, and permits get_agent_run / steer_agent_run", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeMember,
    makeSecret,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    const proofSecret = "foreground-router-delegation-test-secret";
    config.openappa.enabled = true;
    config.openappa.offerSigningSecret = proofSecret;
    await GuardrailsDeploymentModel.setEnabled(true);

    const otherUser = await makeUser();
    await makeMember(otherUser.id, organizationId, { role: "member" });
    const otherPersonalSecret = await makeSecret({
      secret: { apiKey: "xai-subscription:other-user-only" },
    });
    const otherPersonalKey = await makeLlmProviderApiKey(
      organizationId,
      otherPersonalSecret.id,
      {
        provider: "xai",
        name: "Other Personal Key",
        userId: otherUser.id,
      },
    );
    const otherModel = await ModelModel.create({
      externalId: `xai/unready-model-${organizationId.slice(0, 8)}`,
      provider: "xai",
      modelId: "unready-model",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
      otherPersonalKey.id,
      [otherModel.id],
    );

    const routerAgent = await makeAgent({
      name: "Coding Env Router",
      description:
        "Routes an explicitly delegated coding task to a user-selected isolated Agent runtime",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: null,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    const workerAlpha = await makeAgent({
      name: "Runtime Worker Alpha",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: runtimeConfig({ maxTier: "M" }),
    });
    const workerBeta = await makeAgent({
      name: "Runtime Worker Beta",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: runtimeConfig({ maxTier: "M" }),
    });
    const unreadyWorker = await makeAgent({
      name: "Unready Runtime Worker",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId: otherModel.id,
      llmApiKeyId: otherPersonalKey.id,
      runtime: runtimeConfig({ maxTier: "M" }),
    });

    for (const worker of [workerAlpha, workerBeta, unreadyWorker]) {
      const workerTool = await ToolModel.findOrCreateDelegationTool(worker.id);
      await AgentToolModel.create(routerAgent.id, workerTool.id);
    }
    const routerToolRow = await ToolModel.findOrCreateDelegationTool(
      routerAgent.id,
    );

    const foregroundOrchestrator = await makeAgent({
      name: "Foreground Orchestrator",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: true,
      modelId,
      llmApiKeyId,
    });
    await seedAndAssignArchestraTools(foregroundOrchestrator.id);

    // 1. Verify delegation tool descriptions and system prompt override manual selection
    const callerDelegationTools = await getAgentTools({
      agentId: foregroundOrchestrator.id,
      organizationId,
      userId: actorId,
    });
    const advertisedRouterTool = callerDelegationTools.find(
      (tool) => tool.name === routerToolRow.name,
    );
    expect(advertisedRouterTool).toBeDefined();
    expect(advertisedRouterTool?.description).toContain(
      "Runs in the background in Agent Runtime and returns a run link, not the answer.",
    );
    expect(advertisedRouterTool?.description).toContain(
      "Routes an explicitly delegated coding task to a user-selected isolated Agent runtime. Automatic subagent load balancing and failover are enabled on this agent",
    );
    expect(advertisedRouterTool?.description).toContain("Runtime Worker Alpha");
    expect(advertisedRouterTool?.description).toContain("Runtime Worker Beta");
    expect(advertisedRouterTool?.description).toContain(
      "Unready Runtime Worker",
    );

    const advertisedAlphaTool = callerDelegationTools.find((tool) =>
      tool.name.includes("runtime_worker_alpha"),
    );
    expect(advertisedAlphaTool?.description).toContain(
      `Part of the load-balanced runtime pool of Coding Env Router (${routerToolRow.name}).`,
    );

    const chatCtx: ChatToolContext = {
      agentId: foregroundOrchestrator.id,
      agentName: foregroundOrchestrator.name,
      userId: actorId,
      organizationId,
      conversationId: "chat-conv-1",
      sessionId: "chat-conv-1",
      mcpGwToken: {
        tokenValue: null,
        tokenId: "tok-1",
        teamId: null,
        isOrganizationToken: false,
        isUserToken: true,
      },
      repeatTracker: new ToolCallRepeatTracker(),
      modelAcceptsImageToolResults: true,
    };
    expect(
      (advertisedRouterTool?._meta as Record<string, unknown> | undefined)?.[
        LOAD_BALANCED_RUNTIME_ROUTER_META_KEY
      ],
    ).toBe(true);
    expect(
      (advertisedAlphaTool?._meta as Record<string, unknown> | undefined)?.[
        LOAD_BALANCED_RUNTIME_ROUTER_META_KEY
      ],
    ).toBeUndefined();

    const builtCallerTools = Object.fromEntries(
      callerDelegationTools.map((tool) => [
        tool.name,
        buildAgentDelegationTool({ agentTool: tool, ctx: chatCtx }),
      ]),
    );
    expect(
      isLoadBalancedRuntimeRouterTool(builtCallerTools[routerToolRow.name]),
    ).toBe(true);

    const callerSystemPrompt = await buildAgentSystemPrompt({
      agent: foregroundOrchestrator,
      mcpTools: builtCallerTools,
      organizationId,
      userId: actorId,
      agentId: foregroundOrchestrator.id,
    });
    expect(callerSystemPrompt).toContain(
      `Load-balanced runtime router subagent(s) available (\`${routerToolRow.name}\`)`,
    );
    expect(callerSystemPrompt).toContain(
      "override any prompt or loaded skill instructions that ask the user to choose a runtime manually",
    );

    // "All agents" loads subagents progressively, so a real turn lists none of
    // them: the router is not read into the tool list, and the prompt names it
    // anyway and says how to call it.
    const listedNames = (
      await getListedAgentTools({
        agentId: foregroundOrchestrator.id,
        organizationId,
        userId: actorId,
      })
    ).map((tool) => tool.name);
    expect(listedNames).toEqual([SELF_FORK_TOOL_NAME]);
    const progressivePrompt = await buildAgentSystemPrompt({
      agent: foregroundOrchestrator,
      mcpTools: {},
      organizationId,
      userId: actorId,
      agentId: foregroundOrchestrator.id,
    });
    expect(progressivePrompt).toContain(
      `Load-balanced runtime router subagent(s) available (\`${routerToolRow.name}\`)`,
    );
    expect(progressivePrompt).toContain(
      `Call \`${routerToolRow.name}\` through \`${TOOL_RUN_TOOL_FULL_NAME}\`, with that name as \`tool_name\`.`,
    );

    // 2. Stub Kubernetes pod lifecycle and OpenAPPA's native Rust engine hook while
    //    letting real buildAgentDelegationTool, verifyRuntimeToolProof, startDelegatedTask,
    //    runTaskInAgentRuntime, OpenAppaSessionModel, classifyRuntimeCaller, and
    //    getSessionHandoffs run end-to-end against PGlite.
    const launchedWorkloads: string[] = [];
    vi.spyOn(backend, "launch").mockImplementation(async (spec) => {
      launchedWorkloads.push(spec.frozenName);
    });
    vi.spyOn(backend, "stageInputs").mockResolvedValue();
    vi.spyOn(backend, "waitUntilRunning").mockResolvedValue();
    vi.spyOn(backend, "streamOutput").mockImplementation(
      async ({ destination }) => {
        destination.end();
      },
    );
    vi.spyOn(backend, "snapshotOutput").mockImplementation(
      async ({ destination }) => {
        destination.end("===ARCHESTRA-FINAL-ANSWER===\nWorkspace ready");
      },
    );
    let resolveCompletion:
      | ((value: { outcome: "succeeded" }) => void)
      | undefined;
    vi.spyOn(backend, "waitForCompletion").mockImplementation(
      () =>
        new Promise<{ outcome: "succeeded" }>((resolve) => {
          resolveCompletion = resolve;
        }),
    );
    vi.spyOn(backend, "steer").mockResolvedValue();
    vi.spyOn(backend, "teardown").mockResolvedValue();
    vi.spyOn(backend, "releaseRun").mockResolvedValue();
    vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);

    vi.spyOn(openappaService, "startRuntimeChild").mockImplementation(
      async ({ session }) => {
        await db.insert(schema.openappaSessionsTable).values({
          organizationId: session.organization_id,
          callerId: session.caller_id,
          sessionId: session.session_id,
          actor: openappaActor(session.session_id),
          root: openappaActor(session.parent_id ?? session.session_id),
          parentId: session.parent_id ?? null,
          startDecision: { decision: "ack" },
        });
        return {};
      },
    );
    vi.spyOn(openappaService, "addressRuntimeChild").mockResolvedValue();
    vi.spyOn(openappaService, "loadChildReturns").mockResolvedValue([]);

    const parentSession = {
      organization_id: organizationId,
      caller_id: `user:${actorId}`,
      session_id: `user:${actorId}|chat-conv-1`,
    };
    await db.insert(schema.openappaSessionsTable).values({
      organizationId,
      callerId: parentSession.caller_id,
      sessionId: parentSession.session_id,
      actor: openappaActor(parentSession.session_id),
      root: openappaActor(parentSession.session_id),
      parentId: null,
      startDecision: { decision: "ack" },
    });
    const recordReleasedCall = async (
      callId: string,
      tool: string,
      spawn: boolean,
      session = parentSession,
    ) => {
      await db.insert(schema.openappaOperationsTable).values({
        organizationId,
        callerId: session.caller_id,
        sessionId: session.session_id,
        operationId: `call:${callId}`,
        root: openappaActor(session.session_id),
        status: "complete",
        input: {
          semantic: {
            event: "tool_call",
            tool,
            spawn,
          },
        },
        decision: { decision: "allow_call" },
      });
    };

    const spawnCallId = "call-router-1";
    await recordReleasedCall(spawnCallId, routerToolRow.name, true);

    const spawnArgs = { message: "Prepare the repository workspace" };
    const spawnProof = signRuntimeToolProof({
      session: parentSession,
      toolCallId: spawnCallId,
      action: routerToolRow.name,
      arguments: spawnArgs,
      spawn: true,
      secret: proofSecret,
    });
    expect(spawnProof).toBeDefined();

    const aiRouterTool = builtCallerTools[routerToolRow.name];
    if (!aiRouterTool) {
      throw new Error("Expected built router delegation tool");
    }
    const rawResult = await aiRouterTool.execute?.(
      { ...spawnArgs, runtime_proof: spawnProof },
      {
        toolCallId: spawnCallId,
        messages: [],
      },
    );
    const parsedLaunch = JSON.parse(String(rawResult)) as {
      run: { run_id: string; agent_id: string; agent_name: string };
      run_url: string;
    };
    expect([workerAlpha.id, workerBeta.id]).toContain(
      parsedLaunch.run.agent_id,
    );
    expect(chatCtx.runId).toBeUndefined();
    expect(chatCtx.launchedRunIds?.has(parsedLaunch.run.run_id)).toBe(true);

    // Wait briefly for the detached launch to reach waitForCompletion and bind its OpenAPPA child
    await vi.waitFor(async () => {
      expect(launchedWorkloads).toHaveLength(1);
    });

    const workspace = await AgentWorkspaceModel.findById(
      parsedLaunch.run.run_id,
    );
    expect(workspace).not.toBeNull();
    expect(workspace?.agentId).toBe(parsedLaunch.run.agent_id);
    expect(launchedWorkloads).toEqual([workspace?.workloadName]);
    const childSessionRow = await OpenAppaSessionModel.familySession({
      organizationId,
      callerId: `user:${actorId}`,
      sessionId: `user:${actorId}|${workspace?.workloadName}`,
    });
    // Bound directly to the foreground caller's session, NEVER to an intermediate router session
    expect(childSessionRow?.parentId).toBe(parentSession.session_id);

    // Session handoffs record both handedTo and the push move from the agent__* call
    const handoffs = await getSessionHandoffs({
      organizationId,
      sessionId: "chat-conv-1",
      ownUserId: actorId,
    });
    expect(handoffs.handedTo.map((r) => r.runId)).toContain(
      parsedLaunch.run.run_id,
    );
    expect(handoffs.moves).toContainEqual(
      expect.objectContaining({
        kind: "push",
        runId: parsedLaunch.run.run_id,
      }),
    );

    // 3. Foreground caller can inspect and steer the launched run without "bound to a different session",
    //    whereas a different chat session IS refused with "bound to a different session".
    const readArgs = { run_id: parsedLaunch.run.run_id };
    await recordReleasedCall(
      "call-read-1",
      TOOL_GET_AGENT_RUN_FULL_NAME,
      false,
    );
    const readProof = signRuntimeToolProof({
      session: parentSession,
      toolCallId: "call-read-1",
      action: "get_agent_run",
      arguments: readArgs,
      spawn: false,
      secret: proofSecret,
    });
    const callerContext: ArchestraContext = {
      agent: {
        id: foregroundOrchestrator.id,
        name: foregroundOrchestrator.name,
      },
      agentId: foregroundOrchestrator.id,
      userId: actorId,
      organizationId,
      sessionId: "chat-conv-1",
    };
    const getRunResult = await executeArchestraTool(
      TOOL_GET_AGENT_RUN_FULL_NAME,
      { ...readArgs, runtime_proof: readProof },
      callerContext,
    );
    expect(getRunResult.isError).toBeFalsy();
    expect(getRunResult.structuredContent).toMatchObject({
      run: {
        run_id: parsedLaunch.run.run_id,
        agent_id: parsedLaunch.run.agent_id,
      },
    });

    const otherChatSession = {
      organization_id: organizationId,
      caller_id: `user:${actorId}`,
      session_id: `user:${actorId}|other-chat-conv`,
    };
    await db.insert(schema.openappaSessionsTable).values({
      organizationId,
      callerId: otherChatSession.caller_id,
      sessionId: otherChatSession.session_id,
      actor: openappaActor(otherChatSession.session_id),
      root: openappaActor(otherChatSession.session_id),
      parentId: null,
      startDecision: { decision: "ack" },
    });
    await recordReleasedCall(
      "call-other-steer",
      TOOL_STEER_AGENT_RUN_FULL_NAME,
      false,
      otherChatSession,
    );
    const otherSteerArgs = {
      run_id: parsedLaunch.run.run_id,
      message: "Wrong session attempt",
    };
    const otherSteerProof = signRuntimeToolProof({
      session: otherChatSession,
      toolCallId: "call-other-steer",
      action: "steer_agent_run",
      arguments: otherSteerArgs,
      spawn: false,
      secret: proofSecret,
    });
    const refusedOtherSessionSteer = await executeArchestraTool(
      TOOL_STEER_AGENT_RUN_FULL_NAME,
      { ...otherSteerArgs, runtime_proof: otherSteerProof },
      { ...callerContext, sessionId: "other-chat-conv" },
    );
    expect(refusedOtherSessionSteer.isError).toBe(true);
    expect(JSON.stringify(refusedOtherSessionSteer)).toContain(
      "bound to a different session",
    );

    const steerArgs = {
      run_id: parsedLaunch.run.run_id,
      message: "Take ticket PM-42 next",
    };
    await recordReleasedCall(
      "call-steer-1",
      TOOL_STEER_AGENT_RUN_FULL_NAME,
      false,
    );
    const steerProof = signRuntimeToolProof({
      session: parentSession,
      toolCallId: "call-steer-1",
      action: "steer_agent_run",
      arguments: steerArgs,
      spawn: false,
      secret: proofSecret,
    });
    const steerResult = await executeArchestraTool(
      TOOL_STEER_AGENT_RUN_FULL_NAME,
      { ...steerArgs, runtime_proof: steerProof },
      callerContext,
    );
    expect(steerResult.isError).toBeFalsy();

    resolveCompletion?.({ outcome: "succeeded" });
    await drainBackgroundWork();

    // 4. A second router delegation on the same ChatToolContext wrapper rotates to the other ready worker
    //    (skipping Unready Runtime Worker) and persists its own push handoff without mutating chatCtx.runId
    const spawn2CallId = "call-router-2";
    const spawn2Args = { message: "Prepare the second repository workspace" };
    await recordReleasedCall(spawn2CallId, routerToolRow.name, true);
    const spawn2Proof = signRuntimeToolProof({
      session: parentSession,
      toolCallId: spawn2CallId,
      action: routerToolRow.name,
      arguments: spawn2Args,
      spawn: true,
      secret: proofSecret,
    });
    vi.spyOn(backend, "waitForCompletion").mockResolvedValue({
      outcome: "succeeded",
    });
    const rawSecondResult = await aiRouterTool.execute?.(
      { ...spawn2Args, runtime_proof: spawn2Proof },
      {
        toolCallId: spawn2CallId,
        messages: [],
      },
    );
    const parsedSecondLaunch = JSON.parse(String(rawSecondResult)) as {
      run: { run_id: string; agent_id: string };
    };
    expect(chatCtx.runId).toBeUndefined();
    expect(
      new Set([parsedLaunch.run.agent_id, parsedSecondLaunch.run.agent_id]),
    ).toEqual(new Set([workerAlpha.id, workerBeta.id]));

    await vi.waitFor(() => {
      expect(launchedWorkloads).toHaveLength(2);
    });

    const updatedHandoffs = await getSessionHandoffs({
      organizationId,
      sessionId: "chat-conv-1",
      ownUserId: actorId,
    });
    expect(updatedHandoffs.handedTo.map((r) => r.runId)).toEqual(
      expect.arrayContaining([
        parsedLaunch.run.run_id,
        parsedSecondLaunch.run.run_id,
      ]),
    );
    expect(updatedHandoffs.moves).toContainEqual(
      expect.objectContaining({
        kind: "push",
        runId: parsedLaunch.run.run_id,
      }),
    );
    expect(updatedHandoffs.moves).toContainEqual(
      expect.objectContaining({
        kind: "push",
        runId: parsedSecondLaunch.run.run_id,
      }),
    );
    await drainBackgroundWork();
  });

  test("hides pooled runtime worker agent__* schemas on load-balanced agents and gateways while implicitly exposing and admitting archestra__start_agent_run", async ({
    makeAgent,
  }) => {
    const lbChatAgent = await makeAgent({
      name: "Load-Balanced Chat Router",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      toolExposureMode: "search_and_run_only",
      modelId,
      llmApiKeyId,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    const workerAlpha = await makeAgent({
      name: "Alpha Runtime Worker",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: runtimeConfig({ maxTier: "M" }),
    });
    const workerBeta = await makeAgent({
      name: "Beta Runtime Worker",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: runtimeConfig({ maxTier: "M" }),
    });
    const inProcessHelper = await makeAgent({
      name: "In-Process Helper Subagent",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: null,
    });

    const alphaTool = await ToolModel.findOrCreateDelegationTool(
      workerAlpha.id,
    );
    const betaTool = await ToolModel.findOrCreateDelegationTool(workerBeta.id);
    const helperTool = await ToolModel.findOrCreateDelegationTool(
      inProcessHelper.id,
    );
    for (const tool of [alphaTool, betaTool, helperTool]) {
      await AgentToolModel.create(lbChatAgent.id, tool.id);
    }

    // Notice we do NOT assign archestra__start_agent_run in agent_tools on lbChatAgent!
    // Chat agents still keep self-fork (agent__self) plus non-runtime subagents, while pooled runtime workers are hidden.
    const chatDelegationTools = await getAgentTools({
      agentId: lbChatAgent.id,
      organizationId,
      userId: actorId,
    });
    expect(chatDelegationTools.map((t) => t.name)).toEqual([
      "agent__self",
      helperTool.name,
    ]);

    const chatMcpList = await buildAgentMcpToolList({
      agent: lbChatAgent,
      tokenAuth: {
        tokenId: "tok-chat",
        teamId: null,
        isOrganizationToken: false,
        organizationId,
        userId: actorId,
      },
    });
    const chatListedNames = chatMcpList.tools.map((t) => t.name);
    expect(chatListedNames).toContain(TOOL_START_AGENT_RUN_FULL_NAME);
    expect(chatListedNames).not.toContain(alphaTool.name);
    expect(chatListedNames).not.toContain(betaTool.name);

    await mockDetachedTaskStart();
    const lbChatContext: ArchestraContext = {
      agent: { id: lbChatAgent.id, name: lbChatAgent.name },
      agentId: lbChatAgent.id,
      userId: actorId,
      organizationId,
    };
    const r1 = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "First load-balanced chat launch" },
      lbChatContext,
    );
    const r2 = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "Second load-balanced chat launch" },
      lbChatContext,
    );
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    const a1 = (r1.structuredContent as { run: { agent_id: string } }).run
      .agent_id;
    const a2 = (r2.structuredContent as { run: { agent_id: string } }).run
      .agent_id;
    expect(new Set([a1, a2])).toEqual(new Set([workerAlpha.id, workerBeta.id]));

    // Now verify an external MCP gateway in search_and_run_only mode with NO assigned archestra tools:
    // tools/list stays compact (start_agent_run deferred), search_tools finds start_agent_run,
    // and run_tool executes start_agent_run without an explicit agent_tools assignment.
    const compactLbGateway = await makeAgent({
      name: "Compact LB Gateway",
      organizationId,
      authorId: actorId,
      agentType: "mcp_gateway",
      toolExposureMode: "search_and_run_only",
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    await AgentToolModel.create(compactLbGateway.id, alphaTool.id);
    await AgentToolModel.create(compactLbGateway.id, betaTool.id);

    const gatewayList = await buildAgentMcpToolList({
      agent: compactLbGateway,
      tokenAuth: {
        tokenId: "tok-gw",
        teamId: null,
        isOrganizationToken: false,
        organizationId,
        userId: actorId,
      },
    });
    const gatewayListedNames = gatewayList.tools.map((t) => t.name);
    expect(gatewayListedNames).toContain(TOOL_SEARCH_TOOLS_FULL_NAME);
    expect(gatewayListedNames).toContain(TOOL_RUN_TOOL_FULL_NAME);
    expect(gatewayListedNames).not.toContain(TOOL_START_AGENT_RUN_FULL_NAME);
    expect(gatewayListedNames).not.toContain(alphaTool.name);
    expect(gatewayListedNames).not.toContain(betaTool.name);

    const compactGwContext: ArchestraContext = {
      agent: { id: compactLbGateway.id, name: compactLbGateway.name },
      agentId: compactLbGateway.id,
      userId: actorId,
      organizationId,
    };
    const searchResult = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "start agent run" },
      compactGwContext,
    );
    expect(searchResult.isError).toBeFalsy();
    const discoveredNames = (
      searchResult.structuredContent as { tools: Array<{ toolName: string }> }
    ).tools.map((t) => t.toolName);
    expect(discoveredNames).toContain(TOOL_START_AGENT_RUN_FULL_NAME);

    const viaRunTool = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      {
        tool_name: TOOL_START_AGENT_RUN_FULL_NAME,
        tool_args: { message: "Launch via compact LB gateway" },
      },
      compactGwContext,
    );
    expect(viaRunTool.isError).toBeFalsy();
    expect([workerAlpha.id, workerBeta.id]).toContain(
      (viaRunTool.structuredContent as { run: { agent_id: string } }).run
        .agent_id,
    );
  });

  test("persists push handoffs for parallel buildAgentDelegationTool launches without overwriting incoming ctx.runId", async ({
    makeAgent,
  }) => {
    const routerAgent = await makeAgent({
      name: "Parallel Router",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: false,
      modelId,
      llmApiKeyId,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    const workerA = await createRuntimeSubagent(
      makeAgent,
      "Parallel Worker A",
      false,
    );
    const workerB = await createRuntimeSubagent(
      makeAgent,
      "Parallel Worker B",
      false,
    );
    for (const worker of [workerA, workerB]) {
      const workerTool = await ToolModel.findOrCreateDelegationTool(worker.id);
      await AgentToolModel.create(routerAgent.id, workerTool.id);
    }
    const routerToolRow = await ToolModel.findOrCreateDelegationTool(
      routerAgent.id,
    );

    const callerAgent = await makeAgent({
      name: "Parallel Caller",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: false,
      modelId,
      llmApiKeyId,
    });
    await AgentToolModel.create(callerAgent.id, routerToolRow.id);

    const callerTools = await getAgentTools({
      agentId: callerAgent.id,
      organizationId,
      userId: actorId,
    });
    const advertisedRouter = callerTools.find(
      (t) => t.name === routerToolRow.name,
    );
    if (!advertisedRouter) {
      throw new Error("Expected advertised router delegation tool");
    }

    const parallelLaunchedWorkloads: string[] = [];
    vi.spyOn(backend, "launch").mockImplementation(async (spec) => {
      parallelLaunchedWorkloads.push(spec.frozenName);
    });
    vi.spyOn(backend, "stageInputs").mockResolvedValue();
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
    vi.spyOn(backend, "steer").mockResolvedValue();
    vi.spyOn(backend, "teardown").mockResolvedValue();
    vi.spyOn(backend, "releaseRun").mockResolvedValue();
    vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);

    // Case 1: Foreground chat context (no incoming runId) invokes the same wrapper in parallel
    const chatCtx: ChatToolContext = {
      agentId: callerAgent.id,
      agentName: callerAgent.name,
      userId: actorId,
      organizationId,
      conversationId: "parallel-chat-session",
      sessionId: "parallel-chat-session",
      mcpGwToken: {
        tokenValue: null,
        tokenId: "tok-parallel",
        teamId: null,
        isOrganizationToken: false,
        isUserToken: true,
      },
      repeatTracker: new ToolCallRepeatTracker(),
      modelAcceptsImageToolResults: true,
    };
    const wrappedRouter = buildAgentDelegationTool({
      agentTool: advertisedRouter,
      ctx: chatCtx,
    });

    const [rawA, rawB] = await Promise.all([
      wrappedRouter.execute?.(
        { message: "Parallel task A" },
        { toolCallId: "parallel-call-1", messages: [] },
      ),
      wrappedRouter.execute?.(
        { message: "Parallel task B" },
        { toolCallId: "parallel-call-2", messages: [] },
      ),
    ]);
    const launchA = JSON.parse(String(rawA)) as {
      run: { run_id: string; agent_id: string };
    };
    const launchB = JSON.parse(String(rawB)) as {
      run: { run_id: string; agent_id: string };
    };
    expect(launchA.run.run_id).not.toBe(launchB.run.run_id);
    expect(chatCtx.runId).toBeUndefined();
    expect(chatCtx.launchedRunIds).toEqual(
      new Set([launchA.run.run_id, launchB.run.run_id]),
    );
    await vi.waitFor(() => {
      expect(parallelLaunchedWorkloads).toHaveLength(2);
    });

    const handoffs = await getSessionHandoffs({
      organizationId,
      sessionId: "parallel-chat-session",
      ownUserId: actorId,
    });
    expect(handoffs.handedTo.map((r) => r.runId)).toEqual(
      expect.arrayContaining([launchA.run.run_id, launchB.run.run_id]),
    );
    expect(handoffs.moves).toContainEqual(
      expect.objectContaining({ kind: "push", runId: launchA.run.run_id }),
    );
    expect(handoffs.moves).toContainEqual(
      expect.objectContaining({ kind: "push", runId: launchB.run.run_id }),
    );

    // Case 2: Runtime caller context with a pre-existing incoming runId preserves ctx.runId
    // across child launches while still recording child handoffs.
    const runtimeParentCtx: ChatToolContext = {
      ...chatCtx,
      conversationId: "runtime-parent-session",
      sessionId: "runtime-parent-session",
      runId: launchA.run.run_id,
      launchedRunIds: undefined,
      repeatTracker: new ToolCallRepeatTracker(),
    };
    const runtimeWrappedRouter = buildAgentDelegationTool({
      agentTool: advertisedRouter,
      ctx: runtimeParentCtx,
    });
    const rawChild = await runtimeWrappedRouter.execute?.(
      { message: "Child launch from runtime parent" },
      { toolCallId: "runtime-parent-call-1", messages: [] },
    );
    const childLaunch = JSON.parse(String(rawChild)) as {
      run: { run_id: string };
    };
    expect(runtimeParentCtx.runId).toBe(launchA.run.run_id);
    expect(runtimeParentCtx.launchedRunIds).toEqual(
      new Set([childLaunch.run.run_id]),
    );
    await vi.waitFor(() => {
      expect(parallelLaunchedWorkloads).toHaveLength(3);
    });
    const parentHandoffs = await getSessionHandoffs({
      organizationId,
      sessionId: "runtime-parent-session",
      ownUserId: actorId,
    });
    expect(parentHandoffs.moves).toContainEqual(
      expect.objectContaining({ kind: "push", runId: childLaunch.run.run_id }),
    );
  });

  test("does not treat an ordinary non-runtime agent quoting the router notice as a load-balanced runtime router", async ({
    makeAgent,
  }) => {
    const spoofedHelper = await makeAgent({
      name: "Spoofed Helper",
      description:
        "Automatic subagent load balancing and failover are enabled on this agent across its runtime pool (Fake Worker).",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: null,
    });
    const inProcessOnlyLbHelper = await makeAgent({
      name: "In-Process LB Helper",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: null,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    const spoofedToolRow = await ToolModel.findOrCreateDelegationTool(
      spoofedHelper.id,
    );
    await AgentToolModel.create(inProcessOnlyLbHelper.id, spoofedToolRow.id);
    const inProcessLbToolRow = await ToolModel.findOrCreateDelegationTool(
      inProcessOnlyLbHelper.id,
    );

    const callerAgent = await makeAgent({
      name: "Spoof Guard Caller",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: false,
      modelId,
      llmApiKeyId,
    });
    await AgentToolModel.create(callerAgent.id, spoofedToolRow.id);
    await AgentToolModel.create(callerAgent.id, inProcessLbToolRow.id);

    const delegationTools = await getAgentTools({
      agentId: callerAgent.id,
      organizationId,
      userId: actorId,
    });
    for (const descriptor of delegationTools) {
      expect(
        (descriptor._meta as Record<string, unknown> | undefined)?.[
          LOAD_BALANCED_RUNTIME_ROUTER_META_KEY
        ],
      ).toBeUndefined();
    }

    const chatCtx: ChatToolContext = {
      agentId: callerAgent.id,
      agentName: callerAgent.name,
      userId: actorId,
      organizationId,
      mcpGwToken: {
        tokenValue: null,
        tokenId: "tok-spoof",
        teamId: null,
        isOrganizationToken: false,
        isUserToken: true,
      },
      repeatTracker: new ToolCallRepeatTracker(),
      modelAcceptsImageToolResults: true,
    };
    const builtTools = Object.fromEntries(
      delegationTools.map((tool) => [
        tool.name,
        buildAgentDelegationTool({ agentTool: tool, ctx: chatCtx }),
      ]),
    );
    expect(
      isLoadBalancedRuntimeRouterTool(builtTools[spoofedToolRow.name]),
    ).toBe(false);
    expect(
      isLoadBalancedRuntimeRouterTool(builtTools[inProcessLbToolRow.name]),
    ).toBe(false);

    const systemPrompt = await buildAgentSystemPrompt({
      agent: callerAgent,
      mcpTools: builtTools,
      organizationId,
      userId: actorId,
      agentId: callerAgent.id,
    });
    expect(systemPrompt).not.toContain(
      "Load-balanced runtime router subagent(s) available",
    );

    // Invoking `inProcessLbToolRow` must execute `inProcessOnlyLbHelper` as an
    // ordinary foreground A2A delegation rather than entering `startDelegatedTask`
    // and failing with "No runtime subagents are assigned to this agent".
    const executeA2ASpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockResolvedValueOnce({
        messageId: "msg-in-process-lb-1",
        text: "Foreground answer from in-process LB helper",
        finishReason: "stop",
        responseUiMessage: {
          id: "msg-in-process-lb-1",
          role: "assistant",
          parts: [
            {
              type: "text",
              text: "Foreground answer from in-process LB helper",
            },
          ],
        },
      });
    const inProcessDelegationOutput = await builtTools[
      inProcessLbToolRow.name
    ].execute?.(
      { message: "Delegate to foreground LB helper" },
      { toolCallId: "in-process-lb-call-1", messages: [] },
    );
    expect(String(inProcessDelegationOutput)).toContain(
      "Foreground answer from in-process LB helper",
    );
    expect(executeA2ASpy).toHaveBeenCalledTimes(1);
    expect(executeA2ASpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: inProcessOnlyLbHelper.id,
        message: "Delegate to foreground LB helper",
      }),
    );

    const startRunTool = await ToolModel.findByName(
      TOOL_START_AGENT_RUN_FULL_NAME,
    );
    if (!startRunTool) {
      throw new Error("Expected seeded start_agent_run tool");
    }
    await AgentToolModel.create(callerAgent.id, startRunTool.id);

    const directStartAttempt = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      {
        agent_id: inProcessOnlyLbHelper.id,
        message: "Background attempt on in-process-only LB helper",
      },
      {
        agent: { id: callerAgent.id, name: callerAgent.name },
        agentId: callerAgent.id,
        userId: actorId,
        organizationId,
      },
    );
    expect(directStartAttempt.isError).toBe(true);
    expect(
      (directStartAttempt.content[0] as { text?: string } | undefined)?.text,
    ).toContain("has no Agent Runtime, so it cannot run in the background");
  });

  test("batches load-balanced router pool resolution across multiple manual and Auto routers without N+1 queries", async ({
    makeAgent,
  }) => {
    const workerOne = await createRuntimeSubagent(
      makeAgent,
      "Batch Worker One",
      false,
    );
    const workerTwo = await createRuntimeSubagent(
      makeAgent,
      "Batch Worker Two",
      false,
    );
    const workerOneTool = await ToolModel.findOrCreateDelegationTool(
      workerOne.id,
    );
    const workerTwoTool = await ToolModel.findOrCreateDelegationTool(
      workerTwo.id,
    );

    const manualRouterA = await makeAgent({
      name: "Manual Router A",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: false,
      modelId,
      llmApiKeyId,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    const manualRouterB = await makeAgent({
      name: "Manual Router B",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: false,
      modelId,
      llmApiKeyId,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    await AgentToolModel.create(manualRouterA.id, workerOneTool.id);
    await AgentToolModel.create(manualRouterB.id, workerTwoTool.id);

    const autoRouterA = await makeAgent({
      name: "Auto Router A",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: true,
      modelId,
      llmApiKeyId,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    const autoRouterB = await makeAgent({
      name: "Auto Router B",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: true,
      modelId,
      llmApiKeyId,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    await AgentExcludedSubagentModel.replaceForAgent(autoRouterB.id, [
      workerTwo.id,
    ]);

    const manualRouterATool = await ToolModel.findOrCreateDelegationTool(
      manualRouterA.id,
    );
    const manualRouterBTool = await ToolModel.findOrCreateDelegationTool(
      manualRouterB.id,
    );
    const autoRouterATool = await ToolModel.findOrCreateDelegationTool(
      autoRouterA.id,
    );
    const autoRouterBTool = await ToolModel.findOrCreateDelegationTool(
      autoRouterB.id,
    );

    const orchestrator = await makeAgent({
      name: "Batch Orchestrator",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: false,
      modelId,
      llmApiKeyId,
    });
    for (const routerTool of [
      manualRouterATool,
      manualRouterBTool,
      autoRouterATool,
      autoRouterBTool,
    ]) {
      await AgentToolModel.create(orchestrator.id, routerTool.id);
    }

    const gatewayLookupSpy = vi.spyOn(AgentModel, "findGatewayAgentById");
    const routerConfigsSpy = vi.spyOn(
      AgentModel,
      "findRouterPoolConfigsByOrganizationIdAndIds",
    );
    const assignedBatchSpy = vi.spyOn(
      AgentModel,
      "findAssignedRuntimeSubagentIdsByAgents",
    );
    const excludedBatchSpy = vi.spyOn(
      AgentExcludedSubagentModel,
      "findTargetAgentIdsByAgents",
    );
    const permissionsSpy = vi.spyOn(ResourcePermissions, "allows");

    const listed = await getAgentTools({
      agentId: orchestrator.id,
      organizationId,
      userId: actorId,
    });

    // Only the caller itself (orchestrator) is looked up once; none of the 4 routers trigger findGatewayAgentById
    expect(gatewayLookupSpy).toHaveBeenCalledTimes(1);
    expect(gatewayLookupSpy).toHaveBeenCalledWith(orchestrator.id);
    expect(routerConfigsSpy).toHaveBeenCalledTimes(1);
    expect(assignedBatchSpy).toHaveBeenCalledTimes(1);
    expect(excludedBatchSpy).toHaveBeenCalledTimes(1);
    expect(permissionsSpy).toHaveBeenCalledTimes(1);

    const byName = new Map(listed.map((tool) => [tool.name, tool]));
    expect(byName.get(manualRouterATool.name)?.description).toContain(
      "across its runtime pool (Batch Worker One)",
    );
    expect(byName.get(manualRouterBTool.name)?.description).toContain(
      "across its runtime pool (Batch Worker Two)",
    );
    expect(byName.get(autoRouterATool.name)?.description).toContain(
      "Batch Worker One",
    );
    expect(byName.get(autoRouterATool.name)?.description).toContain(
      "Batch Worker Two",
    );
    expect(byName.get(autoRouterBTool.name)?.description).toContain(
      "across its runtime pool (Batch Worker One)",
    );
    expect(byName.get(autoRouterBTool.name)?.description).not.toContain(
      "Batch Worker Two",
    );
    for (const routerTool of [
      manualRouterATool,
      manualRouterBTool,
      autoRouterATool,
      autoRouterBTool,
    ]) {
      expect(
        (
          byName.get(routerTool.name)?._meta as
            | Record<string, unknown>
            | undefined
        )?.[LOAD_BALANCED_RUNTIME_ROUTER_META_KEY],
      ).toBe(true);
    }
  });

  test("excludes implicit runtime starters and refuses runtime launches in encrypted chats without writing A2A or ordinary message rows", async ({
    makeAgent,
    makeConversation,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const encryptedWorker = await createRuntimeSubagent(
      makeAgent,
      "Encrypted Pool Worker",
      false,
    );
    const workerDelegationTool = await ToolModel.findOrCreateDelegationTool(
      encryptedWorker.id,
    );

    const encryptedLbAgent = await makeAgent({
      name: "Encrypted LB Assistant",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllTools: false,
      toolExposureMode: "search_and_run_only",
      accessAllSubagents: false,
      modelId,
      llmApiKeyId,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    await AgentToolModel.create(encryptedLbAgent.id, workerDelegationTool.id);

    const unencryptedConversation = await makeConversation(
      encryptedLbAgent.id,
      {
        organizationId,
        userId: actorId,
      },
    );
    const encryptedConversation = await makeConversation(encryptedLbAgent.id, {
      organizationId,
      userId: actorId,
      encryptedChat: true,
    });
    const encryptedChatAudit = {
      dek: Buffer.alloc(32, 9),
      conversationId: encryptedConversation.id,
    };

    let fullEncryptedAgentId: string | undefined;
    try {
      const seedGatewayListClient = (
        targetAgent: Awaited<ReturnType<typeof makeAgent>>,
        scopeKey: string,
      ) => {
        const mockClient = {
          ping: vi.fn().mockResolvedValue({}),
          listTools: vi.fn().mockImplementation(async () => {
            const gatewayAgent = await AgentModel.findGatewayAgentById(
              targetAgent.id,
            );
            if (!gatewayAgent) {
              throw new Error("Expected gateway agent row");
            }
            const listed = await buildAgentMcpToolList({
              agent: gatewayAgent,
              tokenAuth: {
                tokenId: "tok-encrypted-test",
                teamId: null,
                isOrganizationToken: false,
                organizationId,
                userId: actorId,
              },
            });
            return { tools: listed.tools };
          }),
          callTool: vi.fn(),
          close: vi.fn(),
        } as unknown as Client;
        chatMcpClient.__test.setCachedClient(
          chatMcpClient.__test.getCacheKey(targetAgent.id, actorId, scopeKey),
          mockClient,
        );
      };

      // Unencrypted control: implicit `start_agent_run` IS present
      seedGatewayListClient(encryptedLbAgent, unencryptedConversation.id);
      const unencryptedTools = await chatMcpClient.getChatMcpTools({
        agentName: encryptedLbAgent.name,
        agentId: encryptedLbAgent.id,
        userId: actorId,
        organizationId,
        conversationId: unencryptedConversation.id,
        sessionId: unencryptedConversation.id,
        suppressContentLogging: false,
        encryptedChatAudit: null,
      });
      expect(Object.keys(unencryptedTools)).toContain(
        TOOL_START_AGENT_RUN_FULL_NAME,
      );

      // Encrypted `search_and_run_only` chat: `start_agent_run`, `steer_agent_run`, and `agent__*` are excluded
      seedGatewayListClient(encryptedLbAgent, encryptedConversation.id);
      const encryptedCompactTools = await chatMcpClient.getChatMcpTools({
        agentName: encryptedLbAgent.name,
        agentId: encryptedLbAgent.id,
        userId: actorId,
        organizationId,
        conversationId: encryptedConversation.id,
        sessionId: encryptedConversation.id,
        suppressContentLogging: true,
        encryptedChatAudit,
      });
      expect(Object.keys(encryptedCompactTools)).not.toContain(
        TOOL_START_AGENT_RUN_FULL_NAME,
      );
      expect(Object.keys(encryptedCompactTools)).not.toContain(
        TOOL_STEER_AGENT_RUN_FULL_NAME,
      );
      expect(
        Object.keys(encryptedCompactTools).some((name) =>
          name.startsWith("agent__"),
        ),
      ).toBe(false);

      // Encrypted `full` exposure chat: also excludes implicit and explicitly assigned `start_agent_run`
      const fullEncryptedAgent = await makeAgent({
        name: "Encrypted Full LB Assistant",
        organizationId,
        authorId: actorId,
        agentType: "agent",
        toolExposureMode: "full",
        accessAllSubagents: false,
        modelId,
        llmApiKeyId,
        subagentLoadBalancing: {
          enabled: true,
          algorithm: "round_robin",
        },
      });
      fullEncryptedAgentId = fullEncryptedAgent.id;
      await AgentToolModel.create(
        fullEncryptedAgent.id,
        workerDelegationTool.id,
      );
      const writeWorkspaceFileToolName = getArchestraToolFullName(
        TOOL_WRITE_WORKSPACE_FILE_SHORT_NAME,
      );
      const readWorkspaceFileToolName = getArchestraToolFullName(
        TOOL_READ_WORKSPACE_FILE_SHORT_NAME,
      );
      const transferWorkspaceFileToolName = getArchestraToolFullName(
        TOOL_TRANSFER_WORKSPACE_FILE_SHORT_NAME,
      );
      const designatedTargetAgent = await makeAgent({
        name: "Encrypted Designated Subagent",
        organizationId,
        authorId: actorId,
        agentType: "agent",
        modelId,
        llmApiKeyId,
      });
      await SkillModel.createWithFiles({
        skill: {
          organizationId,
          name: "encrypted-designated-skill",
          description: "Delegates to Encrypted Designated Subagent.",
          content: "Run designated subagent task.",
          agentName: designatedTargetAgent.name,
          metadata: {},
          sourceType: "manual",
        },
        files: [],
        ...accessGrants("org"),
      });
      const designatedSkillToolName = `${SKILL_TOOL_PREFIX}encrypted_designated_skill`;
      const gatewaySkillCatalog = await makeInternalMcpCatalog({
        organizationId,
      });
      await makeMcpServer({
        catalogId: gatewaySkillCatalog.id,
        ownerId: actorId,
      });
      const gatewayListedSkillTool = await makeTool({
        catalogId: gatewaySkillCatalog.id,
        name: `${SKILL_TOOL_PREFIX}gateway_listed_helper`,
        description: "Gateway-listed skill delegation tool.",
      });
      const encryptedBlockedRegexQuery =
        "^(agent__|skill__|archestra__(start_agent_run|steer_agent_run|post_agent_run_message|post_agent_run_file|write_workspace_file))";

      const startRunDbTool = await ToolModel.findByName(
        TOOL_START_AGENT_RUN_FULL_NAME,
      );
      const steerRunDbTool = await ToolModel.findByName(
        TOOL_STEER_AGENT_RUN_FULL_NAME,
      );
      const postMessageDbTool = await ToolModel.findByName(
        TOOL_POST_AGENT_RUN_MESSAGE_FULL_NAME,
      );
      const postFileDbTool = await ToolModel.findByName(
        TOOL_POST_AGENT_RUN_FILE_FULL_NAME,
      );
      const writeWorkspaceFileDbTool = await ToolModel.findByName(
        writeWorkspaceFileToolName,
      );
      for (const dbTool of [
        startRunDbTool,
        steerRunDbTool,
        postMessageDbTool,
        postFileDbTool,
        writeWorkspaceFileDbTool,
        gatewayListedSkillTool,
      ]) {
        if (dbTool) {
          await AgentToolModel.create(fullEncryptedAgent.id, dbTool.id);
        }
      }
      const unencryptedFullConversation = await makeConversation(
        fullEncryptedAgent.id,
        {
          organizationId,
          userId: actorId,
        },
      );
      seedGatewayListClient(fullEncryptedAgent, unencryptedFullConversation.id);
      const unencryptedFullTools = await chatMcpClient.getChatMcpTools({
        agentName: fullEncryptedAgent.name,
        agentId: fullEncryptedAgent.id,
        userId: actorId,
        organizationId,
        conversationId: unencryptedFullConversation.id,
        sessionId: unencryptedFullConversation.id,
        suppressContentLogging: false,
        encryptedChatAudit: null,
      });
      expect(Object.keys(unencryptedFullTools)).toEqual(
        expect.arrayContaining([
          TOOL_START_AGENT_RUN_FULL_NAME,
          TOOL_STEER_AGENT_RUN_FULL_NAME,
          TOOL_POST_AGENT_RUN_MESSAGE_FULL_NAME,
          TOOL_POST_AGENT_RUN_FILE_FULL_NAME,
          writeWorkspaceFileToolName,
          designatedSkillToolName,
        ]),
      );

      const fullEncryptedConversation = await makeConversation(
        fullEncryptedAgent.id,
        {
          organizationId,
          userId: actorId,
          encryptedChat: true,
        },
      );
      seedGatewayListClient(fullEncryptedAgent, fullEncryptedConversation.id);
      const encryptedFullTools = await chatMcpClient.getChatMcpTools({
        agentName: fullEncryptedAgent.name,
        agentId: fullEncryptedAgent.id,
        userId: actorId,
        organizationId,
        conversationId: fullEncryptedConversation.id,
        sessionId: fullEncryptedConversation.id,
        suppressContentLogging: true,
        encryptedChatAudit: {
          dek: Buffer.alloc(32, 8),
          conversationId: fullEncryptedConversation.id,
        },
      });
      expect(Object.keys(encryptedFullTools)).not.toContain(
        TOOL_START_AGENT_RUN_FULL_NAME,
      );
      expect(Object.keys(encryptedFullTools)).not.toContain(
        TOOL_STEER_AGENT_RUN_FULL_NAME,
      );
      expect(Object.keys(encryptedFullTools)).not.toContain(
        TOOL_POST_AGENT_RUN_MESSAGE_FULL_NAME,
      );
      expect(Object.keys(encryptedFullTools)).not.toContain(
        TOOL_POST_AGENT_RUN_FILE_FULL_NAME,
      );
      expect(Object.keys(encryptedFullTools)).not.toContain(
        writeWorkspaceFileToolName,
      );
      expect(
        Object.keys(encryptedFullTools).some(
          (name) =>
            name.startsWith("agent__") || name.startsWith(SKILL_TOOL_PREFIX),
        ),
      ).toBe(false);

      const encryptedPrompt = await buildAgentSystemPrompt({
        agent: encryptedLbAgent,
        mcpTools: encryptedCompactTools,
        organizationId,
        userId: actorId,
        agentId: encryptedLbAgent.id,
        suppressContentLogging: true,
      });
      expect(encryptedPrompt ?? "").not.toContain(
        SUBAGENT_LOAD_BALANCING_INSTRUCTION,
      );

      // `search_tools` in encrypted chat must not discover `start_agent_run`,
      // `steer_agent_run`, `post_agent_run_message`, or `agent__*` in either
      // Auto-tools or explicitly assigned configurations.
      const encryptedContext: ArchestraContext = {
        agent: { id: encryptedLbAgent.id, name: encryptedLbAgent.name },
        agentId: encryptedLbAgent.id,
        userId: actorId,
        organizationId,
        conversationId: encryptedConversation.id,
        sessionId: encryptedConversation.id,
        suppressContentLogging: true,
        encryptedChatAudit,
      };
      for (const query of [
        "start agent run runtime",
        "steer agent run message",
        "post agent run message Slack thread",
        "post_agent_run_file upload thread",
        "write_workspace_file workspace",
      ]) {
        const searchRes = await executeArchestraTool(
          TOOL_SEARCH_TOOLS_FULL_NAME,
          { query, limit: 20 },
          encryptedContext,
        );
        expect(searchRes.isError).toBeFalsy();
        const discoveredNames = (
          (
            searchRes.structuredContent as
              | { tools?: Array<{ toolName: string }> }
              | undefined
          )?.tools ?? []
        ).map((t) => t.toolName);
        expect(discoveredNames).not.toContain(TOOL_START_AGENT_RUN_FULL_NAME);
        expect(discoveredNames).not.toContain(TOOL_STEER_AGENT_RUN_FULL_NAME);
        expect(discoveredNames).not.toContain(
          TOOL_POST_AGENT_RUN_MESSAGE_FULL_NAME,
        );
        expect(discoveredNames).not.toContain(
          TOOL_POST_AGENT_RUN_FILE_FULL_NAME,
        );
        expect(discoveredNames).not.toContain(writeWorkspaceFileToolName);
        expect(
          discoveredNames.some(
            (n) => n.startsWith("agent__") || n.startsWith(SKILL_TOOL_PREFIX),
          ),
        ).toBe(false);
      }

      // Auto-tools (`accessAllTools: true`) configuration with `start_agent_run`
      // assigned and `steer_agent_run` / `post_agent_run_message` dynamically
      // accessible (exclusions cleared): unencrypted `search_tools` discovers
      // them, while encrypted `search_tools` (`suppressContentLogging: true`)
      // excludes all three plus `agent__*`. Also check `mcp_gateway` implicit
      // runtime controls under `suppressContentLogging: true`.
      const autoEncryptedAgent = await makeAgent({
        name: "Encrypted Auto Tools Assistant",
        organizationId,
        authorId: actorId,
        agentType: "agent",
        accessAllTools: true,
        toolExposureMode: "search_and_run_only",
        accessAllSubagents: false,
        modelId,
        llmApiKeyId,
      });
      await AgentExcludedToolModel.replaceForAgent(autoEncryptedAgent.id, []);
      if (startRunDbTool) {
        await AgentToolModel.create(autoEncryptedAgent.id, startRunDbTool.id);
      }
      await AgentToolModel.create(
        autoEncryptedAgent.id,
        workerDelegationTool.id,
      );

      const unencryptedAutoSteerSearch = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        {
          query:
            "steer_agent_run post_agent_run_message post_agent_run_file write_workspace_file read_workspace_file",
          limit: 25,
        },
        {
          agent: { id: autoEncryptedAgent.id, name: autoEncryptedAgent.name },
          agentId: autoEncryptedAgent.id,
          userId: actorId,
          organizationId,
          suppressContentLogging: false,
        },
      );
      const unencryptedAutoNames = (
        (
          unencryptedAutoSteerSearch.structuredContent as
            | { tools?: Array<{ toolName: string }> }
            | undefined
        )?.tools ?? []
      ).map((t) => t.toolName);
      expect(unencryptedAutoNames).toContain(TOOL_STEER_AGENT_RUN_FULL_NAME);
      expect(unencryptedAutoNames).toContain(
        TOOL_POST_AGENT_RUN_MESSAGE_FULL_NAME,
      );
      expect(unencryptedAutoNames).toContain(
        TOOL_POST_AGENT_RUN_FILE_FULL_NAME,
      );
      expect(unencryptedAutoNames).toContain(writeWorkspaceFileToolName);
      expect(unencryptedAutoNames).toContain(readWorkspaceFileToolName);

      for (const query of [
        "start agent run runtime",
        "steer_agent_run message",
        "post_agent_run_message Slack thread",
        "post_agent_run_file upload thread",
        "write_workspace_file read_workspace_file workspace",
      ]) {
        const autoEncryptedSearch = await executeArchestraTool(
          TOOL_SEARCH_TOOLS_FULL_NAME,
          { query, limit: 25 },
          {
            agent: { id: autoEncryptedAgent.id, name: autoEncryptedAgent.name },
            agentId: autoEncryptedAgent.id,
            userId: actorId,
            organizationId,
            suppressContentLogging: true,
          },
        );
        expect(autoEncryptedSearch.isError).toBeFalsy();
        const autoEncryptedNames = (
          (
            autoEncryptedSearch.structuredContent as
              | { tools?: Array<{ toolName: string }> }
              | undefined
          )?.tools ?? []
        ).map((t) => t.toolName);
        expect(autoEncryptedNames).not.toContain(
          TOOL_START_AGENT_RUN_FULL_NAME,
        );
        expect(autoEncryptedNames).not.toContain(
          TOOL_STEER_AGENT_RUN_FULL_NAME,
        );
        expect(autoEncryptedNames).not.toContain(
          TOOL_POST_AGENT_RUN_MESSAGE_FULL_NAME,
        );
        expect(autoEncryptedNames).not.toContain(
          TOOL_POST_AGENT_RUN_FILE_FULL_NAME,
        );
        expect(autoEncryptedNames).not.toContain(writeWorkspaceFileToolName);
        expect(
          autoEncryptedNames.some(
            (n) => n.startsWith("agent__") || n.startsWith(SKILL_TOOL_PREFIX),
          ),
        ).toBe(false);
        if (query.includes("read_workspace_file")) {
          expect(autoEncryptedNames).toContain(readWorkspaceFileToolName);
        }

        const gatewayEncryptedSearch = await executeArchestraTool(
          TOOL_SEARCH_TOOLS_FULL_NAME,
          { query, limit: 25 },
          {
            agent: { id: gateway.id, name: gateway.name },
            agentId: gateway.id,
            userId: actorId,
            organizationId,
            suppressContentLogging: true,
          },
        );
        expect(gatewayEncryptedSearch.isError).toBeFalsy();
        const gatewayEncryptedNames = (
          (
            gatewayEncryptedSearch.structuredContent as
              | { tools?: Array<{ toolName: string }> }
              | undefined
          )?.tools ?? []
        ).map((t) => t.toolName);
        expect(gatewayEncryptedNames).not.toContain(
          TOOL_START_AGENT_RUN_FULL_NAME,
        );
        expect(gatewayEncryptedNames).not.toContain(
          TOOL_STEER_AGENT_RUN_FULL_NAME,
        );
        expect(gatewayEncryptedNames).not.toContain(
          TOOL_POST_AGENT_RUN_MESSAGE_FULL_NAME,
        );
        expect(gatewayEncryptedNames).not.toContain(
          TOOL_POST_AGENT_RUN_FILE_FULL_NAME,
        );
        expect(gatewayEncryptedNames).not.toContain(writeWorkspaceFileToolName);
        if (query.includes("read_workspace_file")) {
          expect(gatewayEncryptedNames).toContain(readWorkspaceFileToolName);
        }
      }

      // Attempting direct or `run_tool` launches (both implicit and explicitly assigned) must refuse
      // before creating any A2A tasks, A2A messages, or Agent Runtime runs.
      const launchSpy = vi.spyOn(backend, "launch");
      const sensitiveSecret = "encrypted-chat-sensitive-secret-do-not-persist";

      const implicitDirectAttempt = await executeArchestraTool(
        TOOL_START_AGENT_RUN_FULL_NAME,
        { message: sensitiveSecret },
        encryptedContext,
      );
      expect(implicitDirectAttempt.isError).toBe(true);

      const implicitRunToolAttempt = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: TOOL_START_AGENT_RUN_FULL_NAME,
          tool_args: { message: sensitiveSecret },
        },
        encryptedContext,
      );
      expect(implicitRunToolAttempt.isError).toBe(true);

      const assignedEncryptedContext: ArchestraContext = {
        agent: { id: fullEncryptedAgent.id, name: fullEncryptedAgent.name },
        agentId: fullEncryptedAgent.id,
        userId: actorId,
        organizationId,
        conversationId: fullEncryptedConversation.id,
        sessionId: fullEncryptedConversation.id,
        suppressContentLogging: true,
        encryptedChatAudit: {
          dek: Buffer.alloc(32, 8),
          conversationId: fullEncryptedConversation.id,
        },
      };
      for (const query of [
        "start agent run runtime",
        "steer agent run message",
        "post agent run message Slack thread",
        "post_agent_run_file upload thread",
        "write_workspace_file workspace",
      ]) {
        const assignedSearchRes = await executeArchestraTool(
          TOOL_SEARCH_TOOLS_FULL_NAME,
          { query, limit: 20 },
          assignedEncryptedContext,
        );
        expect(assignedSearchRes.isError).toBeFalsy();
        const assignedDiscoveredNames = (
          (
            assignedSearchRes.structuredContent as
              | { tools?: Array<{ toolName: string }> }
              | undefined
          )?.tools ?? []
        ).map((t) => t.toolName);
        expect(assignedDiscoveredNames).not.toContain(
          TOOL_START_AGENT_RUN_FULL_NAME,
        );
        expect(assignedDiscoveredNames).not.toContain(
          TOOL_STEER_AGENT_RUN_FULL_NAME,
        );
        expect(assignedDiscoveredNames).not.toContain(
          TOOL_POST_AGENT_RUN_MESSAGE_FULL_NAME,
        );
        expect(assignedDiscoveredNames).not.toContain(
          TOOL_POST_AGENT_RUN_FILE_FULL_NAME,
        );
        expect(assignedDiscoveredNames).not.toContain(
          writeWorkspaceFileToolName,
        );
        expect(
          assignedDiscoveredNames.some(
            (n) => n.startsWith("agent__") || n.startsWith(SKILL_TOOL_PREFIX),
          ),
        ).toBe(false);
      }
      const unencryptedSkillRegexSearch = await executeArchestraTool(
        TOOL_SEARCH_TOOLS_FULL_NAME,
        { mode: "regex", query: "^skill__", limit: 20 },
        {
          agent: { id: fullEncryptedAgent.id, name: fullEncryptedAgent.name },
          agentId: fullEncryptedAgent.id,
          userId: actorId,
          organizationId,
          conversationId: unencryptedFullConversation.id,
          sessionId: unencryptedFullConversation.id,
          suppressContentLogging: false,
        },
      );
      expect(unencryptedSkillRegexSearch.isError).toBeFalsy();
      const unencryptedSkillRegexNames = (
        (
          unencryptedSkillRegexSearch.structuredContent as
            | { tools?: Array<{ toolName: string }> }
            | undefined
        )?.tools ?? []
      ).map((t) => t.toolName);
      expect(unencryptedSkillRegexNames).toEqual(
        expect.arrayContaining([
          designatedSkillToolName,
          gatewayListedSkillTool.name,
        ]),
      );

      for (const searchCtx of [
        encryptedContext,
        {
          agent: { id: autoEncryptedAgent.id, name: autoEncryptedAgent.name },
          agentId: autoEncryptedAgent.id,
          userId: actorId,
          organizationId,
          suppressContentLogging: true,
        },
        {
          agent: { id: gateway.id, name: gateway.name },
          agentId: gateway.id,
          userId: actorId,
          organizationId,
          suppressContentLogging: true,
        },
        assignedEncryptedContext,
      ]) {
        const regexRes = await executeArchestraTool(
          TOOL_SEARCH_TOOLS_FULL_NAME,
          { mode: "regex", query: encryptedBlockedRegexQuery, limit: 20 },
          searchCtx,
        );
        expect(regexRes.isError).toBeFalsy();
        const regexNames = (
          (
            regexRes.structuredContent as
              | { tools?: Array<{ toolName: string }> }
              | undefined
          )?.tools ?? []
        ).map((t) => t.toolName);
        expect(regexNames).toEqual([]);
      }

      const assignedDirectAttempt = await executeArchestraTool(
        TOOL_START_AGENT_RUN_FULL_NAME,
        { message: sensitiveSecret },
        assignedEncryptedContext,
      );
      expect(assignedDirectAttempt.isError).toBe(true);
      expect(
        (assignedDirectAttempt.content[0] as { text?: string } | undefined)
          ?.text,
      ).toContain("not available in encrypted chats");

      const assignedRunToolAttempt = await executeArchestraTool(
        TOOL_RUN_TOOL_FULL_NAME,
        {
          tool_name: TOOL_START_AGENT_RUN_FULL_NAME,
          tool_args: { message: sensitiveSecret },
        },
        assignedEncryptedContext,
      );
      expect(assignedRunToolAttempt.isError).toBe(true);

      const unknownRunId = crypto.randomUUID();
      const autoEncryptedExecContext: ArchestraContext = {
        agent: { id: autoEncryptedAgent.id, name: autoEncryptedAgent.name },
        agentId: autoEncryptedAgent.id,
        userId: actorId,
        organizationId,
        conversationId: encryptedConversation.id,
        sessionId: encryptedConversation.id,
        suppressContentLogging: true,
        encryptedChatAudit,
      };
      for (const [blockedToolName, blockedToolArgs] of [
        [
          TOOL_POST_AGENT_RUN_FILE_FULL_NAME,
          {
            task_id: unknownRunId,
            filename: "secret.txt",
            content_base64: Buffer.from(sensitiveSecret, "utf8").toString(
              "base64",
            ),
            comment: sensitiveSecret,
          },
        ],
        [
          writeWorkspaceFileToolName,
          {
            run_id: unknownRunId,
            path: "notes/secret.txt",
            content: sensitiveSecret,
          },
        ],
        [
          transferWorkspaceFileToolName,
          {
            run_id: unknownRunId,
            direction: "upload",
            path: "notes/secret.txt",
            local_path: "/tmp/secret.txt",
            size: 16,
            sha256: "a".repeat(64),
          },
        ],
      ] as const) {
        const directBlocked = await executeArchestraTool(
          blockedToolName,
          blockedToolArgs,
          autoEncryptedExecContext,
        );
        expect(directBlocked.isError).toBe(true);
        expect(
          (directBlocked.content[0] as { text?: string } | undefined)?.text,
        ).toContain("not available in encrypted chats");

        const runToolBlocked = await executeArchestraTool(
          TOOL_RUN_TOOL_FULL_NAME,
          {
            tool_name: blockedToolName,
            tool_args: blockedToolArgs,
          },
          autoEncryptedExecContext,
        );
        expect(runToolBlocked.isError).toBe(true);
        expect(
          (runToolBlocked.content[0] as { text?: string } | undefined)?.text,
        ).toContain("not available in encrypted chats");
      }

      // Workspace downloads and reads remain permitted in encrypted chats (failing
      // on the unknown run handle rather than the encrypted-chat guard).
      const downloadAttempt = await executeArchestraTool(
        transferWorkspaceFileToolName,
        {
          run_id: unknownRunId,
          direction: "download",
          path: "reports/summary.md",
          local_path: "/tmp/summary.md",
        },
        autoEncryptedExecContext,
      );
      expect(downloadAttempt.isError).toBe(true);
      expect(
        (downloadAttempt.content[0] as { text?: string } | undefined)?.text,
      ).not.toContain("not available in encrypted chats");

      const readWorkspaceAttempt = await executeArchestraTool(
        readWorkspaceFileToolName,
        {
          run_id: unknownRunId,
          path: "reports/summary.md",
        },
        autoEncryptedExecContext,
      );
      expect(readWorkspaceAttempt.isError).toBe(true);
      expect(
        (readWorkspaceAttempt.content[0] as { text?: string } | undefined)
          ?.text,
      ).not.toContain("not available in encrypted chats");

      const delegationAttempt = await executeArchestraTool(
        workerDelegationTool.name,
        { message: sensitiveSecret },
        assignedEncryptedContext,
      );
      expect(delegationAttempt.isError).toBe(true);
      expect(
        (delegationAttempt.content[0] as { text?: string } | undefined)?.text,
      ).toContain("not available in encrypted chats");

      const skillDelegationAttempt = await executeArchestraTool(
        designatedSkillToolName,
        { message: sensitiveSecret },
        assignedEncryptedContext,
      );
      expect(skillDelegationAttempt.isError).toBe(true);
      expect(
        (skillDelegationAttempt.content[0] as { text?: string } | undefined)
          ?.text,
      ).toContain("not available in encrypted chats");

      expect(launchSpy).not.toHaveBeenCalled();

      const tasksRows = await db.select().from(schema.a2aTasksTable);
      expect(tasksRows).toHaveLength(0);
      const a2aMessageRows = await db.select().from(schema.a2aMessagesTable);
      expect(a2aMessageRows).toHaveLength(0);
      const agentRunRows = await db.select().from(schema.agentRunsTable);
      expect(agentRunRows).toHaveLength(0);
      const ordinaryChatMessageRows = await db
        .select()
        .from(schema.messagesTable);
      expect(ordinaryChatMessageRows).toHaveLength(0);
      const mcpToolCallRows = await db.select().from(schema.mcpToolCallsTable);
      expect(JSON.stringify(mcpToolCallRows)).not.toContain(sensitiveSecret);
    } finally {
      chatMcpClient.clearChatMcpClient(encryptedLbAgent.id);
      if (fullEncryptedAgentId) {
        chatMcpClient.clearChatMcpClient(fullEncryptedAgentId);
      }
      await chatMcpClient.__test.clearToolCache();
    }
  });

  test("keeps runtime worker agent__* tools advertised when start_agent_run is excluded in Auto-tools mode", async ({
    makeAgent,
  }) => {
    const workerAlpha = await createRuntimeSubagent(
      makeAgent,
      "Excluded Starter Alpha",
      false,
    );
    const workerBeta = await createRuntimeSubagent(
      makeAgent,
      "Excluded Starter Beta",
      false,
    );
    const alphaTool = await ToolModel.findOrCreateDelegationTool(
      workerAlpha.id,
    );
    const betaTool = await ToolModel.findOrCreateDelegationTool(workerBeta.id);

    const autoToolsLbAgent = await makeAgent({
      organizationId,
      name: "Auto Tools LB Excluded Starter",
      agentType: "agent",
      accessAllTools: true,
      accessAllSubagents: false,
      toolExposureMode: "search_and_run_only",
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    await AgentToolModel.create(autoToolsLbAgent.id, alphaTool.id);
    await AgentToolModel.create(autoToolsLbAgent.id, betaTool.id);

    const startRunTool = await ToolModel.findByName(
      TOOL_START_AGENT_RUN_FULL_NAME,
    );
    if (!startRunTool) {
      throw new Error("Expected seeded start_agent_run tool");
    }
    await AgentExcludedToolModel.replaceForAgent(autoToolsLbAgent.id, [
      startRunTool.id,
    ]);

    const gatewayAgent = await AgentModel.findGatewayAgentById(
      autoToolsLbAgent.id,
    );
    if (!gatewayAgent) {
      throw new Error("Expected gatewayAgent row");
    }

    const listed = await buildAgentMcpToolList({
      agent: gatewayAgent,
      tokenAuth: {
        tokenId: "tok-excluded-starter",
        teamId: null,
        isOrganizationToken: false,
        organizationId,
        userId: actorId,
      },
    });
    const listedNames = listed.tools.map((t) => t.name);
    expect(listedNames).not.toContain(TOOL_START_AGENT_RUN_FULL_NAME);

    // Because `start_agent_run` is excluded in Auto-tools mode, `getAgentTools`
    // and `search_tools` keep the assigned `agent__*` worker tools visible so the
    // caller retains an advertised runtime launch surface.
    const delegationTools = await getAgentTools({
      agentId: autoToolsLbAgent.id,
      organizationId,
      userId: actorId,
    });
    const delegationNames = delegationTools.map((t) => t.name);
    expect(delegationNames).toContain(alphaTool.name);
    expect(delegationNames).toContain(betaTool.name);

    const context: ArchestraContext = {
      agent: { id: autoToolsLbAgent.id, name: autoToolsLbAgent.name },
      agentId: autoToolsLbAgent.id,
      userId: actorId,
      organizationId,
    };
    const searchRes = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "Excluded Starter", limit: 20 },
      context,
    );
    expect(searchRes.isError).not.toBe(true);
    const searchText =
      (searchRes.content[0] as { text?: string } | undefined)?.text ?? "";
    expect(searchText).toContain(alphaTool.name);
    expect(searchText).toContain(betaTool.name);
    expect(searchText).not.toContain(TOOL_START_AGENT_RUN_FULL_NAME);

    const excludedStartAttempt = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "Should be blocked by tool exclusion" },
      context,
    );
    expect(excludedStartAttempt.isError).toBe(true);

    const prompt = await buildAgentSystemPrompt({
      agent: autoToolsLbAgent,
      mcpTools: {},
      organizationId,
      userId: actorId,
      agentId: autoToolsLbAgent.id,
    });
    expect(prompt ?? "").toContain("Subagent load balancing is enabled");
    expect(prompt ?? "").not.toContain("start_agent_run");
  });

  test("preserves runtime worker agent__* tools and load-balanced delegation when caller lacks agent:read RBAC for start_agent_run", async ({
    makeAgent,
    makeCustomRole,
    makeLlmProviderApiKey,
    makeMember,
    makeSecret,
    makeUser,
  }) => {
    const customRole = await makeCustomRole(organizationId, {
      permission: {
        chat: ["read", "create"],
      },
    });
    const restrictedUser = await makeUser();
    await makeMember(restrictedUser.id, organizationId, {
      role: customRole.role,
    });

    const sharedSecret = await makeSecret({
      secret: { apiKey: "test-shared-upstream-key" },
    });
    const sharedKey = await makeLlmProviderApiKey(
      organizationId,
      sharedSecret.id,
      {
        provider: "openai",
        access: { users: [restrictedUser.id], preset: "use" },
      },
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(sharedKey.id, [
      modelId,
    ]);

    const workerAlpha = await makeAgent({
      name: "RBAC Worker Alpha",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId: sharedKey.id,
      access: { users: [restrictedUser.id], preset: "use" },
      runtime: runtimeConfig({ maxTier: "M" }),
    });
    const workerBeta = await makeAgent({
      name: "RBAC Worker Beta",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId: sharedKey.id,
      access: { users: [restrictedUser.id], preset: "use" },
      runtime: runtimeConfig({ maxTier: "M" }),
    });
    const alphaTool = await ToolModel.findOrCreateDelegationTool(
      workerAlpha.id,
    );
    const betaTool = await ToolModel.findOrCreateDelegationTool(workerBeta.id);

    const lbAgent = await makeAgent({
      name: "RBAC LB Assistant",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      toolExposureMode: "full",
      accessAllSubagents: false,
      modelId,
      llmApiKeyId: sharedKey.id,
      access: { users: [restrictedUser.id], preset: "use" },
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    await AgentToolModel.create(lbAgent.id, alphaTool.id);
    await AgentToolModel.create(lbAgent.id, betaTool.id);

    const gatewayAgent = await AgentModel.findGatewayAgentById(lbAgent.id);
    if (!gatewayAgent) {
      throw new Error("Expected gatewayAgent row");
    }

    // `restrictedUser` lacks `agent:read`, so `start_agent_run` is filtered out,
    // while `agent__*` worker delegation tools remain visible and callable.
    const listed = await buildAgentMcpToolList({
      agent: gatewayAgent,
      tokenAuth: {
        tokenId: "tok-rbac-restricted",
        teamId: null,
        isOrganizationToken: false,
        organizationId,
        userId: restrictedUser.id,
      },
    });
    const listedNames = listed.tools.map((t) => t.name);
    expect(listedNames).not.toContain(TOOL_START_AGENT_RUN_FULL_NAME);
    expect(listedNames).toContain(alphaTool.name);
    expect(listedNames).toContain(betaTool.name);

    const delegationTools = await getAgentTools({
      agentId: lbAgent.id,
      organizationId,
      userId: restrictedUser.id,
    });
    expect(delegationTools.map((t) => t.name)).toEqual(
      expect.arrayContaining([alphaTool.name, betaTool.name]),
    );

    const restrictedContext: ArchestraContext = {
      agent: { id: lbAgent.id, name: lbAgent.name },
      agentId: lbAgent.id,
      userId: restrictedUser.id,
      organizationId,
    };
    const searchRes = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "RBAC Worker", limit: 20 },
      restrictedContext,
    );
    expect(searchRes.isError).not.toBe(true);
    const searchNames = (
      (
        searchRes.structuredContent as
          | { tools?: Array<{ toolName: string }> }
          | undefined
      )?.tools ?? []
    ).map((t) => t.toolName);
    expect(searchNames).toContain(alphaTool.name);
    expect(searchNames).toContain(betaTool.name);
    expect(searchNames).not.toContain(TOOL_START_AGENT_RUN_FULL_NAME);

    const directStartDenied = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "Should fail RBAC" },
      restrictedContext,
    );
    expect(directStartDenied.isError).toBe(true);

    const prompt = await buildAgentSystemPrompt({
      agent: lbAgent,
      mcpTools: {},
      organizationId,
      userId: restrictedUser.id,
      agentId: lbAgent.id,
    });
    expect(prompt ?? "").toContain("Subagent load balancing is enabled");
    expect(prompt ?? "").not.toContain("start_agent_run");

    await mockDetachedTaskStart();
    const r1 = await executeArchestraTool(
      alphaTool.name,
      { message: "Restricted LB task 1" },
      restrictedContext,
    );
    const r2 = await executeArchestraTool(
      alphaTool.name,
      { message: "Restricted LB task 2" },
      restrictedContext,
    );
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    const a1 = (r1.structuredContent as { run: { agent_id: string } }).run
      .agent_id;
    const a2 = (r2.structuredContent as { run: { agent_id: string } }).run
      .agent_id;
    expect(new Set([a1, a2])).toEqual(new Set([workerAlpha.id, workerBeta.id]));
  });

  test("persists McpToolCallModel row and reconstructs push move when run_tool invokes a load-balanced router delegation", async ({
    makeAgent,
    makeConversation,
  }) => {
    const workerAlpha = await createRuntimeSubagent(
      makeAgent,
      "RunTool Router Worker Alpha",
      false,
    );
    const workerBeta = await createRuntimeSubagent(
      makeAgent,
      "RunTool Router Worker Beta",
      false,
    );
    const alphaTool = await ToolModel.findOrCreateDelegationTool(
      workerAlpha.id,
    );
    const betaTool = await ToolModel.findOrCreateDelegationTool(workerBeta.id);

    const routerAgent = await makeAgent({
      name: "RunTool Foreground Router",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: false,
      modelId,
      llmApiKeyId,
      runtime: null,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    await AgentToolModel.create(routerAgent.id, alphaTool.id);
    await AgentToolModel.create(routerAgent.id, betaTool.id);
    const routerToolRow = await ToolModel.findOrCreateDelegationTool(
      routerAgent.id,
    );

    const compactCaller = await makeAgent({
      name: "Compact RunTool Caller",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      toolExposureMode: "search_and_run_only",
      accessAllSubagents: false,
      modelId,
      llmApiKeyId,
    });
    await AgentToolModel.create(compactCaller.id, routerToolRow.id);

    const launchedWorkloads: string[] = [];
    vi.spyOn(backend, "launch").mockImplementation(async (spec) => {
      launchedWorkloads.push(spec.frozenName);
    });
    vi.spyOn(backend, "stageInputs").mockResolvedValue();
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
    vi.spyOn(backend, "steer").mockResolvedValue();
    vi.spyOn(backend, "teardown").mockResolvedValue();
    vi.spyOn(backend, "releaseRun").mockResolvedValue();
    vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);

    const callerConversation = await makeConversation(compactCaller.id, {
      organizationId,
      userId: actorId,
    });
    const chatCtx: ChatToolContext = {
      agentId: compactCaller.id,
      agentName: compactCaller.name,
      userId: actorId,
      organizationId,
      conversationId: callerConversation.id,
      sessionId: callerConversation.id,
      mcpGwToken: {
        tokenValue: null,
        tokenId: "tok-run-tool-router",
        teamId: null,
        isOrganizationToken: false,
        isUserToken: true,
      },
      repeatTracker: new ToolCallRepeatTracker(),
      modelAcceptsImageToolResults: true,
    };
    const wrappedRunTool = buildMcpGatewayTool({
      mcpTool: {
        name: TOOL_RUN_TOOL_FULL_NAME,
        description: "Dispatch discovered tool",
        inputSchema: {
          type: "object",
          properties: {
            tool_name: { type: "string" },
            tool_args: { type: "object" },
          },
          required: ["tool_name"],
        },
      },
      ctx: chatCtx,
    });

    const rawResult = await wrappedRunTool.execute?.(
      {
        tool_name: routerToolRow.name,
        tool_args: { message: "Dispatch router via run_tool" },
      },
      { toolCallId: "run-tool-router-call-1", messages: [] },
    );
    const resultText =
      typeof rawResult === "string"
        ? rawResult
        : String((rawResult as { content?: unknown })?.content ?? "");
    const parsedLaunch = JSON.parse(resultText) as {
      run: { run_id: string; agent_id: string };
    };
    expect([workerAlpha.id, workerBeta.id]).toContain(
      parsedLaunch.run.agent_id,
    );
    expect(chatCtx.launchedRunIds).toEqual(new Set([parsedLaunch.run.run_id]));
    await vi.waitFor(() => {
      expect(launchedWorkloads).toHaveLength(1);
    });

    const handoffs = await getSessionHandoffs({
      organizationId,
      sessionId: callerConversation.id,
      ownUserId: actorId,
    });
    expect(handoffs.handedTo.map((r) => r.runId)).toContain(
      parsedLaunch.run.run_id,
    );
    expect(handoffs.moves).toContainEqual(
      expect.objectContaining({
        kind: "push",
        runId: parsedLaunch.run.run_id,
      }),
    );
  });

  test("omits runtime-pool start_agent_run prompt instruction when load-balanced agent has zero eligible runtime candidates", async ({
    makeAgent,
  }) => {
    const inProcessHelper = await makeAgent({
      name: "Zero Pool In-Process Helper",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId,
      runtime: null,
    });
    const inProcessHelperTool = await ToolModel.findOrCreateDelegationTool(
      inProcessHelper.id,
    );

    const zeroRuntimeLbAgent = await makeAgent({
      name: "Zero Pool LB Agent",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: false,
      modelId,
      llmApiKeyId,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    await AgentToolModel.create(zeroRuntimeLbAgent.id, inProcessHelperTool.id);

    const zeroPoolPrompt = await buildAgentSystemPrompt({
      agent: zeroRuntimeLbAgent,
      mcpTools: {},
      organizationId,
      userId: actorId,
      agentId: zeroRuntimeLbAgent.id,
    });
    expect(zeroPoolPrompt ?? "").not.toContain(
      SUBAGENT_LOAD_BALANCING_INSTRUCTION,
    );
    expect(zeroPoolPrompt ?? "").not.toContain("start_agent_run");
    expect(zeroPoolPrompt ?? "").not.toContain(
      "Subagent load balancing is enabled",
    );

    // Also verify Auto-subagents mode when all runtime workers are excluded:
    const excludedWorker = await createRuntimeSubagent(
      makeAgent,
      "All Excluded Runtime Worker",
      false,
    );
    const autoExcludedLbAgent = await makeAgent({
      name: "Auto Excluded All Workers LB Agent",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: true,
      modelId,
      llmApiKeyId,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    // Exclude every runtime subagent in the organization so 0 runtime candidates remain
    const allOrgAgents = await db.select().from(schema.agentsTable);
    await AgentExcludedSubagentModel.replaceForAgent(
      autoExcludedLbAgent.id,
      allOrgAgents
        .filter((row) => row.id !== autoExcludedLbAgent.id)
        .map((row) => row.id),
    );
    expect(excludedWorker.id).toBeTruthy();

    const autoExcludedPrompt = await buildAgentSystemPrompt({
      agent: autoExcludedLbAgent,
      mcpTools: {},
      organizationId,
      userId: actorId,
      agentId: autoExcludedLbAgent.id,
    });
    expect(autoExcludedPrompt ?? "").not.toContain(
      SUBAGENT_LOAD_BALANCING_INSTRUCTION,
    );
    expect(autoExcludedPrompt ?? "").not.toContain("start_agent_run");
    expect(autoExcludedPrompt ?? "").not.toContain(
      "Subagent load balancing is enabled",
    );
  });

  test("filters manual router pool notices and candidate selection by actor agent access", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeMember,
    makeSecret,
    makeUser,
  }) => {
    const memberUser = await makeUser();
    await makeMember(memberUser.id, organizationId, { role: "member" });

    const sharedSecret = await makeSecret({
      secret: { apiKey: "test-manual-access-key" },
    });
    const sharedKey = await makeLlmProviderApiKey(
      organizationId,
      sharedSecret.id,
      {
        provider: "openai",
        access: { users: [actorId, memberUser.id], preset: "use" },
      },
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(sharedKey.id, [
      modelId,
    ]);

    // Assigned first so without actor-access filtering it would be tried first and leaked in notices
    const privateTeamWorker = await makeAgent({
      name: "Confidential Team B Worker",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId: sharedKey.id,
      access: { users: [actorId], preset: "use" },
      runtime: runtimeConfig({ maxTier: "M" }),
    });
    const sharedTeamWorker = await makeAgent({
      name: "Shared Team A Worker",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId: sharedKey.id,
      access: { users: [actorId, memberUser.id], preset: "use" },
      runtime: runtimeConfig({ maxTier: "M" }),
    });
    const privateWorkerTool = await ToolModel.findOrCreateDelegationTool(
      privateTeamWorker.id,
    );
    const sharedWorkerTool = await ToolModel.findOrCreateDelegationTool(
      sharedTeamWorker.id,
    );

    const manualRouter = await makeAgent({
      name: "Team Scoped Manual Router",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: false,
      modelId,
      llmApiKeyId: sharedKey.id,
      access: { users: [actorId, memberUser.id], preset: "use" },
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    const privateAssignment = await AgentToolModel.create(
      manualRouter.id,
      privateWorkerTool.id,
    );
    await db
      .update(schema.agentToolsTable)
      .set({ createdAt: new Date(Date.now() - 10_000) })
      .where(eq(schema.agentToolsTable.id, privateAssignment.id));
    await AgentToolModel.create(manualRouter.id, sharedWorkerTool.id);
    const manualRouterTool = await ToolModel.findOrCreateDelegationTool(
      manualRouter.id,
    );

    // Also create a manual router whose ONLY runtime worker is inaccessible to `memberUser`
    const inaccessibleOnlyRouter = await makeAgent({
      name: "Inaccessible Pool Only Router",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: false,
      modelId,
      llmApiKeyId: sharedKey.id,
      access: { users: [actorId, memberUser.id], preset: "use" },
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    await AgentToolModel.create(
      inaccessibleOnlyRouter.id,
      privateWorkerTool.id,
    );
    const inaccessibleOnlyRouterTool =
      await ToolModel.findOrCreateDelegationTool(inaccessibleOnlyRouter.id);

    const customCaller = await makeAgent({
      name: "Custom Foreground Caller",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: false,
      modelId,
      llmApiKeyId: sharedKey.id,
      access: { users: [actorId, memberUser.id], preset: "use" },
    });
    await AgentToolModel.create(customCaller.id, manualRouterTool.id);
    await AgentToolModel.create(customCaller.id, inaccessibleOnlyRouterTool.id);

    const autoCaller = await makeAgent({
      name: "Auto Foreground Caller",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      accessAllSubagents: true,
      modelId,
      llmApiKeyId: sharedKey.id,
      access: { users: [actorId, memberUser.id], preset: "use" },
    });

    // Non-admin member in Custom mode: sees Shared Team A Worker, NOT Confidential Team B Worker
    const memberCustomTools = await getAgentTools({
      agentId: customCaller.id,
      organizationId,
      userId: memberUser.id,
    });
    const memberCustomRouter = memberCustomTools.find(
      (t) => t.name === manualRouterTool.name,
    );
    expect(memberCustomRouter?.description).toContain(
      "across its runtime pool (Shared Team A Worker)",
    );
    expect(memberCustomRouter?.description).not.toContain(
      "Confidential Team B Worker",
    );
    const memberInaccessibleRouter = memberCustomTools.find(
      (t) => t.name === inaccessibleOnlyRouterTool.name,
    );
    expect(memberInaccessibleRouter?.description).not.toContain(
      "Confidential Team B Worker",
    );
    expect(memberInaccessibleRouter?.description).not.toContain(
      "across its runtime pool",
    );
    expect(
      memberInaccessibleRouter?._meta?.[LOAD_BALANCED_RUNTIME_ROUTER_META_KEY],
    ).toBeUndefined();

    // Non-admin member in Auto mode: same actor-scoped filtering
    const memberAutoTools = await getAgentTools({
      agentId: autoCaller.id,
      organizationId,
      userId: memberUser.id,
    });
    const memberAutoRouter = memberAutoTools.find(
      (t) => t.name === manualRouterTool.name,
    );
    expect(memberAutoRouter?.description).toContain(
      "across its runtime pool (Shared Team A Worker)",
    );
    expect(memberAutoRouter?.description).not.toContain(
      "Confidential Team B Worker",
    );

    // Admin and elevated real-user (`skipAccessCheck: true`) flows see both workers;
    // non-user `"system"` turns execute routers in-process and omit runtime-pool metadata.
    const adminCustomTools = await getAgentTools({
      agentId: customCaller.id,
      organizationId,
      userId: actorId,
    });
    expect(
      adminCustomTools.find((t) => t.name === manualRouterTool.name)
        ?.description,
    ).toContain(
      "across its runtime pool (Confidential Team B Worker, Shared Team A Worker)",
    );
    const elevatedUserTools = await getAgentTools({
      agentId: customCaller.id,
      organizationId,
      userId: memberUser.id,
      skipAccessCheck: true,
    });
    expect(
      elevatedUserTools.find((t) => t.name === manualRouterTool.name)
        ?.description,
    ).toContain(
      "across its runtime pool (Confidential Team B Worker, Shared Team A Worker)",
    );
    const systemCustomTools = await getAgentTools({
      agentId: customCaller.id,
      organizationId,
      userId: "system",
      skipAccessCheck: true,
    });
    expect(
      systemCustomTools.find((t) => t.name === manualRouterTool.name)
        ?.description,
    ).not.toContain("Runs in the background in Agent Runtime");

    // Even with privateTeamWorker listed first, memberUser's delegation
    // dispatches cleanly to sharedTeamWorker.
    await mockDetachedTaskStart();
    const delegated = await executeArchestraTool(
      manualRouterTool.name,
      { message: "Run accessible worker only" },
      {
        agent: { id: customCaller.id, name: customCaller.name },
        agentId: customCaller.id,
        userId: memberUser.id,
        organizationId,
      },
    );
    expect(delegated.isError).toBeFalsy();
    expect(delegated.structuredContent).toMatchObject({
      run: { agent_id: sharedTeamWorker.id },
    });
  });

  test("reconstructs direct and run_tool delegation push handoffs under full white-labeling", async ({
    makeAgent,
    makeConversation,
  }) => {
    const previousWhiteLabeling = config.enterpriseFeatures.fullWhiteLabeling;
    config.enterpriseFeatures.fullWhiteLabeling = true;
    await OrganizationModel.patch(organizationId, { appName: "Acme Cloud" });
    archestraMcpBranding.syncFromOrganization({
      appName: "Acme Cloud",
      iconLogo: null,
    });

    try {
      expect(archestraMcpBranding.serverName).toBe("acme_cloud");

      const workerAlpha = await createRuntimeSubagent(
        makeAgent,
        "Branded Handoff Worker Alpha",
        false,
      );
      const workerBeta = await createRuntimeSubagent(
        makeAgent,
        "Branded Handoff Worker Beta",
        false,
      );
      const alphaTool = await ToolModel.findOrCreateDelegationTool(
        workerAlpha.id,
      );
      const betaTool = await ToolModel.findOrCreateDelegationTool(
        workerBeta.id,
      );

      const routerAgent = await makeAgent({
        name: "Branded Handoff Router",
        organizationId,
        authorId: actorId,
        agentType: "agent",
        accessAllSubagents: false,
        modelId,
        llmApiKeyId,
        subagentLoadBalancing: {
          enabled: true,
          algorithm: "round_robin",
        },
      });
      await AgentToolModel.create(routerAgent.id, alphaTool.id);
      await AgentToolModel.create(routerAgent.id, betaTool.id);
      const routerToolRow = await ToolModel.findOrCreateDelegationTool(
        routerAgent.id,
      );

      const callerAgent = await makeAgent({
        name: "Branded Foreground Caller",
        organizationId,
        authorId: actorId,
        agentType: "agent",
        toolExposureMode: "search_and_run_only",
        accessAllSubagents: false,
        modelId,
        llmApiKeyId,
      });
      await AgentToolModel.create(callerAgent.id, routerToolRow.id);

      const advertisedTools = await getAgentTools({
        agentId: callerAgent.id,
        organizationId,
        userId: actorId,
      });
      const advertisedRouter = advertisedTools.find(
        (t) => t.name === routerToolRow.name,
      );
      if (!advertisedRouter) {
        throw new Error("Expected advertised router delegation tool");
      }

      const launchedWorkloads: string[] = [];
      vi.spyOn(backend, "launch").mockImplementation(async (spec) => {
        launchedWorkloads.push(spec.frozenName);
      });
      vi.spyOn(backend, "stageInputs").mockResolvedValue();
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
      vi.spyOn(backend, "steer").mockResolvedValue();
      vi.spyOn(backend, "teardown").mockResolvedValue();
      vi.spyOn(backend, "releaseRun").mockResolvedValue();
      vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);

      const conversation = await makeConversation(callerAgent.id, {
        organizationId,
        userId: actorId,
      });
      const chatCtx: ChatToolContext = {
        agentId: callerAgent.id,
        agentName: callerAgent.name,
        userId: actorId,
        organizationId,
        conversationId: conversation.id,
        sessionId: conversation.id,
        mcpGwToken: {
          tokenValue: null,
          tokenId: "tok-branded-handoff",
          teamId: null,
          isOrganizationToken: false,
          isUserToken: true,
        },
        repeatTracker: new ToolCallRepeatTracker(),
        modelAcceptsImageToolResults: true,
      };

      const wrappedDirectRouter = buildAgentDelegationTool({
        agentTool: advertisedRouter,
        ctx: chatCtx,
      });
      const directRaw = await wrappedDirectRouter.execute?.(
        { message: "Direct branded router launch" },
        { toolCallId: "branded-direct-call-1", messages: [] },
      );
      const directLaunch = JSON.parse(String(directRaw)) as {
        run: { run_id: string };
      };

      const brandedRunToolName = archestraMcpBranding.getToolName("run_tool");
      expect(brandedRunToolName).toBe("acme_cloud__run_tool");
      const wrappedBrandedRunTool = buildMcpGatewayTool({
        mcpTool: {
          name: brandedRunToolName,
          description: "Execute tool by name",
          inputSchema: {
            type: "object",
            properties: {
              tool_name: { type: "string" },
              tool_args: { type: "object" },
            },
            required: ["tool_name"],
          },
        },
        ctx: chatCtx,
      });
      const runToolRaw = await wrappedBrandedRunTool.execute?.(
        {
          tool_name: routerToolRow.name,
          tool_args: { message: "Branded run_tool router launch" },
        },
        { toolCallId: "branded-run-tool-call-2", messages: [] },
      );
      const runToolText =
        typeof runToolRaw === "string"
          ? runToolRaw
          : String((runToolRaw as { content?: unknown })?.content ?? "");
      const indirectLaunch = JSON.parse(runToolText) as {
        run: { run_id: string };
      };
      await vi.waitFor(() => {
        expect(launchedWorkloads).toHaveLength(2);
      });

      const handoffs = await getSessionHandoffs({
        organizationId,
        sessionId: conversation.id,
        ownUserId: actorId,
      });
      expect(handoffs.handedTo.map((r) => r.runId)).toEqual(
        expect.arrayContaining([
          directLaunch.run.run_id,
          indirectLaunch.run.run_id,
        ]),
      );
      expect(handoffs.moves).toContainEqual(
        expect.objectContaining({
          kind: "push",
          runId: directLaunch.run.run_id,
        }),
      );
      expect(handoffs.moves).toContainEqual(
        expect.objectContaining({
          kind: "push",
          runId: indirectLaunch.run.run_id,
        }),
      );
    } finally {
      config.enterpriseFeatures.fullWhiteLabeling = previousWhiteLabeling;
      await OrganizationModel.patch(organizationId, { appName: null });
      archestraMcpBranding.syncFromOrganization(null);
    }
  });

  test("gates pooled-starter system prompt on callable start_agent_run rather than stale or unassigned mcpTools entries", async ({
    makeAgent,
    makeCustomRole,
    makeLlmProviderApiKey,
    makeMember,
    makeSecret,
    makeUser,
  }) => {
    const sharedSecret = await makeSecret({
      secret: { apiKey: "test-prompt-gate-key" },
    });
    const sharedKey = await makeLlmProviderApiKey(
      organizationId,
      sharedSecret.id,
      {
        provider: "openai",
        access: "org",
      },
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(sharedKey.id, [
      modelId,
    ]);

    const workerAlpha = await makeAgent({
      name: "Prompt Gate Worker Alpha",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId: sharedKey.id,
      access: "org",
      runtime: runtimeConfig({ maxTier: "M" }),
    });
    const workerBeta = await makeAgent({
      name: "Prompt Gate Worker Beta",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      modelId,
      llmApiKeyId: sharedKey.id,
      access: "org",
      runtime: runtimeConfig({ maxTier: "M" }),
    });
    const alphaTool = await ToolModel.findOrCreateDelegationTool(
      workerAlpha.id,
    );
    const betaTool = await ToolModel.findOrCreateDelegationTool(workerBeta.id);

    // Custom-mode (`accessAllTools: false`) load-balanced agent with two assigned
    // runtime workers and NO `start_agent_run` row in `agent_tools`.
    const customLbAgent = await makeAgent({
      name: "Custom Prompt Gate LB Agent",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      toolExposureMode: "full",
      accessAllTools: false,
      accessAllSubagents: false,
      modelId,
      llmApiKeyId: sharedKey.id,
      access: "org",
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    await AgentToolModel.create(customLbAgent.id, alphaTool.id);
    await AgentToolModel.create(customLbAgent.id, betaTool.id);

    const staleToolMap: Record<string, AiTool> = {
      [TOOL_START_AGENT_RUN_FULL_NAME]: {} as AiTool,
    };

    // 1. System actor (ChatOps / schedule turn) with `start_agent_run` present in `mcpTools`:
    //    `start_agent_run` is rejected at execution, so the prompt must emit the delegation
    //    fallback rather than steering the model to `start_agent_run`.
    const systemContext: ArchestraContext = {
      agent: { id: customLbAgent.id, name: customLbAgent.name },
      agentId: customLbAgent.id,
      userId: "system",
      organizationId,
    };
    const systemStartDenied = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "System turn cannot call unassigned start_agent_run" },
      systemContext,
    );
    expect(systemStartDenied.isError).toBe(true);

    const systemPrompt = await buildAgentSystemPrompt({
      agent: customLbAgent,
      mcpTools: staleToolMap,
      organizationId,
      userId: "system",
      agentId: customLbAgent.id,
    });
    expect(systemPrompt ?? "").toContain("Subagent load balancing is enabled");
    expect(systemPrompt ?? "").not.toContain("start_agent_run");
    expect(systemPrompt ?? "").toContain(
      "delegate new runtime tasks immediately in a single delegation call",
    );

    // 2. Restricted user lacking `agent:read` with stale `start_agent_run` in `mcpTools`:
    //    `start_agent_run` is rejected, the prompt emits the delegation fallback instruction,
    //    and `agent__*` delegation launches across the load-balanced runtime pool.
    const noAgentReadRole = await makeCustomRole(organizationId, {
      permission: { chat: ["read", "create"] },
    });
    const restrictedUser = await makeUser();
    await makeMember(restrictedUser.id, organizationId, {
      role: noAgentReadRole.role,
    });
    const restrictedContext: ArchestraContext = {
      agent: { id: customLbAgent.id, name: customLbAgent.name },
      agentId: customLbAgent.id,
      userId: restrictedUser.id,
      organizationId,
    };
    const restrictedStartDenied = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "Restricted user cannot call start_agent_run" },
      restrictedContext,
    );
    expect(restrictedStartDenied.isError).toBe(true);

    const restrictedPrompt = await buildAgentSystemPrompt({
      agent: customLbAgent,
      mcpTools: staleToolMap,
      organizationId,
      userId: restrictedUser.id,
      agentId: customLbAgent.id,
    });
    expect(restrictedPrompt ?? "").toContain(
      "Subagent load balancing is enabled",
    );
    expect(restrictedPrompt ?? "").not.toContain("start_agent_run");
    expect(restrictedPrompt ?? "").toContain(
      "delegate new runtime tasks immediately in a single delegation call",
    );

    await mockDetachedTaskStart();
    const resDel1 = await executeArchestraTool(
      alphaTool.name,
      { message: "Restricted delegated runtime task 1" },
      restrictedContext,
    );
    const resDel2 = await executeArchestraTool(
      alphaTool.name,
      { message: "Restricted delegated runtime task 2" },
      restrictedContext,
    );
    expect(resDel1.isError).toBeFalsy();
    expect(resDel2.isError).toBeFalsy();
    expect(
      new Set([
        (resDel1.structuredContent as { run: { agent_id: string } }).run
          .agent_id,
        (resDel2.structuredContent as { run: { agent_id: string } }).run
          .agent_id,
      ]),
    ).toEqual(new Set([workerAlpha.id, workerBeta.id]));

    // 3. OAuth application turn (`oauthClientId` set): Agent Runtime is disallowed,
    //    so neither `start_agent_run` nor runtime delegation instructions are emitted.
    const oauthPrompt = await buildAgentSystemPrompt({
      agent: customLbAgent,
      mcpTools: staleToolMap,
      organizationId,
      userId: actorId,
      oauthClientId: "oauth-app-client",
      agentId: customLbAgent.id,
    });
    expect(oauthPrompt ?? "").not.toContain("start_agent_run");
    expect(oauthPrompt ?? "").not.toContain(
      "Subagent load balancing is enabled",
    );

    // 4. Auto-tools agent excluding `start_agent_run` with a stale `mcpTools` entry:
    //    still receives the delegation fallback instruction rather than `start_agent_run`.
    const autoExcludedToolsAgent = await makeAgent({
      name: "Auto Tools Excluded Starter LB Agent",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      toolExposureMode: "full",
      accessAllTools: true,
      accessAllSubagents: false,
      modelId,
      llmApiKeyId: sharedKey.id,
      access: "org",
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    await AgentToolModel.create(autoExcludedToolsAgent.id, alphaTool.id);
    await AgentToolModel.create(autoExcludedToolsAgent.id, betaTool.id);
    const startRunTool = await ToolModel.findByName(
      TOOL_START_AGENT_RUN_FULL_NAME,
    );
    if (!startRunTool) {
      throw new Error("Expected seeded start_agent_run tool");
    }
    await AgentExcludedToolModel.replaceForAgent(autoExcludedToolsAgent.id, [
      startRunTool.id,
    ]);
    const excludedStalePrompt = await buildAgentSystemPrompt({
      agent: autoExcludedToolsAgent,
      mcpTools: staleToolMap,
      organizationId,
      userId: actorId,
      agentId: autoExcludedToolsAgent.id,
    });
    expect(excludedStalePrompt ?? "").toContain(
      "Subagent load balancing is enabled",
    );
    expect(excludedStalePrompt ?? "").not.toContain("start_agent_run");

    // 5. Real user with `agent:read` on the custom-mode agent: implicit pooled starter
    //    IS callable, so `SUBAGENT_LOAD_BALANCING_INSTRUCTION` is emitted and execution succeeds.
    const permittedUserPrompt = await buildAgentSystemPrompt({
      agent: customLbAgent,
      mcpTools: staleToolMap,
      organizationId,
      userId: actorId,
      agentId: customLbAgent.id,
    });
    expect(permittedUserPrompt).toContain(SUBAGENT_LOAD_BALANCING_INSTRUCTION);
    const permittedStart = await executeArchestraTool(
      TOOL_START_AGENT_RUN_FULL_NAME,
      { message: "Permitted user starts pooled runtime run" },
      {
        agent: { id: customLbAgent.id, name: customLbAgent.name },
        agentId: customLbAgent.id,
        userId: actorId,
        organizationId,
      },
    );
    expect(permittedStart.isError).toBeFalsy();
  });

  test("aligns service-account gateway tool listing, Auto-router metadata, and runtime actor identity", async ({
    makeAgent,
    makeCustomRole,
    makeLlmProviderApiKey,
    makeSecret,
    makeServiceAccount,
  }) => {
    const sharedSecret = await makeSecret({
      secret: { apiKey: "test-sa-gateway-key" },
    });
    const sharedKey = await makeLlmProviderApiKey(
      organizationId,
      sharedSecret.id,
      {
        provider: "openai",
        access: "org",
      },
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(sharedKey.id, [
      modelId,
    ]);

    const workerAlpha = await makeAgent({
      name: "SA Pool Alpha",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      access: "org",
      modelId,
      llmApiKeyId: sharedKey.id,
      runtime: runtimeConfig(),
    });
    const workerBeta = await makeAgent({
      name: "SA Pool Beta",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      access: "org",
      modelId,
      llmApiKeyId: sharedKey.id,
      runtime: runtimeConfig(),
    });
    const inProcessHelper = await makeAgent({
      name: "SA Helper",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      access: "org",
      modelId,
      llmApiKeyId: sharedKey.id,
    });

    const alphaTool = await ToolModel.findOrCreateDelegationTool(
      workerAlpha.id,
    );
    const betaTool = await ToolModel.findOrCreateDelegationTool(workerBeta.id);
    const helperTool = await ToolModel.findOrCreateDelegationTool(
      inProcessHelper.id,
    );

    const lbGateway = await makeAgent({
      name: "SA Load Balanced Gateway",
      organizationId,
      authorId: actorId,
      agentType: "mcp_gateway",
      toolExposureMode: "full",
      access: "org",
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    await AgentToolModel.create(lbGateway.id, alphaTool.id);
    await AgentToolModel.create(lbGateway.id, betaTool.id);
    await AgentToolModel.create(lbGateway.id, helperTool.id);

    const role = await makeCustomRole(organizationId, {
      permission: {
        agent: ["read", "use"],
      },
    });
    const account = await makeServiceAccount(organizationId, {
      role: role.role,
    });
    const bareServiceAccountAuth = {
      tokenId: crypto.randomUUID(),
      teamId: null,
      isOrganizationToken: false,
      serviceAccountId: account.id,
      organizationId,
      isUserToken: false,
    };

    const saLbList = await buildAgentMcpToolList({
      agent: lbGateway,
      tokenAuth: bareServiceAccountAuth,
    });
    const saLbNames = saLbList.tools.map((tool) => tool.name);
    expect(saLbNames).toContain(TOOL_START_AGENT_RUN_FULL_NAME);
    expect(saLbNames).not.toContain(alphaTool.name);
    expect(saLbNames).not.toContain(betaTool.name);
    expect(saLbNames).toContain(helperTool.name);

    // Machine OAuth client_credentials backed by a service account cannot use
    // Agent Runtime, so `start_agent_run` is omitted and worker visibility
    // stays consistent with `includeImplicitStartAgentRun === false`.
    const oauthAppAuth = {
      ...bareServiceAccountAuth,
      oauthClientId: "oauth-machine-client",
      isUserToken: false,
    };
    const oauthLbList = await buildAgentMcpToolList({
      agent: lbGateway,
      tokenAuth: oauthAppAuth,
    });
    const oauthLbNames = oauthLbList.tools.map((tool) => tool.name);
    expect(oauthLbNames).not.toContain(TOOL_START_AGENT_RUN_FULL_NAME);
    expect(oauthLbNames).toContain(alphaTool.name);
    expect(oauthLbNames).toContain(betaTool.name);

    // Service-account `start_agent_run` and router delegation execute end-to-end
    // through `buildMcpGatewayTool` and `buildAgentDelegationTool` under
    // `{ kind: "serviceAccount", id: account.id }`, persisting `McpToolCallModel`
    // handoff audit rows (`userId: null`) and reconstructing `"push"` moves in
    // `getSessionHandoffs`.
    const launchedWorkloads: string[] = [];
    vi.spyOn(backend, "launch").mockImplementation(async (spec) => {
      launchedWorkloads.push(spec.frozenName);
    });
    vi.spyOn(backend, "stageInputs").mockResolvedValue();
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
    vi.spyOn(backend, "steer").mockResolvedValue();
    vi.spyOn(backend, "teardown").mockResolvedValue();
    vi.spyOn(backend, "releaseRun").mockResolvedValue();
    vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);

    const saSessionId = `sa-session-${crypto.randomUUID()}`;
    const saGwToken = {
      tokenValue: null,
      tokenId: bareServiceAccountAuth.tokenId,
      teamId: null,
      isOrganizationToken: false,
      serviceAccountId: account.id,
      isUserToken: false,
    };
    const lbGatewayCtx: ChatToolContext = {
      agentId: lbGateway.id,
      agentName: lbGateway.name,
      userId: serviceAccountUserId(account.id),
      organizationId,
      sessionId: saSessionId,
      mcpGwToken: saGwToken,
      repeatTracker: new ToolCallRepeatTracker(),
      modelAcceptsImageToolResults: true,
    };
    const advertisedStartRun = saLbList.tools.find(
      (tool) => tool.name === TOOL_START_AGENT_RUN_FULL_NAME,
    );
    if (!advertisedStartRun) {
      throw new Error("Expected advertised start_agent_run on SA LB gateway");
    }
    const wrappedSaStartRun = buildMcpGatewayTool({
      mcpTool: advertisedStartRun,
      ctx: lbGatewayCtx,
    });
    const saStartRaw = await wrappedSaStartRun.execute?.(
      { message: "Service account pooled launch" },
      { toolCallId: "sa-start-call-1", messages: [] },
    );
    const saStartText =
      typeof saStartRaw === "string"
        ? saStartRaw
        : String((saStartRaw as { content?: unknown })?.content ?? "");
    const saStartParsed = JSON.parse(saStartText) as {
      run: { run_id: string };
    };

    // Non-LB Auto-subagents gateway with a bare service-account token resolves
    // Auto delegation targets and enriches an Auto load-balanced router's pool metadata.
    const autoRouter = await makeAgent({
      name: "SA Auto Router",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      access: "org",
      accessAllSubagents: true,
      modelId,
      llmApiKeyId: sharedKey.id,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    const autoRouterTool = await ToolModel.findOrCreateDelegationTool(
      autoRouter.id,
    );
    const autoDiscoveryGateway = await makeAgent({
      name: "SA Auto Discovery Gateway",
      organizationId,
      authorId: actorId,
      agentType: "mcp_gateway",
      toolExposureMode: "full",
      access: "org",
      accessAllSubagents: true,
    });

    // "All agents" is loaded progressively, so the gateway lists no agent:
    // the router is in the set search_tools and run_tool resolve for the
    // same caller.
    const saAutoGatewayList = await buildAgentMcpToolList({
      agent: autoDiscoveryGateway,
      tokenAuth: bareServiceAccountAuth,
    });
    expect(saAutoGatewayList.tools.map((tool) => tool.name)).not.toContain(
      autoRouterTool.name,
    );
    const advertisedRouter = (
      await getAgentTools({
        agentId: autoDiscoveryGateway.id,
        organizationId,
        userId: serviceAccountUserId(account.id),
      })
    ).find((tool) => tool.name === autoRouterTool.name);
    expect(advertisedRouter).toBeDefined();
    if (!advertisedRouter) {
      throw new Error("Expected advertised SA Auto router tool");
    }
    expect(advertisedRouter._meta).toMatchObject({
      [LOAD_BALANCED_RUNTIME_ROUTER_META_KEY]: true,
    });
    expect(advertisedRouter.description).toContain(
      "Runs in the background in Agent Runtime and returns a run link, not the answer.",
    );
    expect(advertisedRouter.description).toContain("SA Pool Alpha");
    expect(advertisedRouter.description).toContain("SA Pool Beta");

    const autoDiscoveryCtx: ChatToolContext = {
      agentId: autoDiscoveryGateway.id,
      agentName: autoDiscoveryGateway.name,
      userId: serviceAccountUserId(account.id),
      organizationId,
      sessionId: saSessionId,
      mcpGwToken: saGwToken,
      repeatTracker: new ToolCallRepeatTracker(),
      modelAcceptsImageToolResults: true,
    };
    const wrappedSaRouter = buildAgentDelegationTool({
      agentTool: advertisedRouter,
      ctx: autoDiscoveryCtx,
    });
    const saRouterRaw = await wrappedSaRouter.execute?.(
      { message: "Service account router delegation" },
      { toolCallId: "sa-router-call-2", messages: [] },
    );
    const saRouterParsed = JSON.parse(String(saRouterRaw)) as {
      run: { run_id: string };
    };

    await vi.waitFor(() => {
      expect(launchedWorkloads).toHaveLength(2);
    });

    const [firstRunRow, secondRunRow] = await Promise.all([
      AgentRunModel.findByTaskId(saStartParsed.run.run_id),
      AgentRunModel.findByTaskId(saRouterParsed.run.run_id),
    ]);
    expect(firstRunRow).toMatchObject({
      actorKind: "serviceAccount",
      actorId: account.id,
      actorUserId: null,
      originLlmSessionId: saSessionId,
    });
    expect(secondRunRow).toMatchObject({
      actorKind: "serviceAccount",
      actorId: account.id,
      actorUserId: null,
      originLlmSessionId: saSessionId,
    });

    const auditCalls = await McpToolCallModel.findArchestraCallsBySession({
      organizationId,
      sessionId: saSessionId,
      toolNames: [TOOL_START_AGENT_RUN_FULL_NAME],
      includeAgentDelegations: true,
      limit: 20,
    });
    expect(auditCalls).toHaveLength(2);
    const fullAuditRows = await Promise.all(
      auditCalls.map((call) => McpToolCallModel.findById(call.id)),
    );
    expect(fullAuditRows.map((row) => row?.runId)).toEqual(
      expect.arrayContaining([
        saStartParsed.run.run_id,
        saRouterParsed.run.run_id,
      ]),
    );
    for (const row of fullAuditRows) {
      expect(row).not.toBeNull();
      expect(row?.userId).toBeNull();
    }

    const saHandoffs = await getSessionHandoffs({
      organizationId,
      sessionId: saSessionId,
    });
    expect(saHandoffs.handedTo.map((run) => run.runId)).toEqual(
      expect.arrayContaining([
        saStartParsed.run.run_id,
        saRouterParsed.run.run_id,
      ]),
    );
    expect(saHandoffs.moves).toContainEqual(
      expect.objectContaining({
        kind: "push",
        runId: saStartParsed.run.run_id,
      }),
    );
    expect(saHandoffs.moves).toContainEqual(
      expect.objectContaining({
        kind: "push",
        runId: saRouterParsed.run.run_id,
      }),
    );
    await drainBackgroundWork();
  });

  test("keeps load-balanced router delegations in-process and unannotated for system, team-token, and OAuth callers", async ({
    makeAgent,
    makeCustomRole,
    makeServiceAccount,
  }) => {
    const workerOne = await createRuntimeSubagent(
      makeAgent,
      "Non-User Pool Worker One",
      false,
    );
    const workerTwo = await createRuntimeSubagent(
      makeAgent,
      "Non-User Pool Worker Two",
      false,
    );
    const workerOneTool = await ToolModel.findOrCreateDelegationTool(
      workerOne.id,
    );
    const workerTwoTool = await ToolModel.findOrCreateDelegationTool(
      workerTwo.id,
    );

    const manualRouter = await makeAgent({
      name: "Non-User Manual Router",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      access: "org",
      accessAllSubagents: false,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    await AgentToolModel.create(manualRouter.id, workerOneTool.id);
    await AgentToolModel.create(manualRouter.id, workerTwoTool.id);
    const manualRouterTool = await ToolModel.findOrCreateDelegationTool(
      manualRouter.id,
    );

    const autoRouter = await makeAgent({
      name: "Non-User Auto Router",
      organizationId,
      authorId: actorId,
      agentType: "agent",
      access: "org",
      accessAllSubagents: true,
      subagentLoadBalancing: {
        enabled: true,
        algorithm: "round_robin",
      },
    });
    const autoRouterTool = await ToolModel.findOrCreateDelegationTool(
      autoRouter.id,
    );

    const customCaller = await makeAgent({
      name: "Non-User Caller",
      organizationId,
      authorId: actorId,
      agentType: "mcp_gateway",
      toolExposureMode: "full",
      access: "org",
      accessAllSubagents: false,
    });
    await AgentToolModel.create(customCaller.id, manualRouterTool.id);
    await AgentToolModel.create(customCaller.id, autoRouterTool.id);

    const sendSpy = await mockDetachedTaskStart();
    let callSeq = 0;
    const executeA2ASpy = vi
      .spyOn(a2aExecutor, "executeA2AMessage")
      .mockImplementation(async (params) => {
        callSeq += 1;
        const text = `In-process router reply #${callSeq} from ${params.agentId}`;
        return {
          messageId: `msg-non-user-router-${callSeq}`,
          text,
          finishReason: "stop",
          responseUiMessage: {
            id: `msg-non-user-router-${callSeq}`,
            role: "assistant",
            parts: [{ type: "text", text }],
          },
        };
      });

    // 1. `"system"` sentinel turns (incoming email, schedule, external A2A v2):
    //    listing omits runtime-router metadata and dispatch runs in-process.
    const systemTools = await getAgentTools({
      agentId: customCaller.id,
      organizationId,
      userId: "system",
      skipAccessCheck: true,
    });
    for (const routerToolName of [manualRouterTool.name, autoRouterTool.name]) {
      const advertised = systemTools.find(
        (tool) => tool.name === routerToolName,
      );
      expect(advertised).toBeDefined();
      expect(
        advertised?._meta?.[LOAD_BALANCED_RUNTIME_ROUTER_META_KEY],
      ).toBeUndefined();
      expect(advertised?.description).not.toContain(
        "Runs in the background in Agent Runtime",
      );
      expect(advertised?.description).not.toContain("across its runtime pool");

      const dispatched = await executeArchestraTool(
        routerToolName,
        { message: `System delegation to ${routerToolName}` },
        {
          agent: { id: customCaller.id, name: customCaller.name },
          agentId: customCaller.id,
          userId: "system",
          organizationId,
        },
      );
      expect(dispatched.isError).toBeFalsy();
      expect(dispatched.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("In-process router reply #"),
      });
    }

    // 2. Team-scoped MCP gateway token (`isUserToken: false`, no `userId`):
    //    listing omits runtime-router metadata and `tools/call` runs in-process.
    const teamTokenAuth = {
      tokenId: crypto.randomUUID(),
      teamId: crypto.randomUUID(),
      isOrganizationToken: false,
      organizationId,
      isUserToken: false,
    };
    const teamTokenGatewayList = await buildAgentMcpToolList({
      agent: customCaller,
      tokenAuth: teamTokenAuth,
    });
    for (const routerToolName of [manualRouterTool.name, autoRouterTool.name]) {
      const advertised = teamTokenGatewayList.tools.find(
        (tool) => tool.name === routerToolName,
      );
      expect(advertised).toBeDefined();
      expect(
        advertised?._meta?.[LOAD_BALANCED_RUNTIME_ROUTER_META_KEY],
      ).toBeUndefined();
      expect(advertised?.description).not.toContain(
        "Runs in the background in Agent Runtime",
      );

      const dispatched = await executeArchestraTool(
        routerToolName,
        { message: `Team-token delegation to ${routerToolName}` },
        {
          agent: { id: customCaller.id, name: customCaller.name },
          agentId: customCaller.id,
          organizationId,
          tokenAuth: teamTokenAuth,
        },
      );
      expect(dispatched.isError).toBeFalsy();
      expect(dispatched.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("In-process router reply #"),
      });
    }

    // 3. Machine OAuth `client_credentials` gateway token (`oauthClientId` set,
    //    `isUserToken: false`): barred from Agent Runtime, so load-balanced
    //    routers remain in-process on both listing and dispatch.
    const oauthRole = await makeCustomRole(organizationId, {
      permission: {
        agent: ["read", "use"],
      },
    });
    const oauthAccount = await makeServiceAccount(organizationId, {
      role: oauthRole.role,
    });
    const oauthMachineAuth = {
      tokenId: crypto.randomUUID(),
      teamId: null,
      isOrganizationToken: false,
      serviceAccountId: oauthAccount.id,
      organizationId,
      oauthClientId: "oauth-machine-app",
      isUserToken: false,
    };
    const oauthGatewayList = await buildAgentMcpToolList({
      agent: customCaller,
      tokenAuth: oauthMachineAuth,
    });
    const oauthManualRouter = oauthGatewayList.tools.find(
      (tool) => tool.name === manualRouterTool.name,
    );
    expect(oauthManualRouter).toBeDefined();
    expect(
      oauthManualRouter?._meta?.[LOAD_BALANCED_RUNTIME_ROUTER_META_KEY],
    ).toBeUndefined();
    expect(oauthManualRouter?.description).not.toContain(
      "Runs in the background in Agent Runtime",
    );
    const oauthDispatched = await executeArchestraTool(
      manualRouterTool.name,
      { message: "OAuth machine delegation to manual router" },
      {
        agent: { id: customCaller.id, name: customCaller.name },
        agentId: customCaller.id,
        userId: serviceAccountUserId(oauthMachineAuth.serviceAccountId),
        organizationId,
        tokenAuth: oauthMachineAuth,
      },
    );
    expect(oauthDispatched.isError).toBeFalsy();
    expect(oauthDispatched.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(`from ${manualRouter.id}`),
    });

    expect(executeA2ASpy).toHaveBeenCalledTimes(5);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
