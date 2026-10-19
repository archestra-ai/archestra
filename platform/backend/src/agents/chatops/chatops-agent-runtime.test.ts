import { HttpResponse, http } from "msw";
import { onTestFinished, vi } from "vitest";
import * as a2aExecutor from "@/agents/a2a-executor";
import config from "@/config";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentTeamModel,
  AgentWorkspaceModel,
  ChatOpsChannelBindingModel,
} from "@/models";
import AgentRunInputModel from "@/models/agent-run-input";
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import { claudeCodeAccountManager } from "@/services/agent-runtime/claude-code-account";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import { afterEach, beforeEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import type {
  Agent,
  AgentRuntime,
  ChatOpsProvider,
  ChatReplyOptions,
  IncomingChatMessage,
  ResolvedAgentRuntime,
} from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import {
  getThreadMuteMarker,
  stopChannelThreadReply,
} from "./channel-activation";
import { chatOpsManager } from "./chatops-manager";
import { THREAD_MUTE_HINT } from "./constants";
import MSTeamsProvider from "./ms-teams-provider";

const THREAD_ID = "1700000000.000100";
setupTestCacheManager();

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const oauthServer = useMswServer(
  // A started run titles itself in the background; keep that off the network.
  http.post("http://127.0.0.1:9000/v1/openai/:agentId/chat/completions", () =>
    HttpResponse.json(
      { error: { message: "Title unavailable" } },
      { status: 400 },
    ),
  ),
);
afterEach(drainBackgroundWork);

let agent: Agent;
let binding: { id: string };
let userId: string;
let runtime: ResolvedAgentRuntime;
let replies: ChatReplyOptions[];
let provider: ChatOpsProvider;

beforeEach(
  async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeAgent,
  }) => {
    const previousUrl = config.agentRuntime.platformBaseUrl;
    config.agentRuntime.platformBaseUrl = "https://platform.example.test";
    onTestFinished(() => {
      config.agentRuntime.platformBaseUrl = previousUrl;
    });
    // The Kubernetes backend is the process boundary; everything above it runs.
    vi.spyOn(agentRuntimeManager, "isEnabled", "get").mockReturnValue(true);
    vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
    vi.spyOn(backend, "assertReady").mockResolvedValue();
    vi.spyOn(backend, "stopRun").mockResolvedValue(undefined);
    vi.spyOn(backend, "releaseRun").mockResolvedValue();

    const user = await makeUser({ email: "runtime-chat@example.com" });
    userId = user.id;
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    agent = await makeAgent({
      organizationId: org.id,
      authorId: user.id,
      agentType: "agent",
      runtime: RUNTIME,
    });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);
    const resolved = resolveAgentRuntime(agent);
    if (!resolved) throw new Error("Expected an Agent Runtime");
    runtime = resolved;
    await connectClaudeAccount();
    binding = await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "slack",
      channelId: "C-runtime",
      workspaceId: "T-runtime",
      agentId: agent.id,
    });

    replies = [];
    provider = fakeSlackProvider(replies);
    vi.spyOn(chatOpsManager, "getChatOpsProvider").mockImplementation(
      () => provider,
    );
  },
);

test("a message to an Agent Runtime agent starts a run in its runtime and reports the outcome to the thread", async () => {
  const executor = vi.spyOn(a2aExecutor, "executeA2AMessage");
  const launch = vi
    .spyOn(backend, "launch")
    .mockRejectedValue(new Error("Runtime transport unavailable"));

  const result = await chatOpsManager.processMessage({
    message: message("Fix the flaky test"),
    provider,
  });

  expect(result.success).toBe(true);
  expect(result.agentResponse).toBe("");
  expect(executor).not.toHaveBeenCalled();
  await expect.poll(() => launch.mock.calls.length).toBe(1);
  const run = await latestRun();
  expect(run?.completionTarget).toEqual({
    type: "chatops",
    bindingId: binding.id,
    threadId: THREAD_ID,
    muteMarkerAtStart: null,
    originatingTaskId: run?.taskId,
  });

  expect(JSON.stringify(launch.mock.calls[0][0])).toContain(
    "Fix the flaky test",
  );
  // The settled run reaches the thread it started from.
  await expect.poll(() => replies.length).toBe(1);
  expect(replies[0].text).toContain("Runtime transport unavailable");
  expect(replies[0].conversationUrl).toContain(`/chat/runs/${run?.taskId}`);
  expect(replies[0].originalMessage.threadId).toBe(THREAD_ID);
  expect(provider.setTypingStatus).toHaveBeenCalledOnce();
  await expect
    .poll(() => vi.mocked(provider.clearTypingStatus)?.mock.calls.length)
    .toBe(1);
});

