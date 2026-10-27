import { createHmac, randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";

vi.mock("@/cache-manager");

import db, { schema } from "@/database";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import ChatOpsConfigModel from "@/models/chatops-config";
import { pollJiraChatOps } from "@/services/jira-chatops-poll";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { JiraBotConfig, JiraDbConfig } from "@/types/chatops-jira";
import { muteChannelThread } from "./channel-activation";
import { buildChatOpsSessionId } from "./chatops-manager";
import JiraProvider, {
  getJiraProject,
  jiraChannelId,
  listJiraProjects,
  verifyJiraBotIdentity,
} from "./jira-provider";

const siteUrl = "https://example.atlassian.net";
const cloudId = "11111111-1111-4111-8111-111111111111";
const gateway = `https://api.atlassian.com/ex/jira/${cloudId}`;
const timestamp = "2026-10-26T10:00:00.000Z";
const author = {
  accountId: "person-account",
  displayName: "Example Person",
  emailAddress: "person@example.test",
  accountType: "atlassian",
};
const project = { id: "10000", key: "DEMO", name: "Disposable project" };
const body = {
  type: "doc",
  version: 1,
  content: [
    {
      type: "paragraph",
      content: [
        { type: "mention", attrs: { id: "bot-account", text: "@Helpful Bot" } },
        { type: "text", text: " explain this issue" },
      ],
    },
  ],
};
let jiraConfig: JiraDbConfig;
let bot: JiraBotConfig;
let provider: JiraProvider;
let canonicalComment: ReturnType<typeof comment>;
let restrictedIssue: boolean;
let issueLabels: string[];
// biome-ignore lint/correctness/useHookAtTopLevel: test network lifecycle helper
const server = useMswServer(
  http.get(`${siteUrl}/rest/api/3/myself`, () =>
    HttpResponse.json({
      accountId: "bot-account",
      displayName: "Helpful Bot",
      accountType: "atlassian",
    }),
  ),
  http.get(`${siteUrl}/rest/api/3/issue/20000`, () =>
    HttpResponse.json({
      id: "20000",
      key: "DEMO-1",
      fields: {
        project,
        summary: "Example task",
        description: "Details",
        labels: issueLabels,
        security: restrictedIssue ? { id: "1" } : null,
      },
    }),
  ),
  http.get(`${siteUrl}/rest/api/3/issue/20000/comment/30000`, () =>
    HttpResponse.json(canonicalComment),
  ),
);

beforeEach(async ({ makeOrganization, makeAgent }) => {
  const organization = await makeOrganization();
  const agent = await makeAgent({
    organizationId: organization.id,
    agentType: "agent",
  });
  bot = {
    id: randomUUID(),
    agentId: agent.id,
    accountId: "bot-account",
    displayName: "Helpful Bot",
    email: "bot@example.test",
    apiToken: "synthetic-jira-token",
    enabled: true,
  };
  jiraConfig = {
    id: randomUUID(),
    organizationId: organization.id,
    enabled: true,
    siteUrl,
    ingressMode: "hmac",
    webhookSecret: "synthetic-webhook-secret",
    bots: [bot],
  };
  provider = new JiraProvider(jiraConfig, bot);
  canonicalComment = comment();
  restrictedIssue = false;
  issueLabels = [];
  await ChatOpsConfigModel.saveJiraConfig(jiraConfig);
  await ChatOpsChannelBindingModel.create({
    organizationId: organization.id,
    provider: "jira",
    channelId: jiraChannelId(bot.id, project.id),
    workspaceId: jiraConfig.id,
    agentId: agent.id,
  });
});

describe("Jira ingress authentication", () => {
  test("verifies exact raw HMAC bytes and rejects unsigned or modified payloads", async () => {
    const raw = JSON.stringify(event());
    const signature = `sha256=${createHmac("sha256", jiraConfig.webhookSecret).update(raw).digest("hex")}`;
    expect(
      await provider.validateWebhookRequest(raw, {
        "x-hub-signature": signature,
      }),
    ).toBe(true);
    expect(
      await provider.validateWebhookRequest(`${raw} `, {
        "x-hub-signature": signature,
      }),
    ).toBe(false);
    expect(await provider.validateWebhookRequest(raw, {})).toBe(false);
    expect(
      await provider.validateWebhookRequest(raw, {
        "x-hub-signature": [signature, signature],
      }),
    ).toBe(false);
  });

  test("Automation mode uses its own exact secret header", async () => {
    jiraConfig.ingressMode = "automation";
    expect(
      await provider.validateWebhookRequest("{}", {
        "x-archestra-jira-secret": jiraConfig.webhookSecret,
      }),
    ).toBe(true);
    expect(
      await provider.validateWebhookRequest("{}", {
        authorization: jiraConfig.webhookSecret,
      }),
    ).toBe(false);
    expect(
      await provider.validateWebhookRequest("{}", {
        "x-archestra-jira-secret": `${jiraConfig.webhookSecret} `,
      }),
    ).toBe(false);
  });
});

test("canonical REST author, body and project control routing, not webhook claims", async () => {
  const message = await provider.parseWebhookNotification({
    ...event(),
    comment: {
      ...event().comment,
      author: { accountId: "forged-author" },
      body: "forged body",
    },
    issue: { id: "20000", fields: { project: { id: "other-project" } } },
  });
  expect(message).toMatchObject({
    senderId: author.accountId,
    senderEmail: author.emailAddress,
    text: "explain this issue",
    channelId: jiraChannelId(bot.id, project.id),
    workspaceId: jiraConfig.id,
    threadId: "20000",
    isThreadReply: true,
  });
  expect(message?.metadata).toMatchObject({
    jiraRequesterAccountId: author.accountId,
    jiraCommentId: "30000",
    jiraCommentUpdated: timestamp,
  });
});

test("approval links open the actual Jira model-session review page rather than a native runtime", async () => {
  let posted = "";
  server.use(
    http.post(
      `${siteUrl}/rest/api/3/issue/20000/comment`,
      async ({ request }) => {
        const payload = await request.json();
        posted = JSON.stringify(payload);
        return HttpResponse.json(comment({ id: "40000", body: payload }));
      },
    ),
  );
  const message = await provider.parseWebhookNotification(event());
  if (!message) throw new Error("Expected a canonical mention");
  await provider.addApprovalRequestForm({
    channelId: message.channelId,
    threadId: message.threadId,
    approvalId: "review-123",
    taskId: randomUUID(),
    toolName: "example_tool",
    reviewText: "Review the proposed change before deciding.",
    originalMessage: message,
  });
  const sessionId = buildChatOpsSessionId(
    "jira",
    message.channelId,
    message.threadId,
  );
  expect(posted).toContain(`/llm/logs/${encodeURIComponent(sessionId)}`);
  expect(posted).not.toContain("/chat/runs/");
  expect(posted).toContain("approve review-123");
  expect(posted).toContain("decline review-123");
  expect(posted).toContain("Review the proposed change before deciding.");
});

test("accepts an Automation timestamp for the same revision regardless of timezone or fractional formatting", async () => {
  const notification = event();
  notification.comment.updated = "2026-10-26T06:00:00.0-0400";
  expect(await provider.parseWebhookNotification(notification)).toMatchObject({
    senderId: author.accountId,
    metadata: { jiraCommentUpdated: timestamp },
  });
  notification.comment.updated = "2026-10-26T06:00:00.001-0400";
  expect(await provider.parseWebhookNotification(notification)).toBeNull();
});

test("drops own bots, stale revisions and restricted content before activating", async () => {
  canonicalComment = comment({
    author: { ...author, accountId: bot.accountId },
  });
  expect(await provider.parseWebhookNotification(event())).toBeNull();
  canonicalComment = comment({ updated: "2026-10-26T10:01:00.000Z" });
  expect(await provider.parseWebhookNotification(event())).toBeNull();
  canonicalComment = comment({
    visibility: { type: "role", value: "Restricted" },
  });
  expect(await provider.parseWebhookNotification(event())).toBeNull();
  canonicalComment = comment();
  restrictedIssue = true;
  expect(await provider.parseWebhookNotification(event())).toBeNull();
});

test("comment edits run as the canonical editor, never the original comment author", async () => {
  const updated = "2026-10-26T10:01:00.000Z";
  const editor = {
    ...author,
    accountId: "editor-account",
    displayName: "Example Editor",
    emailAddress: "editor@example.test",
  };
  canonicalComment = comment({ updated, updateAuthor: editor });
  const updateEvent = {
    ...event(),
    webhookEvent: "comment_updated",
    comment: { id: "30000", updated },
  };
  expect(await provider.parseWebhookNotification(updateEvent)).toMatchObject({
    senderId: editor.accountId,
    senderEmail: editor.emailAddress,
  });
  expect(
    await provider.parseWebhookNotification({
      ...updateEvent,
      webhookEvent: "comment_created",
    }),
  ).toBeNull();
  canonicalComment = comment({ updated, updateAuthor: undefined });
  expect(await provider.parseWebhookNotification(updateEvent)).toBeNull();
});

test("a disabled bot, muted issue or newly restricted comment cannot post a late reply", async () => {
  const message = await provider.parseWebhookNotification(event());
  if (!message) throw new Error("Expected a canonical mention");
  issueLabels = ["archestra-mute"];
  await expect(
    provider.sendReply({ originalMessage: message, text: "Late reply" }),
  ).rejects.toThrow("project binding");
  issueLabels = [];
  canonicalComment = comment({
    visibility: { type: "role", value: "Restricted" },
  });
  await expect(
    provider.sendReply({ originalMessage: message, text: "Late reply" }),
  ).rejects.toThrow("Restricted Jira comments");
  canonicalComment = comment();
  await ChatOpsConfigModel.saveJiraConfig({ ...jiraConfig, enabled: false });
  await expect(
    provider.sendReply({ originalMessage: message, text: "Late reply" }),
  ).rejects.toThrow("no longer enabled");
});

test("history includes issue context and excludes the triggering comment by event id", async () => {
  server.use(
    http.get(`${siteUrl}/rest/api/3/issue/20000/comment`, () =>
      HttpResponse.json({
        startAt: 0,
        total: 2,
        comments: [
          comment(),
          comment({ id: "29999", body: "Earlier question" }),
        ],
      }),
    ),
  );
  const history = await provider.getThreadHistory({
    channelId: jiraChannelId(bot.id, project.id),
    workspaceId: jiraConfig.id,
    threadId: "20000",
    excludeMessageId: `jira:${jiraConfig.id}:${bot.id}:30000:${timestamp}`,
  });
  expect(history.map((item) => item.text)).toEqual([
    "DEMO-1: Example task\n\nDetails",
    "Earlier question",
  ]);
});

test("identity verification does not require a visible email and fences redirects", async () => {
  await expect(
    verifyJiraBotIdentity({
      siteUrl: `${siteUrl}/jira/`,
      email: bot.email,
      apiToken: bot.apiToken,
    }),
  ).resolves.toEqual({
    accountId: bot.accountId,
    displayName: bot.displayName,
  });
  server.use(
    http.get(`${siteUrl}/rest/api/3/myself`, () =>
      HttpResponse.redirect("https://other.atlassian.net/rest/api/3/myself"),
    ),
  );
  await expect(provider.initialize()).rejects.toThrow();
});

test("scoped token verification discovers the tenant without credentials and authenticates only at the fixed gateway", async () => {
  let tenantCalls = 0;
  let gatewayCalls = 0;
  let siteIdentityCalls = 0;
  server.use(
    http.get(`${siteUrl}/_edge/tenant_info`, ({ request }) => {
      tenantCalls++;
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.credentials).toBe("omit");
      return HttpResponse.json({ cloudId });
    }),
    http.get(`${siteUrl}/rest/api/3/myself`, () => {
      siteIdentityCalls++;
      return new HttpResponse(null, { status: 400 });
    }),
    http.get(`${gateway}/rest/api/3/myself`, ({ request }) => {
      gatewayCalls++;
      expect(request.headers.get("authorization")).toBe(
        `Basic ${Buffer.from(`${bot.email}:${bot.apiToken}`).toString("base64")}`,
      );
      return HttpResponse.json({
        accountId: bot.accountId,
        displayName: bot.displayName,
        active: true,
      });
    }),
  );
  expect(
    await verifyJiraBotIdentity({
      siteUrl: `${siteUrl}/jira/`,
      email: bot.email,
      apiToken: bot.apiToken,
      tokenType: "scoped",
    }),
  ).toEqual({
    accountId: bot.accountId,
    displayName: bot.displayName,
    cloudId,
  });
  expect(tenantCalls).toBe(1);
  expect(gatewayCalls).toBe(1);
  expect(siteIdentityCalls).toBe(0);
});

