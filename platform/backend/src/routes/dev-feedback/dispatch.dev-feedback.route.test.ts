import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import config from "@/config";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import {
  A2ATaskModel,
  AgentRunModel,
  ChatOpsChannelBindingModel,
  ChatOpsConfigModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
} from "@/models";
import AgentRunInputModel from "@/models/agent-run-input";
import DevFeedbackConfigModel from "@/models/dev-feedback-config";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import type { AgentRunCompletion } from "@/services/agent-runtime/backends/types";
import { afterEach, describe, expect, test, vi } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { FakeSlack } from "@/test/fake-slack";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import { drainBackgroundWork } from "@/utils/background-work";
import devFeedbackRoutes from "./dev-feedback.routes";

setupTestCacheManager();
afterEach(async () => {
  await drainBackgroundWork();
  vi.restoreAllMocks();
});

describe("feedback delivery and direct dispatch", () => {
  const ctx = useRouteTestApp(devFeedbackRoutes);
  const server = useMswServer();

  test("a requester without Agent access gets partial success after the Slack post", async ({
    makeMember,
    makeInternalAgent,
    makeUser,
  }) => {
    const slack = new FakeSlack("CFEEDBACK");
    await slack.configureAsDevFeedbackChannel();
    server.use(...slack.handlers());
    await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
    const owner = await makeUser();
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
      authorId: owner.id,
      access: "personal",
      runtime: {
        image: "example.test/feedback:1",
        command: ["feedback-worker"],
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
    const binding = await ChatOpsChannelBindingModel.create({
      organizationId: ctx.organizationId,
      provider: "slack",
      channelId: slack.channel,
      workspaceId: "T1",
      agentId: agent.id,
    });
    await DevFeedbackConfigModel.save({
      botId: "A1",
      channelId: slack.channel,
      channelName: "ui-feedback",
      organizationId: ctx.organizationId,
      agentId: agent.id,
      bindingId: binding.id,
      workspaceId: "T1",
    });
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload: body(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: slack.messages[0].ts,
      permalink: expect.stringContaining(slack.channel),
      dispatch: { status: "failed", runId: null, message: expect.any(String) },
    });
    expect(slack.messages).toHaveLength(1);
    expect(
      (
        await A2ATaskModel.listForActor({
          actorKind: "user",
          actorId: ctx.user.id,
          agentIds: [agent.id],
          organizationId: ctx.organizationId,
          pageSize: 10,
        })
      ).totalSize,
    ).toBe(0);
  });

  test("setup refuses an Agent that does not own the selected pinned Slack bot", async ({
    makeMember,
    makeInternalAgent,
  }) => {
    const slack = new FakeSlack("CFEEDBACK");
    await slack.connectChatOpsBot();
    server.use(...slack.handlers());
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      runtime: {
        image: "example.test/feedback:1",
        command: ["feedback-worker"],
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
    await ChatOpsConfigModel.saveSlackAgentBot({
      agentId: randomUUID(),
      appId: "A1",
      botToken: "xoxb-test",
      signingSecret: "test-signature",
      enabled: true,
      connectionMode: "webhook",
    });
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/api/dev-feedback/setup",
      payload: { botId: "A1", channelId: slack.channel, agentId: agent.id },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      "owns the selected Slack bot",
    );
    expect(await DevFeedbackConfigModel.get()).toBeNull();
    expect(slack.messages).toHaveLength(0);
  });

  test("does not summon an Agent when Slack refuses the root post", async () => {
    const slack = new FakeSlack("CFEEDBACK");
    await slack.configureAsDevFeedbackChannel();
    const agentId = randomUUID();
    await DevFeedbackConfigModel.save({
      botId: "A1",
      channelId: slack.channel,
      channelName: "ui-feedback",
      organizationId: ctx.organizationId,
      agentId,
    });
    server.use(...slack.handlers());
    server.use(
      http.post("https://slack.com/api/chat.postMessage", () =>
        HttpResponse.json({ ok: false, error: "channel_not_found" }),
      ),
    );
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload: body({ screenshot: undefined }),
    });
    expect(response.statusCode).toBe(500);
    expect(slack.messages).toHaveLength(0);
    expect(
      (
        await A2ATaskModel.listForActor({
          actorKind: "user",
          actorId: ctx.user.id,
          agentIds: [agentId],
          organizationId: ctx.organizationId,
          pageSize: 10,
        })
      ).totalSize,
    ).toBe(0);
  });

  test("directly summons the runtime with authenticated context and media, then replies in the Slack thread", async ({
    makeMember,
    makeInternalAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    config.agentRuntime.platformBaseUrl = "https://platform.example.test";
    vi.spyOn(agentRuntimeManager, "isEnabled", "get").mockReturnValue(true);
    vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
    vi.spyOn(backend, "assertReady").mockResolvedValue();
    vi.spyOn(backend, "resolveRuntimeScope").mockReturnValue("test-runtime");
    const launch = vi.spyOn(backend, "launch").mockResolvedValue();
    const stage = vi.spyOn(backend, "stageInputs").mockResolvedValue();
    vi.spyOn(backend, "waitUntilRunning").mockResolvedValue();
    vi.spyOn(backend, "releaseRun").mockResolvedValue();
    vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);
    vi.spyOn(backend, "getWorkspaceConnection").mockResolvedValue(null);
    vi.spyOn(backend, "streamOutput").mockImplementation(
      async ({ destination }) => {
        destination.end("Feedback investigated.\n");
      },
    );
    vi.spyOn(backend, "snapshotOutput").mockImplementation(
      async ({ destination }) => {
        destination.end("Feedback investigated.\n");
      },
    );
    let finish!: (completion: AgentRunCompletion) => void;
    vi.spyOn(backend, "waitForCompletion").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const key = await makeLlmProviderApiKey(ctx.organizationId, secret.id, {
      provider: "openai",
    });
    const model = await ModelModel.create({
      externalId: "openai/test-feedback-model",
      provider: "openai",
      modelId: "test-feedback-model",
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      model.id,
    ]);
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      systemPrompt: "Use the configured agent workflow.",
      modelId: model.id,
      llmApiKeyId: key.id,
      runtime: {
        image: "example.test/feedback-worker:1",
        command: ["feedback-worker"],
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
    const slack = new FakeSlack("CFEEDBACK");
    await slack.connectChatOpsBot();
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: true,
      botToken: "xoxb-test",
      signingSecret: "test-signature",
      appId: "A1",
      connectionMode: "webhook",
    });
    server.use(
      ...slack.handlers(),
      http.post("https://slack.com/api/agents.sessions.setStatus", () =>
        HttpResponse.json({ ok: true }),
      ),
      http.post(
        "http://127.0.0.1:9000/v1/openai/:agentId/chat/completions",
        () =>
          HttpResponse.json(
            { error: { message: "Title unavailable" } },
            { status: 400 },
          ),
      ),
    );
    const binding = await ChatOpsChannelBindingModel.create({
      organizationId: ctx.organizationId,
      provider: "slack",
      channelId: slack.channel,
      workspaceId: "T1",
      agentId: agent.id,
    });
    await ChatOpsChannelBindingModel.update(binding.id, {
      channelInstructions:
        "Follow the configured feedback triage workflow before creating work.",
    });
    const setup = await ctx.app.inject({
      method: "PUT",
      url: "/api/dev-feedback/setup",
      payload: { botId: "A1", channelId: slack.channel, agentId: agent.id },
    });
    expect(setup.statusCode).toBe(200);
    const payload = body({
      clip: {
        mimeType: "video/mp4",
        base64: Buffer.from("recording-bytes").toString("base64"),
      },
    });
    const posted = await ctx.app.inject({
      method: "POST",
      url: "/api/dev-feedback/comments",
      payload,
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().dispatch.status).toBe("started");
    const taskId = posted.json().dispatch.runId as string;
    expect(taskId).toEqual(expect.any(String));
    await expect.poll(() => launch.mock.calls.length).toBe(1);
    await expect
      .poll(async () => !!(await AgentRunModel.findByTaskId(taskId)))
      .toBe(true);
    const run = await AgentRunModel.findByTaskId(taskId);
    expect(run).toMatchObject({
      actorUserId: ctx.user.id,
      organizationId: ctx.organizationId,
      completionTarget: {
        type: "chatops",
        bindingId: binding.id,
        threadId: posted.json().id,
      },
    });
    const inputs = await AgentRunInputModel.findByTaskId(taskId);
    expect(inputs.map((input) => input.originalName).sort()).toEqual([
      "clip.mp4",
      "screenshot.jpg",
    ]);
    expect(
      inputs
        .find((input) => input.originalName === "clip.mp4")
        ?.fileData.toString(),
    ).toBe("recording-bytes");
    expect(stage).toHaveBeenCalledOnce();
    expect(slack.uploads).toHaveLength(2);
    expect(slack.uploads[1].threadTs).toBe(posted.json().id);
    const launchSpec = launch.mock.calls[0][0];
    expect(
      launchSpec.secretEnv.ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT,
    ).toContain("Use the configured agent workflow.");
    expect(launchSpec.secretEnv.ARCHESTRA_AGENT_RUNTIME_TASK).toContain(
      "New UI feedback is available. Use your existing agent and channel instructions.",
    );
    expect(JSON.stringify(launch.mock.calls[0][0])).toContain(
      "Accordion opens the wrong row",
    );
    expect(JSON.stringify(launch.mock.calls[0][0])).toContain("/llm/limits");
    expect(JSON.stringify(launch.mock.calls[0][0])).toContain(
      "Follow the configured feedback triage workflow before creating work.",
    );
    finish({ outcome: "succeeded" });
    await expect
      .poll(async () => (await A2ATaskModel.findById(taskId))?.state)
      .toBe("TASK_STATE_COMPLETED");
    await expect
      .poll(
        () =>
          slack.messages.filter(
            (message) => message.threadTs === posted.json().id,
          ).length,
      )
      .toBe(1);
    expect(slack.messages.filter((message) => !message.threadTs)).toHaveLength(
      1,
    );
    expect(launch).toHaveBeenCalledOnce();
  });
});

function body(overrides: Record<string, unknown> = {}) {
  return {
    route: "/llm/limits",
    url: "https://frontend.example.test/llm/limits",
    selector: "main > section",
    label: "Limits accordion",
    elementX: 0.5,
    elementY: 0.5,
    viewportX: 0.5,
    viewportY: 0.5,
    viewport: "1440x900",
    text: "Accordion opens the wrong row",
    screenshot: {
      mimeType: "image/jpeg",
      base64: Buffer.from("screenshot-bytes").toString("base64"),
    },
    ...overrides,
  };
}