test.each([
  "slack",
  "ms-teams",
] as const)("%s continues with the latest request inline and earlier context in a readable attachment", async (providerId) => {
  if (providerId === "ms-teams") {
    binding = await ChatOpsChannelBindingModel.create({
      organizationId: agent.organizationId,
      provider: providerId,
      channelId: "C-runtime",
      workspaceId: "T-runtime",
      agentId: agent.id,
    });
    provider = { ...provider, providerId };
  }
  await ChatOpsChannelBindingModel.update(binding.id, {
    channelInstructions: "Use the incident checklist before proposing a fix.",
  });
  const previous = await retainedRun({ state: "idle" });
  const historicBytes = Buffer.from("earlier diagnostic output");
  const currentBytes = Buffer.from("new diagnostic output");
  const historicalId = "1700000000.000150";
  vi.spyOn(provider, "getThreadHistory").mockResolvedValue([
    {
      messageId: historicalId,
      senderId: "U-colleague",
      senderName: "A Colleague",
      text: "The earlier failure only happens on a cold cache.",
      timestamp: new Date("2026-01-01T10:00:00Z"),
      isFromBot: false,
      files: [
        {
          url: "https://files.example.test/earlier.txt",
          mimetype: "text/plain",
          name: "earlier.txt",
        },
      ],
    },
  ]);
  vi.spyOn(provider, "downloadFiles").mockResolvedValue([
    {
      status: "delivered",
      attachment: {
        name: "earlier.txt",
        contentType: "text/plain",
        contentBase64: historicBytes.toString("base64"),
      },
    },
  ]);
  const incoming = {
    ...message("Compare this output with the earlier failure."),
    metadata: { conversationType: "channel" },
    attachments: [
      {
        name: "latest.txt",
        contentType: "text/plain",
        contentBase64: currentBytes.toString("base64"),
      },
    ],
  };
  const launch = vi.spyOn(backend, "launch");
  const continuation = vi
    .spyOn(backend, "continueRun")
    .mockRejectedValue(new Error("Runtime transport unavailable"));

  const result = await chatOpsManager.processMessage({
    message: incoming,
    provider,
  });

  expect(result.success).toBe(true);
  await expect.poll(() => continuation.mock.calls.length).toBe(1);
  const { spec } = continuation.mock.calls[0][0];
  expect(spec.frozenName).toBe(previous.workloadName);
  expect(launch).not.toHaveBeenCalled();
  expect(spec.taskId).not.toBe(previous.taskId);
  expect(result.agentResponse).toBe("");
  const prompt = JSON.stringify(spec);
  expect(prompt).toContain(incoming.text);
  expect(prompt).not.toContain("You are replying via");
  expect(prompt).not.toContain("Your final answer is posted");
  expect(prompt).not.toContain("Reply by default");
  expect(prompt).toContain("Directly @mentioned: no");
  expect(prompt).toContain("Thread reference:");
  expect(prompt).toContain(
    "Use the incident checklist before proposing a fix.",
  );
  expect(prompt).not.toContain(
    "The earlier failure only happens on a cold cache.",
  );
  const inputs = await AgentRunInputModel.findByTaskId(spec.taskId);
  const snapshot = inputs.find((input) =>
    input.originalName.startsWith("archestra-thread-"),
  );
  expect(snapshot).toBeDefined();
  const transcript = snapshot?.fileData.toString("utf8");
  expect(transcript).toContain(
    "The earlier failure only happens on a cold cache.",
  );
  expect(transcript).toContain("U-colleague");
  expect(transcript).toContain(historicalId);
  expect(transcript).toContain(incoming.messageId);
  expect(transcript).toContain(incoming.senderId);
  expect(transcript).toContain(incoming.channelId);
  expect(transcript).toContain(THREAD_ID);
  expect(prompt).toContain(snapshot?.runtimePath);
  expect(
    inputs.find((input) => input.originalName === "earlier.txt")?.fileData,
  ).toEqual(historicBytes);
  expect(
    inputs.find((input) => input.originalName === "latest.txt")?.fileData,
  ).toEqual(currentBytes);
  await expect.poll(() => replies.length).toBe(1);
  expect(replies[0].conversationUrl).toContain(`/chat/runs/${previous.taskId}`);
});

