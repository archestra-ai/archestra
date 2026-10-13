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
import { kubernetesAgentRuntimeBackendDriver as backend } from "@/services/agent-runtime/backends/kubernetes";
import { claudeCodeAccountManager } from "@/services/agent-runtime/claude-code-account";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import { afterEach, beforeEach, expect, test } from "@/test";
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
import { chatOpsManager } from "./chatops-manager";

const THREAD_ID = "1700000000.000100";

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
  },
);

test("a message to an Agent Runtime agent starts a run in its runtime and reports the outcome to the thread", async () => {
  const executor = vi.spyOn(a2aExecutor, "executeA2AMessage");
  const launch = vi
    .spyOn(backend, "launch")
    .mockRejectedValue(new Error("Runtime transport unavailable"));
  const notify = vi
    .spyOn(chatOpsManager, "notifyBindingThread")
    .mockResolvedValue();

  const result = await chatOpsManager.processMessage({
    message: message("Fix the flaky test"),
    provider,
  });

  expect(result.success).toBe(true);
  expect(executor).not.toHaveBeenCalled();
  await expect.poll(() => launch.mock.calls.length).toBe(1);
  const run = await latestRun();
  expect(run?.completionTarget).toEqual({
    type: "chatops",
    bindingId: binding.id,
    threadId: THREAD_ID,
  });
  expect(replies).toHaveLength(1);
  expect(replies[0].text).toContain(`/chat/runs/${run?.taskId}`);

  expect(JSON.stringify(launch.mock.calls[0][0])).toContain(
    "Fix the flaky test",
  );
  // The settled run reaches the thread it started from.
  await expect.poll(() => notify.mock.calls.length).toBe(1);
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      bindingId: binding.id,
      threadId: THREAD_ID,
      text: expect.stringContaining("Runtime transport unavailable"),
    }),
  );
});

test("a follow-up in the thread continues the sender's workspace", async () => {
  const previous = await retainedRun({ state: "idle" });
  const launch = vi.spyOn(backend, "launch");
  const continuation = vi
    .spyOn(backend, "continueRun")
    .mockRejectedValue(new Error("Runtime transport unavailable"));
  vi.spyOn(chatOpsManager, "notifyBindingThread").mockResolvedValue();

  const result = await chatOpsManager.processMessage({
    message: message("Now open a pull request"),
    provider,
  });

  expect(result.success).toBe(true);
  await expect.poll(() => continuation.mock.calls.length).toBe(1);
  expect(continuation.mock.calls[0][0].spec.frozenName).toBe(
    previous.workloadName,
  );
  expect(launch).not.toHaveBeenCalled();
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