test("scoped tenant discovery rejects redirects and non-UUID cloud identifiers before sending credentials", async () => {
  let gatewayCalls = 0;
  let redirectTargetCalls = 0;
  server.use(
    http.get(`${siteUrl}/_edge/tenant_info`, () =>
      HttpResponse.json({ cloudId: "../../other-tenant" }),
    ),
    http.get(`${gateway}/rest/api/3/myself`, () => {
      gatewayCalls++;
      return HttpResponse.json(author);
    }),
  );
  const credentials = {
    siteUrl,
    email: bot.email,
    apiToken: bot.apiToken,
    tokenType: "scoped" as const,
  };
  await expect(verifyJiraBotIdentity(credentials)).rejects.toThrow();
  server.use(
    http.get(`${siteUrl}/_edge/tenant_info`, () =>
      HttpResponse.redirect("https://other.atlassian.net/_edge/tenant_info"),
    ),
  );
  await expect(verifyJiraBotIdentity(credentials)).rejects.toThrow();
  expect(gatewayCalls).toBe(0);
  server.use(
    http.get(`${siteUrl}/_edge/tenant_info`, () =>
      HttpResponse.json({ cloudId }),
    ),
    http.get(`${gateway}/rest/api/3/myself`, () =>
      HttpResponse.redirect("https://other.atlassian.net/rest/api/3/myself"),
    ),
    http.get("https://other.atlassian.net/rest/api/3/myself", () => {
      redirectTargetCalls++;
      return HttpResponse.json(author);
    }),
  );
  await expect(verifyJiraBotIdentity(credentials)).rejects.toThrow();
  expect(redirectTargetCalls).toBe(0);
});

