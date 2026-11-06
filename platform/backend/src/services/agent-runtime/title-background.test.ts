import { setImmediate } from "node:timers/promises";
import { HttpResponse, http } from "msw";
import config from "@/config";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
import { expect, test, vi } from "@/test";
import { useMswServer } from "@/test/msw";
import type { ResolvedAgentRuntime } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import { kubernetesAgentRuntimeBackendDriver as backend } from "./backends/kubernetes";
import { runTaskInAgentRuntime } from "./pod-run";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();

test("background drain waits for a failed launch's title request, logged in the run's LLM session, and persisted title", async ({
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

  const task = await A2ATaskModel.createForRun({
    contextId: context.id,
    agentId: agent.id,
  });
  let markRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  let releaseResponse!: () => void;
  const response = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let titleSessionId: string | null | undefined;
  server.use(
    http.post(
      "http://127.0.0.1:9000/v1/openai/:agentId/chat/completions",
      async ({ request }) => {
        titleSessionId = request.headers.get("x-archestra-session-id");
        markRequested();
        await response;
        return HttpResponse.json({
          id: "title-response",
          object: "chat.completion",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Investigate runtime launch failure",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      },
    ),
  );
  let launchedEnv: Parameters<typeof backend.launch>[0]["env"] | undefined;
  vi.spyOn(backend, "launch").mockImplementation(async (spec) => {
    launchedEnv = spec.env;
    throw new Error("publication connection lost");
  });
  vi.spyOn(backend, "teardown").mockResolvedValue();
  try {
    await expect(
      runTaskInAgentRuntime({
        runtime,
        taskId: task.id,
        agentId: agent.id,
        actor: { kind: "user", id: user.id, organizationId: org.id },
        organizationId: org.id,
        runMode: "one_shot",
        task: "Test launch failure",
        modelId: model.id,
        llmApiKeyId: key.id,
      }),
    ).rejects.toThrow("publication connection lost");
    await requested;
    let drained = false;
    const draining = drainBackgroundWork().then(() => {
      drained = true;
    });
    await setImmediate();
    expect(drained).toBe(false);
    releaseResponse();
    await draining;
    const run = await AgentRunModel.findByTaskId(task.id);
    expect(run?.title).toBe("Investigate runtime launch failure");
    // The title is logged in the run's own LLM session: the key the image
    // sends as X-Archestra-Session-Id on the run's traffic, not the task id.
    expect(titleSessionId).toBe(run?.workloadName);
    expect(titleSessionId).toBe(
      launchedEnv?.ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID,
    );
    expect(titleSessionId).not.toBe(task.id);
  } finally {
    releaseResponse();
    await drainBackgroundWork();
  }
});
