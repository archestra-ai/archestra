import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import db, { schema } from "@/database";
import A2AContextModel from "@/models/a2a/context";
import A2ATaskModel from "@/models/a2a/task";
import AgentRunModel from "@/models/agent-run";
import AgentRunAttentionNoticeModel from "@/models/agent-run-attention-notice";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import ChatOpsConfigModel from "@/models/chatops-config";
import { afterEach, beforeEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import type { AgentRunRecord } from "@/types/agent-runtime";
import type { JiraDbConfig } from "@/types/chatops-jira";
import { handleAgentRunAttentionNotice } from "./agent-run-attention-notice-handler";

setupTestCacheManager();
// biome-ignore lint/correctness/useHookAtTopLevel: test network lifecycle helper
const server = useMswServer();
const siteUrl = "https://example.atlassian.net";
let run: AgentRunRecord;
let jiraConfig: JiraDbConfig;
let posted: Record<string, unknown>[];
let edits: Record<string, unknown>[];
let loseResponse: boolean;

afterEach(() => archestraMcpBranding.syncFromOrganization(null));

beforeEach(async ({ makeOrganization, makeAgent, makeUser }) => {
  posted = [];
  edits = [];
  loseResponse = false;
  const organization = await makeOrganization();
  const user = await makeUser();
  const agent = await makeAgent({
    organizationId: organization.id,
    authorId: user.id,
    agentType: "agent",
  });
  const botId = randomUUID();
  jiraConfig = {
    id: randomUUID(),
    organizationId: organization.id,
    enabled: true,
    siteUrl,
    ingressMode: "hmac",
    webhookSecret: "synthetic-webhook-secret",
    bots: [
      {
        id: botId,
        agentId: agent.id,
        accountId: "bot-account",
        displayName: "Helpful Bot",
        email: "bot@example.test",
        apiToken: "synthetic-token",
        enabled: true,
      },
    ],
  };
  await ChatOpsConfigModel.saveJiraConfig(jiraConfig);
  const binding = await ChatOpsChannelBindingModel.create({
    organizationId: organization.id,
    provider: "jira",
    channelId: `${botId}:10000`,
    workspaceId: jiraConfig.id,
    agentId: agent.id,
  });
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
    organizationId: organization.id,
    actorKind: "user",
    actorId: user.id,
    actorUserId: user.id,
    backend: "kubernetes",
    runtimeScope: "test",
    workloadName: `run-${task.id}`,
    title: "Private runtime input must remain in UI",
    completionTarget: {
      type: "chatops",
      bindingId: binding.id,
      threadId: "20000",
      pinnedAgentId: agent.id,
    },
  });
  config.frontendBaseUrl = "https://app.example.test";
  server.use(
    http.get(`${siteUrl}/rest/api/3/issue/20000`, () =>
      HttpResponse.json({
        id: "20000",
        key: "DEMO-1",
        fields: {
          project: { id: "10000", key: "DEMO", name: "Disposable project" },
          summary: "Example issue",
          description: null,
          labels: [],
          security: null,
        },
      }),
    ),
    http.post(
      `${siteUrl}/rest/api/3/issue/20000/comment`,
      async ({ request }) => {
        const value = comment(
          (await request.json()) as Record<string, unknown>,
        );
        posted.push(value);
        return loseResponse ? HttpResponse.error() : HttpResponse.json(value);
      },
    ),
    http.get(`${siteUrl}/rest/api/3/issue/20000/comment`, () =>
      HttpResponse.json({ startAt: 0, total: posted.length, comments: posted }),
    ),
    http.get(`${siteUrl}/rest/api/3/issue/20000/comment/30000`, () =>
      HttpResponse.json(edits.at(-1) ?? posted[0]),
    ),
    http.put(
      `${siteUrl}/rest/api/3/issue/20000/comment/30000`,
      async ({ request }) => {
        const value = comment(
          (await request.json()) as Record<string, unknown>,
        );
        edits.push(value);
        return HttpResponse.json(value);
      },
    ),
  );
});

test("Jira runtime input posts one generic UI link and edits the same comment on clear", async () => {
  (
    config.enterpriseFeatures as { fullWhiteLabeling: boolean }
  ).fullWhiteLabeling = true;
  archestraMcpBranding.syncFromOrganization({
    appName: "Example Workspace",
    iconLogo: null,
  });
  const notice = await requireAttention();
  await handleAgentRunAttentionNotice({ noticeId: notice.id });
  await handleAgentRunAttentionNotice({ noticeId: notice.id });
  expect(posted).toHaveLength(1);
  expect(JSON.stringify(posted)).toContain(`/chat/runs/${run.taskId}`);
  expect(JSON.stringify(posted)).toContain("open Example Workspace UI");
  expect(JSON.stringify(posted)).not.toContain(run.title);
  await AgentRunModel.updateAttentionState({
    taskId: run.taskId,
    attentionState: null,
  });
  await handleAgentRunAttentionNotice({ noticeId: notice.id });
  await handleAgentRunAttentionNotice({ noticeId: notice.id });
  expect(edits).toHaveLength(1);
  expect(edits[0].id).toBe("30000");
  expect(JSON.stringify(edits)).toContain("Open Example Workspace UI");
  expect(
    (await AgentRunAttentionNoticeModel.find(notice.id))?.resolvedNotified,
  ).toBe(true);
});

test("lost Jira comment response reconciles before resolving, without reposting", async () => {
  const notice = await requireAttention();
  loseResponse = true;
  await expect(
    handleAgentRunAttentionNotice({ noticeId: notice.id }),
  ).rejects.toThrow();
  await AgentRunModel.updateAttentionState({
    taskId: run.taskId,
    attentionState: null,
  });
  await handleAgentRunAttentionNotice({ noticeId: notice.id });
  expect(posted).toHaveLength(1);
  expect(edits).toHaveLength(1);
});

test("a clear before dispatch and a removed bot suppress queued Jira notices", async () => {
  const notice = await requireAttention();
  await AgentRunModel.updateAttentionState({
    taskId: run.taskId,
    attentionState: null,
  });
  await handleAgentRunAttentionNotice({ noticeId: notice.id });
  expect(posted).toHaveLength(0);
  const second = await requireAttention();
  await ChatOpsConfigModel.saveJiraConfig({ ...jiraConfig, bots: [] });
  await handleAgentRunAttentionNotice({ noticeId: second.id });
  expect(posted).toHaveLength(0);
});

async function requireAttention() {
  await AgentRunModel.updateAttentionState({
    taskId: run.taskId,
    attentionState: "input_required",
  });
  const notices = await db.select().from(schema.agentRunAttentionNoticesTable);
  const notice = notices.find((candidate) => !candidate.resolved);
  if (!notice) throw new Error("Expected Jira attention notice");
  return notice;
}

function comment(value: Record<string, unknown>) {
  return {
    id: "30000",
    author: {
      accountId: "bot-account",
      displayName: "Helpful Bot",
      accountType: "atlassian",
    },
    created: "2026-10-26T10:00:00.000Z",
    updated: "2026-10-26T10:00:00.000Z",
    visibility: null,
    ...value,
  };
}