test("persisted scoped identities route provider reads, writes and project helpers through the gateway", async () => {
  bot = { ...bot, cloudId };
  jiraConfig = { ...jiraConfig, bots: [bot] };
  await ChatOpsConfigModel.saveJiraConfig(jiraConfig);
  provider = new JiraProvider(jiraConfig, bot);
  let posts = 0;
  server.use(
    http.get(`${gateway}/rest/api/3/issue/20000`, () =>
      HttpResponse.json({
        id: "20000",
        key: "DEMO-1",
        fields: {
          project,
          summary: "Example task",
          description: "Details",
          labels: [],
          security: null,
        },
      }),
    ),
    http.get(`${gateway}/rest/api/3/issue/20000/comment/30000`, () =>
      HttpResponse.json(canonicalComment),
    ),
    http.get(`${gateway}/rest/api/3/user`, () => HttpResponse.json(author)),
    http.get(`${gateway}/rest/api/3/project/search`, () =>
      HttpResponse.json({ values: [project], isLast: true }),
    ),
    http.get(`${gateway}/rest/api/3/project/10000`, () =>
      HttpResponse.json(project),
    ),
    http.post(
      `${gateway}/rest/api/3/issue/20000/comment`,
      async ({ request }) => {
        posts++;
        expect(request.headers.get("authorization")).toBe(
          `Basic ${Buffer.from(`${bot.email}:${bot.apiToken}`).toString("base64")}`,
        );
        const posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          comment({
            id: "40000",
            body: posted.body,
            author: { ...author, accountId: bot.accountId },
          }),
        );
      },
    ),
  );
  expect(await provider.getUserEmail(author.accountId)).toBe(
    author.emailAddress,
  );
  expect(await listJiraProjects({ config: jiraConfig, bot })).toEqual([
    project,
  ]);
  expect(
    await getJiraProject({ config: jiraConfig, bot, projectId: project.id }),
  ).toEqual(project);
  const message = await provider.parseWebhookNotification(event());
  if (!message) throw new Error("Expected a scoped canonical mention");
  expect(
    await provider.sendReply({
      originalMessage: message,
      text: "Scoped reply",
    }),
  ).toBe("40000");
  expect(posts).toBe(1);
});