test.each([
  "personal",
  "groupChat",
] as const)("Teams %s runtime input does not fetch unsupported chat history or claim its snapshot is complete", async (conversationType) => {
  binding = await ChatOpsChannelBindingModel.create({
    organizationId: agent.organizationId,
    provider: "ms-teams",
    channelId: "C-runtime",
    workspaceId: "T-runtime",
    agentId: agent.id,
    isDm: conversationType === "personal",
  });
  provider = {
    ...provider,
    providerId: "ms-teams",
    usesServerSideSessionsFor:
      MSTeamsProvider.prototype.usesServerSideSessionsFor,
  };
  const history = vi.spyOn(provider, "getThreadHistory");
  const launch = vi
    .spyOn(backend, "launch")
    .mockRejectedValue(new Error("Runtime transport unavailable"));
  const incoming = {
    ...message("Summarize the latest decision."),
    metadata: { conversationType },
  };

  const result = await chatOpsManager.processMessage({
    message: incoming,
    provider,
  });

  expect(result.success).toBe(true);
  await expect.poll(() => launch.mock.calls.length).toBe(1);
  expect(history).not.toHaveBeenCalled();
  const spec = launch.mock.calls[0][0];
  expect(JSON.stringify(spec)).toContain(incoming.text);
  const inputs = await AgentRunInputModel.findByTaskId(spec.taskId);
  const snapshot = inputs.find((input) =>
    input.originalName.startsWith("archestra-thread-"),
  );
  expect(snapshot).toBeDefined();
  expect(snapshot?.fileData.toString("utf8")).toMatch(
    /history is not fetched|bounded|incomplete|not.*complete/i,
  );
  await expect.poll(() => replies.length).toBe(1);
});

test.each([
  ["slack", false],
  ["slack", true],
  ["ms-teams", false],
  ["ms-teams", true],
] as const)("%s initializes a fresh session (previous workspace deleted: %s)", async (providerId, deleted) => {
  if (providerId === "ms-teams") {
    binding = await ChatOpsChannelBindingModel.create({
      organizationId: agent.organizationId,
      provider: providerId,
      channelId: "C-runtime",
      workspaceId: "T-runtime",
      agentId: agent.id,
    });
    provider = { ...provider, providerId };
  }
  if (deleted) {
    const previous = await retainedRun({ state: "idle" });
    await AgentWorkspaceModel.transition({
      id: previous.taskId,
      from: "idle",
      to: "deleted",
    });
  }
  const continuation = vi.spyOn(backend, "continueRun");
  const launch = vi
    .spyOn(backend, "launch")
    .mockRejectedValue(new Error("Runtime transport unavailable"));
  const incoming = {
    ...message("Help me with this"),
    metadata: { conversationType: "channel", botMentioned: true },
  };

  const result = await chatOpsManager.processMessage({
    message: incoming,
    provider,
  });

  expect(result.success).toBe(true);
  await expect.poll(() => launch.mock.calls.length).toBe(1);
  expect(continuation).not.toHaveBeenCalled();
  const prompt = JSON.stringify(launch.mock.calls[0][0]);
  expect(prompt).toContain("You are replying via");
  expect(prompt).toContain("Your final answer is posted");
  expect(prompt).toContain("Reply by default");
  expect(prompt).toContain("Directly @mentioned: yes");
  expect(prompt).toContain("Thread reference:");
  expect(prompt).toContain(incoming.text);
  await expect.poll(() => replies.length).toBe(1);
});

