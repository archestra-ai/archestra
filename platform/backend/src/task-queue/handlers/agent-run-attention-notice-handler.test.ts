import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import config from "@/config";
import db, { schema } from "@/database";
import A2AContextModel from "@/models/a2a/context";
import A2ATaskModel from "@/models/a2a/task";
import AgentRunModel from "@/models/agent-run";
import AgentRunAttentionNoticeModel from "@/models/agent-run-attention-notice";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import ChatOpsConfigModel from "@/models/chatops-config";
import TaskModel from "@/models/task";
import { beforeEach, expect, mustExist, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { AgentRunRecord } from "@/types/agent-runtime";
import { handleAgentRunAttentionNotice } from "./agent-run-attention-notice-handler";

const THREAD = "1700000000.000100";
const MESSAGE = "1700000001.000200";
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
let run: AgentRunRecord;
let bindingId: string;
let posts: Record<string, string>[];
let edits: Record<string, string>[];
let postedMessages: Record<string, unknown>[];
let post: (body: Record<string, string>) => Promise<Response>;
let edit: (body: Record<string, string>) => Promise<Response>;
let history: () => Response;

beforeEach(async ({ makeUser, makeOrganization, makeAgent }) => {
  posts = [];
  edits = [];
  postedMessages = [];
  post = async (body) => {
    posts.push(body);
    postedMessages.push({
      ts: MESSAGE,
      bot_id: "BTEST",
      metadata: JSON.parse(body.metadata),
    });
    return HttpResponse.json({ ok: true, ts: MESSAGE });
  };
  edit = async (body) => {
    edits.push(body);
    return HttpResponse.json({ ok: true, ts: body.ts });
  };
  history = () => HttpResponse.json({ ok: true, messages: postedMessages });
  server.use(
    http.post("https://slack.com/api/auth.test", () =>
      HttpResponse.json({ ok: true, team_id: "TTEST", bot_id: "BTEST" }),
    ),
    http.post("https://slack.com/api/chat.postMessage", async ({ request }) =>
      post(Object.fromEntries(new URLSearchParams(await request.text()))),
    ),
    http.post("https://slack.com/api/chat.update", async ({ request }) =>
      edit(Object.fromEntries(new URLSearchParams(await request.text()))),
    ),
    http.post("https://slack.com/api/conversations.replies", () => history()),
  );
  await ChatOpsConfigModel.saveSlackConfig({
    enabled: true,
    botToken: "xoxb-test",
    signingSecret: "test",
    appId: "ATEST",
  });
  config.frontendBaseUrl = "https://app.example.test";
  const org = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({ organizationId: org.id, authorId: user.id });
  const binding = await ChatOpsChannelBindingModel.create({
    organizationId: org.id,
    provider: "slack",
    channelId: "CTEST",
    workspaceId: "TTEST",
    agentId: agent.id,
  });
  bindingId = binding.id;
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_WORKING",
  });
  run = await AgentRunModel.create({
    taskId: task.id,
    agentId: agent.id,
    organizationId: org.id,
    actorKind: "user",
    actorId: user.id,
    actorUserId: user.id,
    backend: "kubernetes",
    runtimeScope: "test",
    workloadName: `run-${task.id}`,
    title: "Private task details must stay in the app",
    completionTarget: {
      type: "chatops",
      bindingId: binding.id,
      threadId: THREAD,
    },
  });
});