test("hidden email stays unresolved and transient rate limits retry only bounded reads", async () => {
  let attempts = 0;
  server.use(
    http.get(`${siteUrl}/rest/api/3/user`, () => {
      attempts++;
      if (attempts === 1)
        return new HttpResponse(null, {
          status: 429,
          headers: { "retry-after": "0" },
        });
      return HttpResponse.json({
        accountId: author.accountId,
        displayName: author.displayName,
      });
    }),
  );
  expect(await provider.getUserEmail(author.accountId)).toBeNull();
  expect(attempts).toBe(2);
  server.use(
    http.get(
      `${siteUrl}/rest/api/3/user`,
      () => new HttpResponse(null, { status: 403 }),
    ),
  );
  expect(await provider.getUserEmail(author.accountId)).toBeNull();
});

test("inactive bot credentials and inaccessible issues cannot route work", async () => {
  server.use(
    http.get(`${siteUrl}/rest/api/3/myself`, () =>
      HttpResponse.json({
        accountId: bot.accountId,
        displayName: bot.displayName,
        active: false,
      }),
    ),
  );
  await expect(
    verifyJiraBotIdentity({
      siteUrl,
      email: bot.email,
      apiToken: bot.apiToken,
    }),
  ).rejects.toThrow("inactive");
  server.use(
    http.get(
      `${siteUrl}/rest/api/3/issue/20000`,
      () => new HttpResponse(null, { status: 404 }),
    ),
  );
  expect(await provider.parseWebhookNotification(event())).toBeNull();
});