test("a silent runtime completion clears its status without posting a link or answer", async () => {
  const previous = await retainedRun({ state: "idle" });
  await chatOpsManager.notifyBindingThread({
    taskId: previous.taskId,
    bindingId: binding.id,
    threadId: THREAD_ID,
    text: "[NO_REPLY]",
  });
  expect(replies).toHaveLength(0);
  expect(provider.clearTypingStatus).toHaveBeenCalledWith(
    "C-runtime",
    THREAD_ID,
    expect.any(Object),
  );
});

test.each([
  "slack",
  "ms-teams",
] as const)("%s puts conversation controls on the first delivered answer only, across runtime replacements", async (providerId) => {
  if (providerId === "ms-teams") {
    binding = await ChatOpsChannelBindingModel.create({
      organizationId: agent.organizationId,
      provider: providerId,
      channelId: "C-runtime",
      workspaceId: "T-runtime",
      agentId: agent.id,
    });
    provider = { ...provider, providerId };
  }
  const first = await retainedRun({ state: "idle" });
  const notify = (taskId: string, text: string) =>
    chatOpsManager.notifyBindingThread({
      taskId,
      bindingId: binding.id,
      threadId: THREAD_ID,
      agentName: agent.name,
      text,
    });
  await notify(first.taskId, "[NO_REPLY]");
  await notify(first.taskId, "First answer");
  const replacement = await retainedRun({ state: "idle" });
  await notify(replacement.taskId, "Follow-up answer");

  expect(replies).toHaveLength(2);
  expect(replies[0]).toMatchObject({
    text: "First answer",
    conversationUrl: expect.stringContaining(`/chat/runs/${first.taskId}`),
    hint: THREAD_MUTE_HINT,
  });
  expect(replies[1]).toMatchObject({ text: "Follow-up answer" });
  expect(replies[1].conversationUrl).toBeUndefined();
  expect(replies[1].hint).toBeUndefined();
  expect(replies[1].footer).toBeUndefined();
});

test("a rejected first post preserves the anchor for its retry", async () => {
  const run = await retainedRun({ state: "idle" });
  vi.spyOn(provider, "sendReply").mockRejectedValueOnce(
    new Error("Provider unavailable"),
  );
  const notify = () =>
    chatOpsManager.notifyBindingThread({
      taskId: run.taskId,
      bindingId: binding.id,
      threadId: THREAD_ID,
      text: "The answer",
    });
  await expect(notify()).rejects.toThrow("Provider unavailable");
  await notify();
  expect(replies).toHaveLength(1);
  expect(replies[0].conversationUrl).toContain(`/chat/runs/${run.taskId}`);
  expect(replies[0].hint).toBe(THREAD_MUTE_HINT);
});

test("concurrent first answers retry after anchor delivery instead of posting two footers", async () => {
  const run = await retainedRun({ state: "idle" });
  let completePost: (() => void) | undefined;
  const send = vi
    .spyOn(provider, "sendReply")
    .mockImplementationOnce(async (options) => {
      await new Promise<void>((resolve) => {
        completePost = resolve;
      });
      replies.push(options);
      return "anchor-id";
    });
  const notify = () =>
    chatOpsManager.notifyBindingThread({
      taskId: run.taskId,
      bindingId: binding.id,
      threadId: THREAD_ID,
      text: "The answer",
    });
  const first = notify();
  await expect.poll(() => send.mock.calls.length).toBe(1);
  try {
    await expect(notify()).rejects.toThrow("still being delivered");
  } finally {
    completePost?.();
    await first;
  }
  await notify();
  expect(replies).toHaveLength(2);
  expect(replies[0].conversationUrl).toBeDefined();
  expect(replies[1].conversationUrl).toBeUndefined();
});