test("posts one generic notice for concurrent repeated signals, edits it on clear, and starts a new episode", async () => {
  const policiesBefore = await db
    .select()
    .from(schema.resourcePermissionPoliciesTable);
  await Promise.all([
    attention("input_required"),
    attention("input_required"),
    attention("input_required"),
  ]);
  const notice = await onlyNotice();
  await deliverNext();
  // A redelivered queue job must not create another post.
  await handleAgentRunAttentionNotice({ noticeId: notice.id });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    channel: "CTEST",
    thread_ts: THREAD,
    unfurl_links: "false",
    unfurl_media: "false",
    reply_broadcast: "false",
  });
  expect(posts[0].text).toBe(
    `The runtime needs your input. Open run: https://app.example.test/chat/runs/${run.taskId}`,
  );
  const blocks = JSON.parse(posts[0].blocks);
  expect(blocks[1].elements).toEqual([
    {
      type: "button",
      action_id: "open_runtime_run",
      text: { type: "plain_text", text: "Open run" },
      url: `https://app.example.test/chat/runs/${run.taskId}`,
    },
  ]);
  expect(JSON.stringify(posts)).not.toContain(run.title);
  await attention(null);
  await deliverNext();
  await attention(null);
  await handleAgentRunAttentionNotice({ noticeId: notice.id });
  expect(edits).toHaveLength(1);
  expect(edits[0]).toMatchObject({ channel: "CTEST", ts: MESSAGE });
  expect(edits[0].text).toContain("Resolved");
  await attention("input_required");
  await deliverNext();
  expect(posts).toHaveLength(2);
  expect(
    await db.select().from(schema.resourcePermissionPoliciesTable),
  ).toEqual(policiesBefore);
  expect(await TaskModel.dequeue(["agent_run_attention_notice"])).toBeNull();
});

test("suppresses a queued notice that cleared before sending, even if a later episode needs input", async () => {
  await attention("input_required");
  const first = await onlyNotice();
  await attention(null);
  await attention("input_required");
  await handleAgentRunAttentionNotice({ noticeId: first.id });
  expect(posts).toHaveLength(0);
  expect(edits).toHaveLength(0);
});

test("resolves a clear that races an in-flight post", async () => {
  const original = post;
  post = async (body) => {
    await attention(null);
    return original(body);
  };
  await attention("input_required");
  await deliverNext();
  expect(posts).toHaveLength(1);
  expect(edits).toHaveLength(1);
  await deliverNext();
  expect(edits).toHaveLength(1);
});

test("recovers an accepted post whose response was lost, then resolves it without reposting", async () => {
  const original = post;
  post = async (body) => {
    await original(body);
    return HttpResponse.error();
  };
  await attention("input_required");
  const notice = await onlyNotice();
  await expect(
    handleAgentRunAttentionNotice({ noticeId: notice.id }),
  ).rejects.toThrow();
  expect(
    (await AgentRunAttentionNoticeModel.find(notice.id))?.claimId,
  ).toBeNull();
  await attention(null);
  post = original;
  await handleAgentRunAttentionNotice({ noticeId: notice.id });
  expect(posts).toHaveLength(1);
  expect(edits).toHaveLength(1);
  expect((await AgentRunAttentionNoticeModel.find(notice.id))?.messageTs).toBe(
    MESSAGE,
  );
});

test("retries a failed post after checking the thread, and a failed edit without reposting", async () => {
  const originalPost = post;
  post = async () => HttpResponse.json({ ok: false, error: "internal_error" });
  await attention("input_required");
  const notice = await onlyNotice();
  const task = await TaskModel.dequeue(["agent_run_attention_notice"]);
  if (!task) throw new Error("Expected queued notice");
  await expect(handleAgentRunAttentionNotice(task.payload)).rejects.toThrow();
  const retry = await TaskModel.fail({
    id: task.id,
    error: "Slack unavailable",
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
  });
  expect(retry?.status).toBe("pending");
  expect(mustExist(retry).scheduledFor.getTime()).toBeGreaterThan(Date.now());
  post = originalPost;
  await handleAgentRunAttentionNotice({ noticeId: notice.id });
  await attention(null);
  const originalEdit = edit;
  edit = async () => HttpResponse.json({ ok: false, error: "internal_error" });
  await expect(
    handleAgentRunAttentionNotice({ noticeId: notice.id }),
  ).rejects.toThrow();
  expect(
    (await AgentRunAttentionNoticeModel.find(notice.id))?.resolvedNotified,
  ).toBe(false);
  edit = originalEdit;
  await handleAgentRunAttentionNotice({ noticeId: notice.id });
  expect(posts).toHaveLength(1);
  expect(edits).toHaveLength(1);
});