test("project discovery paginates and uses canonical project lookup", async () => {
  server.use(
    http.get(`${siteUrl}/rest/api/3/project/search`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("startAt") === "0"
          ? { values: [project], isLast: false }
          : {
              values: [{ id: "10001", key: "OTHER", name: "Other project" }],
              isLast: true,
            },
      ),
    ),
    http.get(`${siteUrl}/rest/api/3/project/10000`, () =>
      HttpResponse.json(project),
    ),
  );
  expect(await listJiraProjects({ config: jiraConfig, bot })).toHaveLength(2);
  expect(
    await getJiraProject({ config: jiraConfig, bot, projectId: "10000" }),
  ).toEqual(project);
  await expect(
    getJiraProject({ config: jiraConfig, bot, projectId: "../myself" }),
  ).rejects.toThrow("Invalid Jira identifier");
});

test("outbound retries reuse the durable comment and plain ADF body", async () => {
  let posts = 0;
  let posted: Record<string, unknown> | undefined;
  server.use(
    http.post(
      `${siteUrl}/rest/api/3/issue/20000/comment`,
      async ({ request }) => {
        posts++;
        posted = (await request.json()) as Record<string, unknown>;
        // Jira's entity-property endpoint rejects scalar JSON property values.
        const properties = posted.properties as Array<{ value: unknown }>;
        if (
          properties.some(
            ({ value }) => typeof value !== "object" || value === null,
          )
        )
          return new HttpResponse(null, { status: 400 });
        return HttpResponse.json(
          comment({
            id: "40000",
            author: { ...author, accountId: bot.accountId },
            body: posted.body,
            properties: posted.properties,
          }),
        );
      },
    ),
  );
  const message = await provider.parseWebhookNotification(event());
  if (!message) throw new Error("Expected a canonical mention");
  expect(
    await provider.sendReply({
      originalMessage: message,
      text: "[~accountid:someone] is literal text",
    }),
  ).toBe("40000");
  expect(
    await provider.sendReply({
      originalMessage: message,
      text: "[~accountid:someone] is literal text",
    }),
  ).toBe("40000");
  expect(posts).toBe(1);
  expect(posted).toMatchObject({
    body: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "[~accountid:someone] is literal text" },
          ],
        },
      ],
    },
    properties: [
      {
        key: "archestra.operation",
        value: { operationId: expect.any(String) },
      },
    ],
  });
});