test.each([
  "thread",
  "bot",
])("a different %s gets its own anchor", async (scope) => {
  const run = await retainedRun({ state: "idle" });
  const notify = (threadId: string) =>
    chatOpsManager.notifyBindingThread({
      taskId: run.taskId,
      bindingId: binding.id,
      threadId,
      text: "Answer",
    });
  await notify(THREAD_ID);
  if (scope === "bot") provider = { ...provider, stateScope: "another-bot" };
  await notify(scope === "thread" ? "another-thread" : THREAD_ID);
  expect(replies).toHaveLength(2);
  expect(replies.every((reply) => reply.conversationUrl && reply.hint)).toBe(
    true,
  );
});

test("a direct-message anchor has a conversation link without channel mute instructions", async () => {
  binding = await ChatOpsChannelBindingModel.create({
    organizationId: agent.organizationId,
    provider: "slack",
    channelId: "D-runtime",
    workspaceId: "T-runtime",
    agentId: agent.id,
    isDm: true,
  });
  const run = await retainedRun({ state: "idle" });
  await chatOpsManager.notifyBindingThread({
    taskId: run.taskId,
    bindingId: binding.id,
    threadId: THREAD_ID,
    text: "Direct answer",
  });
  expect(replies[0].conversationUrl).toBeDefined();
  expect(replies[0].hint).toBeUndefined();
});

test.each([
  true,
  false,
])("Teams preserves detached reply routing without announcing startup (sendReply: %s)", async (sendReply) => {
  binding = await ChatOpsChannelBindingModel.create({
    organizationId: agent.organizationId,
    provider: "ms-teams",
    channelId: "C-runtime",
    workspaceId: "T-runtime",
    agentId: agent.id,
  });
  provider = { ...provider, providerId: "ms-teams", displayName: "Teams" };
  const conversationReference = {
    serviceUrl: "https://teams.example.test",
    conversation: { id: THREAD_ID },
  };
  provider.setTypingStatus = vi.fn(async (_channel, _thread, metadata) => {
    if (metadata) metadata.placeholderActivityId = "thinking-activity";
  });
  vi.spyOn(backend, "launch").mockRejectedValue(
    new Error("Runtime transport unavailable"),
  );
  const incoming = message("Help me with this");
  incoming.metadata = { conversationReference };
  const result = await chatOpsManager.processMessage({
    message: incoming,
    provider,
    sendReply,
  });
  expect(result).toEqual({ success: true, agentResponse: "" });
  await expect.poll(() => replies.length).toBe(1);
  const run = await latestRun();
  expect(run?.completionTarget).toMatchObject({
    conversationReference,
    placeholderActivityId: "thinking-activity",
  });
  expect(replies[0]).toMatchObject({
    conversationReference,
    originalMessage: {
      metadata: {
        conversationReference,
        placeholderActivityId: "thinking-activity",
      },
    },
    conversationUrl: expect.stringContaining(`/chat/runs/${run?.taskId}`),
    text: expect.stringContaining("Runtime transport unavailable"),
  });
});

test("a Stop before completion suppresses the answer and clears the native status", async () => {
  const previous = await retainedRun({ state: "idle" });
  const key = {
    provider: "slack" as const,
    channelId: "C-runtime",
    threadId: THREAD_ID,
  };
  const muteMarkerAtStart = await getThreadMuteMarker(key);
  await stopChannelThreadReply(key);
  await chatOpsManager.notifyBindingThread({
    taskId: previous.taskId,
    bindingId: binding.id,
    threadId: THREAD_ID,
    muteMarkerAtStart,
    text: "This answer arrived after Stop",
  });
  expect(replies).toHaveLength(0);
  expect(provider.clearTypingStatus).toHaveBeenCalledOnce();
});