test("fails safely when an uncertain post cannot be found without additional Slack permissions", async () => {
  post = async () => HttpResponse.error();
  await attention("input_required");
  const notice = await onlyNotice();
  await expect(
    handleAgentRunAttentionNotice({ noticeId: notice.id }),
  ).rejects.toThrow();
  history = () => HttpResponse.json({ ok: false, error: "missing_scope" });
  await expect(
    handleAgentRunAttentionNotice({ noticeId: notice.id }),
  ).rejects.toThrow();
  expect(posts).toHaveLength(0);
});

test("leases duplicate delivery and rejects writes from a superseded sender", async () => {
  await attention("input_required");
  const notice = await onlyNotice();
  const first = await AgentRunAttentionNoticeModel.claim(notice.id);
  await expect(
    handleAgentRunAttentionNotice({ noticeId: notice.id }),
  ).rejects.toThrow("being delivered");
  await db
    .update(schema.agentRunAttentionNoticesTable)
    .set({ claimedAt: new Date(Date.now() - 600_000) })
    .where(eq(schema.agentRunAttentionNoticesTable.id, notice.id));
  const second = await AgentRunAttentionNoticeModel.claim(notice.id);
  expect(second?.claimId).not.toBe(first?.claimId);
  await expect(
    AgentRunAttentionNoticeModel.save({
      id: notice.id,
      claimId: mustExist(first?.claimId),
      changes: { messageTs: MESSAGE },
    }),
  ).rejects.toThrow("lease lost");
  await AgentRunAttentionNoticeModel.release(
    notice.id,
    mustExist(first?.claimId),
  );
  expect((await AgentRunAttentionNoticeModel.find(notice.id))?.claimId).toBe(
    second?.claimId,
  );
  await AgentRunAttentionNoticeModel.release(
    notice.id,
    mustExist(second?.claimId),
  );
  await handleAgentRunAttentionNotice({ noticeId: notice.id });
  expect(posts).toHaveLength(1);
});

test.each([
  "missing",
  "email",
  "teams",
  "foreign-org",
  "missing-thread",
  "invalid-thread",
  "missing-channel",
])("does not enqueue for %s routing", async (kind) => {
  if (kind === "missing") await setTarget(null);
  if (kind === "email")
    await setTarget({
      type: "email",
      providerId: "test",
      originalMessageId: "test",
      fromAddress: "a@example.test",
      toAddress: "b@example.test",
      subject: null,
    });
  if (kind === "teams")
    await db
      .update(schema.chatopsChannelBindingsTable)
      .set({ provider: "ms-teams" })
      .where(eq(schema.chatopsChannelBindingsTable.id, bindingId));
  if (kind === "foreign-org")
    await db
      .update(schema.chatopsChannelBindingsTable)
      .set({ organizationId: "different-org" })
      .where(eq(schema.chatopsChannelBindingsTable.id, bindingId));
  if (kind === "missing-channel")
    await db
      .delete(schema.chatopsChannelBindingsTable)
      .where(eq(schema.chatopsChannelBindingsTable.id, bindingId));
  if (kind === "missing-thread" || kind === "invalid-thread")
    await setTarget({
      type: "chatops",
      bindingId,
      threadId: kind === "missing-thread" ? "" : "CTEST",
    });
  await attention("input_required");
  expect((await AgentRunModel.findByTaskId(run.taskId))?.attentionState).toBe(
    "input_required",
  );
  expect(
    await db.select().from(schema.agentRunAttentionNoticesTable),
  ).toHaveLength(0);
  expect(await TaskModel.dequeue(["agent_run_attention_notice"])).toBeNull();
});

test.each([
  "deleted",
  "retargeted",
  "foreign-org",
  "other-provider",
])("revalidates a %s binding before delivery", async (kind) => {
  await attention("input_required");
  if (kind === "deleted")
    await db
      .delete(schema.chatopsChannelBindingsTable)
      .where(eq(schema.chatopsChannelBindingsTable.id, bindingId));
  else
    await db
      .update(schema.chatopsChannelBindingsTable)
      .set({
        ...(kind === "retargeted" && { channelId: "COTHER" }),
        ...(kind === "foreign-org" && { organizationId: "different-org" }),
        ...(kind === "other-provider" && { provider: "ms-teams" as const }),
      })
      .where(eq(schema.chatopsChannelBindingsTable.id, bindingId));
  await deliverNext();
  expect(posts).toHaveLength(0);
});