test("final reply replaces its placeholder once and cleanup preserves the answer", async () => {
  let posts = 0;
  let replacements = 0;
  server.use(
    http.post(
      `${siteUrl}/rest/api/3/issue/20000/comment`,
      async ({ request }) => {
        posts++;
        const posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          comment({
            id: "40000",
            body: posted.body,
            author: { ...author, accountId: bot.accountId },
          }),
        );
      },
    ),
    http.put(
      `${siteUrl}/rest/api/3/issue/20000/comment/40000`,
      async ({ request }) => {
        replacements++;
        const posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          comment({
            id: "40000",
            body: posted.body,
            author: { ...author, accountId: bot.accountId },
          }),
        );
      },
    ),
  );
  const message = await provider.parseWebhookNotification(event());
  if (!message) throw new Error("Expected a canonical mention");
  await provider.setTypingStatus(message.channelId, "20000", message.metadata);
  await provider.sendReply({ originalMessage: message, text: "The answer" });
  await provider.clearTypingStatus(
    message.channelId,
    "20000",
    message.metadata,
  );
  await provider.sendReply({ originalMessage: message, text: "The answer" });
  expect(posts).toBe(1);
  expect(replacements).toBe(1);
});

test("an explicit write rate limit permits retry without rerunning the agent", async () => {
  let posts = 0;
  server.use(
    http.post(
      `${siteUrl}/rest/api/3/issue/20000/comment`,
      async ({ request }) => {
        posts++;
        if (posts === 1) return new HttpResponse(null, { status: 429 });
        const posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          comment({
            id: "40000",
            body: posted.body,
            author: { ...author, accountId: bot.accountId },
          }),
        );
      },
    ),
  );
  const message = await provider.parseWebhookNotification(event());
  if (!message) throw new Error("Expected a canonical mention");
  await expect(
    provider.sendReply({ originalMessage: message, text: "The answer" }),
  ).rejects.toThrow();
  expect(
    await provider.sendReply({ originalMessage: message, text: "The answer" }),
  ).toBe("40000");
  expect(posts).toBe(2);
});

test("a lost POST response reconciles its own correlation property without posting twice", async () => {
  let posts = 0;
  let created: ReturnType<typeof comment> | undefined;
  server.use(
    http.post(
      `${siteUrl}/rest/api/3/issue/20000/comment`,
      async ({ request }) => {
        posts++;
        const posted = (await request.json()) as Record<string, unknown>;
        created = comment({
          id: "40000",
          body: posted.body,
          author: { ...author, accountId: bot.accountId },
          properties: posted.properties,
        });
        return HttpResponse.error();
      },
    ),
    http.get(`${siteUrl}/rest/api/3/issue/20000/comment`, () =>
      HttpResponse.json({
        startAt: 0,
        total: created ? 1 : 0,
        comments: created ? [created] : [],
      }),
    ),
  );
  const message = await provider.parseWebhookNotification(event());
  if (!message) throw new Error("Expected a canonical mention");
  await expect(
    provider.sendReply({ originalMessage: message, text: "The answer" }),
  ).rejects.toThrow();
  expect(
    await provider.sendReply({ originalMessage: message, text: "The answer" }),
  ).toBe("40000");
  expect(posts).toBe(1);
});

function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: "30000",
    body,
    author,
    updateAuthor: author,
    created: timestamp,
    updated: timestamp,
    visibility: null,
    ...overrides,
  };
}

function event() {
  return {
    webhookEvent: "comment_created",
    issue: { id: "20000" },
    comment: { id: "30000", updated: timestamp },
  };
}

test("an exact approval reply survives inactive thread gating but respects mute", async () => {
  canonicalComment = comment({ body: "approve review-123" });
  expect((await provider.parseWebhookNotification(event()))?.text).toBe(
    "approve review-123",
  );
  await muteChannelThread({
    provider: "jira",
    channelId: jiraChannelId(bot.id, project.id),
    threadId: "20000",
    scope: provider.stateScope,
  });
  expect(await provider.parseWebhookNotification(event())).toBeNull();
});