test("Slack stays processing until the other person's runtime in the same thread finishes", async ({
  makeUser,
}) => {
  const previous = await retainedRun({ state: "idle" });
  const otherUser = await makeUser();
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: otherUser.id,
  });
  const otherTask = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_WORKING",
  });
  await AgentRunModel.create({
    organizationId: agent.organizationId,
    agentId: agent.id,
    taskId: otherTask.id,
    actorKind: "user",
    actorId: otherUser.id,
    actorUserId: otherUser.id,
    workloadName: `other-${otherTask.id}`,
    backend: "kubernetes",
    runtimeScope: backend.resolveRuntimeScope({}),
    completionTarget: {
      type: "chatops",
      bindingId: binding.id,
      threadId: THREAD_ID,
    },
  });
  await chatOpsManager.notifyBindingThread({
    taskId: previous.taskId,
    bindingId: binding.id,
    threadId: THREAD_ID,
    text: "First person's answer",
  });
  expect(replies).toHaveLength(1);
  expect(provider.clearTypingStatus).not.toHaveBeenCalled();
});

test("Teams removes a silent turn's placeholder even after a newer turn claims the workspace", async () => {
  binding = await ChatOpsChannelBindingModel.create({
    organizationId: agent.organizationId,
    provider: "ms-teams",
    channelId: "C-runtime",
    workspaceId: "T-runtime",
    agentId: agent.id,
  });
  provider = { ...provider, providerId: "ms-teams", displayName: "Teams" };
  const previous = await retainedRun({ state: "idle" });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: userId,
  });
  const next = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_WORKING",
  });
  await AgentWorkspaceModel.claim({
    id: previous.taskId,
    organizationId: agent.organizationId,
    actorKind: "user",
    actorId: userId,
    agentId: agent.id,
    taskId: next.id,
  });
  await chatOpsManager.notifyBindingThread({
    taskId: previous.taskId,
    bindingId: binding.id,
    threadId: THREAD_ID,
    text: "[NO_REPLY]",
    conversationReference: { conversation: { id: THREAD_ID } },
    placeholderActivityId: "old-placeholder",
  });
  expect(replies).toHaveLength(0);
  expect(provider.clearTypingStatus).toHaveBeenCalledWith(
    "C-runtime",
    THREAD_ID,
    expect.objectContaining({ placeholderActivityId: "old-placeholder" }),
  );
});

test("a follow-up while the thread's run is still working does not start another run", async () => {
  const previous = await retainedRun({ state: "active" });
  const launch = vi.spyOn(backend, "launch");
  const continuation = vi.spyOn(backend, "continueRun");

  const result = await chatOpsManager.processMessage({
    message: message("Are you done yet?"),
    provider,
  });

  expect(result.success).toBe(true);
  expect(replies).toHaveLength(1);
  expect(replies[0].text).toContain("still working");
  expect(replies[0].text).toContain(`/chat/runs/${previous.taskId}`);
  expect(launch).not.toHaveBeenCalled();
  expect(continuation).not.toHaveBeenCalled();
});

test("a sender without the runtime's personal account gets a reply that links to its setup", async () => {
  await claudeCodeAccountManager.disconnect({ runtime, userId });
  const launch = vi.spyOn(backend, "launch");

  const result = await chatOpsManager.processMessage({
    message: message("Fix the flaky test"),
    provider,
  });

  expect(result.success).toBe(false);
  expect(launch).not.toHaveBeenCalled();
  expect(replies).toHaveLength(1);
  expect(replies[0].text).toContain(
    `/agents/${agent.id}?setup=credentials&keys=CLAUDE_CODE_ACCOUNT`,
  );
});

// === Internal helpers ===

