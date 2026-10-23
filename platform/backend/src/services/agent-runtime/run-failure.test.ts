import { HttpResponse, http } from "msw";
import config from "@/config";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  LimitModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
import { afterEach, expect, test, vi } from "@/test";
import { useMswServer } from "@/test/msw";
import { drainBackgroundWork } from "@/utils/background-work";
import { kubernetesAgentRuntimeBackendDriver as backend } from "./backends/kubernetes";
import { runTaskInAgentRuntime } from "./pod-run";
import { imageEnvelopeFailure } from "./run-failure";

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
  {
    name: "records the image envelope classification",
    spendDollars: 0,
    expected: { code: "image.claude_rate_limit", retriable: true },
  },
  {
    name: "reports an exhausted run budget over the client's own error",
    spendDollars: 5,
    expected: { code: "budget.exceeded", retriable: false },
  },
])("a failed turn $name", async ({ spendDollars, expected }, {
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
    externalId: "openai/test-budget-model",
    provider: "openai",
    modelId: "test-budget-model",
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    promptPricePerToken: "0.001",
    completionPricePerToken: "0.001",
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
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.createForRun({
    contextId: context.id,
    agentId: agent.id,
  });
  vi.spyOn(backend, "launch").mockResolvedValue();
  vi.spyOn(backend, "stageInputs").mockResolvedValue();
  vi.spyOn(backend, "waitUntilRunning").mockResolvedValue();
  vi.spyOn(backend, "streamOutput").mockImplementation(
    async ({ destination }) => {
      destination.end();
    },
  );
  vi.spyOn(backend, "snapshotOutput").mockImplementation(
    async ({ destination }) => {
      destination.end();
    },
  );
  vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);
  vi.spyOn(backend, "releaseRun").mockResolvedValue();
  vi.spyOn(backend, "waitForCompletion").mockImplementation(
    async ({ session }) => {
      if (spendDollars > 0) {
        if (!session.virtualApiKeyId) throw new Error("Expected a run key");
        // 1,000 tokens at $0.001 each, per dollar of spend.
        await LimitModel.updateTokenLimitUsage(
          "virtual_key",
          session.virtualApiKeyId,
          model.modelId,
          spendDollars * 1_000,
          0,
        );
      }
      return {
        outcome: "failed",
        reason:
          "Claude Code reached a rate limit. Retry when account capacity is available. (Runtime exit status 1.)",
        failure: imageEnvelopeFailure("claude_rate_limit"),
      };
    },
  );

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
        maxCostUsd: 1,
        idleTimeoutMinutes: null,
      },
      taskId: task.id,
      agentId: agent.id,
      actor: { kind: "user", id: user.id, organizationId: org.id },
      organizationId: org.id,
      runMode: "one_shot",
      task: "Review the change",
      title: "acme/widgets#12",
      modelId: model.id,
      llmApiKeyId: key.id,
    }),
  ).rejects.toThrow("Claude Code reached a rate limit");

  const settled = await A2ATaskModel.findById(task.id);
  expect(settled?.state).toBe("TASK_STATE_FAILED");
  expect(settled?.statusReason).toContain("Claude Code reached a rate limit");
  expect(settled?.failure).toEqual(expected);
  expect((await AgentRunModel.findByTaskId(task.id))?.title).toBe(
    "acme/widgets#12",
  );
});