test("polling scans all comment pages for edits to old comments, bounded by project and time", async () => {
  const requests: string[] = [];
  server.use(
    http.get(`${siteUrl}/rest/api/3/search/jql`, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get("jql")).toContain(
        "project in (10000) AND updated >= -",
      );
      return HttpResponse.json({
        isLast: true,
        issues: [{ id: "20000", fields: { project, labels: [] } }],
      });
    }),
    http.get(`${siteUrl}/rest/api/3/issue/20000/comment`, ({ request }) => {
      const start = new URL(request.url).searchParams.get("startAt");
      requests.push(start ?? "");
      return HttpResponse.json({
        startAt: Number(start),
        total: 2,
        comments:
          start === "0"
            ? [comment({ id: "29999", created: "2020-01-01T00:00:00.000Z" })]
            : [comment({ updated: "2026-10-26T11:00:00.000Z" })],
      });
    }),
  );
  const events = [];
  for await (const event of provider.pollCommentEvents({
    projectIds: [project.id],
    since: new Date("2026-10-26T09:00:00.000Z"),
    until: new Date("2026-10-26T10:30:00.000Z"),
  }))
    events.push(event);
  expect(requests).toEqual(["0", "1"]);
  expect(events).toEqual([
    {
      webhookEvent: "comment_updated",
      issue: { id: "20000" },
      comment: { id: "29999", updated: timestamp },
    },
  ]);
});

test("polling refuses to checkpoint an incomplete comment page", async () => {
  server.use(
    http.get(`${siteUrl}/rest/api/3/search/jql`, () =>
      HttpResponse.json({
        isLast: true,
        issues: [{ id: "20000", fields: { project, labels: [] } }],
      }),
    ),
    http.get(`${siteUrl}/rest/api/3/issue/20000/comment`, () =>
      HttpResponse.json({ startAt: 0, total: 1, comments: [] }),
    ),
  );
  await expect(async () => {
    for await (const _event of provider.pollCommentEvents({
      projectIds: [project.id],
      since: new Date(timestamp),
      until: new Date(),
    })) {
      /* no complete page */
    }
  }).rejects.toThrow("checkpoint retained");
});

test("periodic polling persists its cursor only after receipts commit and dedupes overlapping passes", async () => {
  const since = "2026-10-26T09:00:00.000Z";
  await ChatOpsConfigModel.saveJiraConfig({
    ...jiraConfig,
    ingressMode: "poll",
    pollSince: since,
    pollStartedAt: since,
  });
  server.use(
    http.get(`${siteUrl}/rest/api/3/search/jql`, () =>
      HttpResponse.json({
        isLast: true,
        issues: [{ id: "20000", fields: { project, labels: [] } }],
      }),
    ),
    http.get(`${siteUrl}/rest/api/3/issue/20000/comment`, () =>
      HttpResponse.json({ startAt: 0, total: 1, comments: [comment()] }),
    ),
  );
  await pollJiraChatOps();
  const saved = await ChatOpsConfigModel.getJiraConfig();
  expect(Date.parse(saved?.pollSince ?? "")).toBeGreaterThan(Date.parse(since));
  expect(await db.select().from(schema.jiraChatOpsEventsTable)).toHaveLength(1);
  // Replay the same window, as after a worker loses its checkpoint write.
  await ChatOpsConfigModel.saveJiraConfig({
    ...jiraConfig,
    ingressMode: "poll",
    pollSince: since,
    pollStartedAt: since,
  });
  await pollJiraChatOps();
  expect(await db.select().from(schema.jiraChatOpsEventsTable)).toHaveLength(1);
  expect(
    (await db.select().from(schema.tasksTable)).filter(
      (task) => task.taskType === "jira_chatops_event",
    ),
  ).toHaveLength(1);
});

test("a failed Jira poll leaves its durable checkpoint unchanged", async () => {
  const since = "2026-10-26T09:00:00.000Z";
  await ChatOpsConfigModel.saveJiraConfig({
    ...jiraConfig,
    ingressMode: "poll",
    pollSince: since,
    pollStartedAt: since,
  });
  server.use(
    http.get(
      `${siteUrl}/rest/api/3/search/jql`,
      () => new HttpResponse(null, { status: 429 }),
    ),
  );
  await expect(pollJiraChatOps()).rejects.toThrow();
  expect((await ChatOpsConfigModel.getJiraConfig())?.pollSince).toBe(since);
});
