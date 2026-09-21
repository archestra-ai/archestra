import { createHash } from "node:crypto";
import { HttpResponse, http } from "msw";
import { threadFileStore } from "@/agents/chatops/thread-file-store";
import { startDelegatedTask } from "@/archestra-mcp-server/tasks";
import config from "@/config";
import {
  A2AMessageModel,
  A2ATaskModel,
  AgentRunInputModel,
  AgentRunModel,
  ChatOpsChannelBindingModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import { afterEach, expect, test, vi } from "@/test";
import { useMswServer } from "@/test/msw";
import { drainBackgroundWork } from "@/utils/background-work";
import { kubernetesAgentRuntimeBackendDriver as backend } from "./backends/kubernetes";
import { startDetachedAgentTask } from "./start-task";

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
  "slack",
  "slack-empty",
  "browser",
] as const)("%s runtime inputs follow their persistence and cleanup contract", async (origin, {
  makeOrganization,
  makeAdmin,
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
  makeAgent,
}) => {
  config.agentRuntime.enabled = true;
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
    runtime: {
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
  });
  const launch = vi.spyOn(backend, "launch").mockResolvedValue();
  const stage = vi.spyOn(backend, "stageInputs").mockResolvedValue();
  const cleanup = vi.spyOn(backend, "cleanupThreadFiles").mockResolvedValue();
  vi.spyOn(backend, "waitUntilRunning").mockResolvedValue();
  vi.spyOn(backend, "streamOutput").mockImplementation(
    async ({ destination }) => {
      destination.end("File processing complete.");
    },
  );
  vi.spyOn(backend, "snapshotOutput").mockImplementation(
    async ({ destination }) => {
      destination.end("File processing complete.");
    },
  );
  vi.spyOn(backend, "waitForCompletion").mockResolvedValue({
    outcome: "succeeded",
  });
  vi.spyOn(backend, "releaseRun").mockResolvedValue();

  const original = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x81]);
  const preview = Buffer.from("extracted preview");
  const attachments =
    origin === "slack-empty"
      ? []
      : [
          {
            name: "preview.txt",
            contentType: "text/plain",
            contentBase64: preview.toString("base64"),
            originalFile: { filename: "archive.zip", data: original },
          },
        ];
  let taskId: string;
  if (origin.startsWith("slack")) {
    const binding = await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "slack",
      channelId: "test-channel",
      workspaceId: "test-workspace",
      agentId: agent.id,
    });
    const isolationKey = executionSandboxRegistry.openEphemeralExecution(
      (key) => threadFileStore.release(key),
    );
    const scope = {
      organizationId: org.id,
      userId: user.id,
      isolationKey,
      chatOpsBindingId: binding.id,
      chatOpsThreadId: "1780000000.000001",
    };
    try {
      if (origin === "slack") {
        threadFileStore.retain({
          scope,
          data: original,
          filename: "archive.zip",
        });
      }
      const result = await startDelegatedTask({
        agentId: agent.id,
        message: "Return the original and create a document.",
        // The trusted snapshots must win over an inline preview.
        attachments,
        context: {
          ...scope,
          agent: { id: agent.id, name: agent.name },
          chatOpsMessageId: "1780000000.000002",
        },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const sessionId = result.structuredContent?.session_id;
      if (typeof sessionId !== "string")
        throw new Error("Runtime task was not created");
      taskId = sessionId;
    } finally {
      executionSandboxRegistry.release(isolationKey);
    }
  } else {
    taskId = (
      await startDetachedAgentTask({
        actor: { kind: "user", id: user.id, organizationId: org.id },
        agentId: agent.id,
        message: "Read the input.",
        attachments,
      })
    ).id;
  }
  await expect
    .poll(async () => (await A2ATaskModel.findById(taskId))?.state)
    .toBe("TASK_STATE_COMPLETED");
  await drainBackgroundWork();
  expect(stage).toHaveBeenCalledTimes(1);
  const staged = stage.mock.calls[0][0];
  const run = await AgentRunModel.findByTaskId(taskId);
  expect(run?.endedAt).not.toBeNull();
  const saved = await AgentRunInputModel.findByTaskId(taskId);
  const prompt = launch.mock.calls[0][0].secretEnv.ARCHESTRA_AGENT_RUNTIME_TASK;
  if (origin.startsWith("slack")) {
    expect(saved).toEqual([]);
    expect(run?.completionTarget).toMatchObject({ ephemeralFiles: true });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][0].inputFileCount).toBeGreaterThan(0);
    expect(prompt).toContain(`/tmp/archestra-thread-files/${taskId}/outputs/`);
    const savedMessages = await A2AMessageModel.findByTaskId(taskId);
    expect(
      savedMessages
        .flatMap((message) => message.parts ?? [])
        .every((part) => !part || typeof part !== "object" || !("raw" in part)),
    ).toBe(true);
    const history = JSON.stringify(savedMessages);
    expect(history).not.toContain(preview.toString("base64"));
    expect(history).not.toContain(original.toString("base64"));
    expect(history).not.toContain("originalFile");
    if (origin === "slack") {
      expect(staged.inputs[0].fileData).toEqual(original);
      expect(staged.inputs[0].runtimePath).toBe(
        `/tmp/archestra-thread-files/${taskId}/inputs/archive.zip`,
      );
      expect(prompt).toContain(
        createHash("sha256").update(original).digest("hex"),
      );
      expect(prompt).not.toContain(original.toString("base64"));
    } else {
      expect(staged.inputs).toEqual([]);
    }
  } else {
    expect(saved[0].fileData).toEqual(preview);
    expect(staged.inputs[0].runtimePath).toBe(
      `/var/run/archestra/attachments/${taskId}/preview.txt`,
    );
    expect(cleanup).not.toHaveBeenCalled();
  }
});