test("uses the stored pinned bot in a worker without inbound Slack initialization", async () => {
  await setTarget({
    type: "chatops",
    bindingId,
    threadId: THREAD,
    pinnedAgentId: run.agentId,
  });
  await ChatOpsConfigModel.saveSlackAgentBot({
    agentId: run.agentId,
    enabled: true,
    botToken: "xoxb-pinned",
    signingSecret: "test",
    appId: "APINNED",
    connectionMode: "webhook",
  });
  let sender: string | null = null;
  server.use(
    http.post("https://slack.com/api/chat.postMessage", async ({ request }) => {
      sender = request.headers.get("authorization");
      return post(
        Object.fromEntries(new URLSearchParams(await request.text())),
      );
    }),
  );
  await attention("input_required");
  await deliverNext();
  expect(sender).toBe("Bearer xoxb-pinned");
  expect(posts).toHaveLength(1);
});

test("does not fall back to the main bot for an unavailable pinned bot", async () => {
  await setTarget({
    type: "chatops",
    bindingId,
    threadId: THREAD,
    pinnedAgentId: randomUUID(),
  });
  await attention("input_required");
  const notice = await onlyNotice();
  await expect(
    handleAgentRunAttentionNotice({ noticeId: notice.id }),
  ).rejects.toThrow("unavailable");
  expect(posts).toHaveLength(0);
});

test("rejects delivery through a bot in the wrong workspace", async () => {
  await db
    .update(schema.chatopsChannelBindingsTable)
    .set({ workspaceId: "TOTHER" })
    .where(eq(schema.chatopsChannelBindingsTable.id, bindingId));
  await attention("input_required");
  const notice = await onlyNotice();
  await expect(
    handleAgentRunAttentionNotice({ noticeId: notice.id }),
  ).rejects.toThrow("workspace mismatch");
  expect(posts).toHaveLength(0);
});

test("existing run closure resolves a notice and rejects stale attention hooks", async () => {
  await attention("input_required");
  await deliverNext();
  expect(await AgentRunModel.close({ id: run.id })).toBe(true);
  await deliverNext();
  expect(edits).toHaveLength(1);
  expect(await attention("input_required")).toBe(false);
  expect(await TaskModel.dequeue(["agent_run_attention_notice"])).toBeNull();
});

test("suppresses stale queued signals for terminal tasks before the run is closed", async () => {
  await attention("input_required");
  await A2ATaskModel.updateState(run.taskId, "TASK_STATE_COMPLETED");
  await deliverNext();
  expect(posts).toHaveLength(0);
  expect(await attention("input_required")).toBe(false);
});

test("auth-required alone creates no input notice and ends an input episode", async () => {
  await attention("auth_required");
  expect(await TaskModel.dequeue(["agent_run_attention_notice"])).toBeNull();
  await attention("input_required");
  await deliverNext();
  await attention("auth_required");
  await deliverNext();
  expect(posts).toHaveLength(1);
  expect(edits).toHaveLength(1);
});

async function attention(attentionState: AgentRunRecord["attentionState"]) {
  return AgentRunModel.updateAttentionState({
    taskId: run.taskId,
    attentionState,
  });
}
async function onlyNotice() {
  const notices = await db.select().from(schema.agentRunAttentionNoticesTable);
  expect(notices).toHaveLength(1);
  return notices[0];
}
async function deliverNext() {
  const task = await TaskModel.dequeue(["agent_run_attention_notice"]);
  if (!task) throw new Error("Expected queued notice");
  await handleAgentRunAttentionNotice(task.payload);
  await TaskModel.complete(task.id);
}
async function setTarget(completionTarget: AgentRunRecord["completionTarget"]) {
  await db
    .update(schema.agentRunsTable)
    .set({ completionTarget })
    .where(eq(schema.agentRunsTable.id, run.id));
}