const RUNTIME: AgentRuntime = {
  image: "example.test/claude-code:current",
  command: ["archestra-claude-code"],
  inferenceProtocol: "anthropic",
  backend: "kubernetes",
  steerMode: "tmux_keys",
  privileged: false,
  resources: null,
  environment: null,
  credentials: null,
  ttlHours: null,
  maxCostUsd: null,
  idleTimeoutMinutes: null,
  claudeCode: { authentication: "subscription" },
};

let messageCounter = 0;

function message(text: string): IncomingChatMessage {
  messageCounter += 1;
  return {
    messageId: `1700000000.00${messageCounter + 200}`,
    channelId: "C-runtime",
    workspaceId: "T-runtime",
    threadId: THREAD_ID,
    senderId: "U-runtime",
    senderName: "Runtime User",
    text,
    rawText: text,
    timestamp: new Date(),
    isThreadReply: true,
  };
}

function fakeSlackProvider(sent: ChatReplyOptions[]): ChatOpsProvider {
  return {
    providerId: "slack",
    displayName: "Slack",
    isConfigured: () => true,
    initialize: async () => {},
    cleanup: async () => {},
    validateWebhookRequest: async () => true,
    handleValidationChallenge: () => null,
    parseWebhookNotification: async () => null,
    sendReply: async (options) => {
      sent.push(options);
      return "reply-id";
    },
    setTypingStatus: vi.fn().mockResolvedValue(undefined),
    clearTypingStatus: vi.fn().mockResolvedValue(undefined),
    parseInteractivePayload: () => null,
    sendAgentSelectionCard: async () => {},
    getThreadHistory: async () => [],
    getUserEmail: async () => "runtime-chat@example.com",
    getChannelName: async () => null,
    getWorkspaceId: () => null,
    getWorkspaceName: () => null,
    hasMissingScopes: () => false,
    notifyMissingScopes: async () => {},
    downloadFiles: async () => [],
    discoverChannels: async () => null,
    addApprovalRequestForm: async () => {},
    updateApprovalRequest: async () => {},
  };
}

async function latestRun() {
  const [task] = (
    await A2ATaskModel.listForActor({
      actorKind: "user",
      actorId: userId,
      agentId: agent.id,
      pageSize: 1,
    })
  ).tasks;
  return task ? await AgentRunModel.findByTaskId(task.id) : null;
}

/** A finished run from this thread whose workspace is still retained. */
async function retainedRun(params: { state: "idle" | "active" }) {
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: userId,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_COMPLETED",
  });
  const run = await AgentRunModel.create({
    organizationId: agent.organizationId,
    agentId: agent.id,
    taskId: task.id,
    actorKind: "user",
    actorId: userId,
    actorUserId: userId,
    workloadName: `retained-${task.id}`,
    backend: "kubernetes",
    runtimeScope: backend.resolveRuntimeScope({}),
    completionTarget: {
      type: "chatops",
      bindingId: binding.id,
      threadId: THREAD_ID,
    },
  });
  await AgentRunModel.close({ id: run.id });
  await AgentWorkspaceModel.create({
    id: task.id,
    organizationId: agent.organizationId,
    agentId: agent.id,
    actorKind: "user",
    actorId: userId,
    backend: "kubernetes",
    runtimeScope: run.runtimeScope,
    workloadName: run.workloadName,
    state: params.state,
    activeTaskId: params.state === "active" ? task.id : null,
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return run;
}

/** Connect the sender's personal Claude account, as the runtime requires. */
async function connectClaudeAccount() {
  oauthServer.use(
    http.post("https://platform.claude.com/v1/oauth/token", () =>
      HttpResponse.json({
        access_token: `sk-ant-oat01-${"example".repeat(8)}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "user:inference",
      }),
    ),
  );
  const owner = { runtime, userId };
  const flow = await claudeCodeAccountManager.start(owner);
  await claudeCodeAccountManager.complete({
    ...owner,
    flowId: flow.flowId as string,
    code: `example-code#${new URL(flow.authorizationUrl as string).searchParams.get("state")}`,
  });
}
