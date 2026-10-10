import { SLACK_REQUIRED_BOT_SCOPES } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import * as a2aExecutor from "@/agents/a2a-executor";
import { AgentTeamModel, ChatOpsChannelBindingModel } from "@/models";
import AgentSuggestedPromptModel from "@/models/agent-suggested-prompt";
import { describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import { ChatOpsManager } from "./chatops-manager";
import SlackProvider from "./slack-provider";
import { EventDedupMap } from "./utils";

// The real cache, stored in this file's test database.
setupTestCacheManager();

// biome-ignore lint/correctness/useHookAtTopLevel: registers test lifecycle hooks, not a React hook
const server = useMswServer();

describe("mention reply delivery", () => {
  test.for([
    "message",
    "app_mention",
  ])("replies once after a Stop when %s arrives first", async (firstType, {
    makeUser,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeInternalAgent,
  }) => {
    const user = await makeUser({ email: "mention-user@example.com" });
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeInternalAgent({ organizationId: org.id });
    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);
    // The model is the boundary: the agent greets a bare mention.
    vi.spyOn(a2aExecutor, "executeA2AMessage").mockResolvedValue({
      text: "Hi! What can I do for you?",
      messageId: "agent-greeting",
      finishReason: "stop",
      responseUiMessage: {
        id: "agent-greeting",
        role: "assistant",
        parts: [{ type: "text", text: "Hi! What can I do for you?" }],
      },
    });
    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "slack",
      channelId: "C_TEST",
      workspaceId: "T_TEST",
      agentId: agent.id,
    });

    const posts: URLSearchParams[] = [];
    const sessionStatuses: string[] = [];
    server.use(
      http.post(
        "https://slack.com/api/agents.sessions.setStatus",
        async ({ request }) => {
          sessionStatuses.push(
            new URLSearchParams(await request.text()).get("status") ?? "",
          );
          return HttpResponse.json({ ok: true });
        },
      ),
      http.post("https://slack.com/api/auth.test", () =>
        HttpResponse.json(
          { ok: true, user_id: "UBOT123", team_id: "T_TEST", team: "Test" },
          {
            headers: { "x-oauth-scopes": SLACK_REQUIRED_BOT_SCOPES.join(",") },
          },
        ),
      ),
      http.post("https://slack.com/api/users.info", () =>
        HttpResponse.json({
          ok: true,
          user: { real_name: "Test User", profile: { email: user.email } },
        }),
      ),
      http.post("https://slack.com/api/conversations.list", () =>
        HttpResponse.json({ ok: true, channels: [] }),
      ),
      http.post("https://slack.com/api/conversations.replies", () =>
        HttpResponse.json({ ok: true, messages: [] }),
      ),
      http.post("https://slack.com/api/chat.getPermalink", () =>
        HttpResponse.json({ ok: true, permalink: "https://slack.test/p1" }),
      ),
      http.post(
        "https://slack.com/api/chat.postMessage",
        async ({ request }) => {
          posts.push(new URLSearchParams(await request.text()));
          return HttpResponse.json({ ok: true, ts: "100.000010" });
        },
      ),
    );
    const provider = new SlackProvider({
      enabled: true,
      connectionMode: "webhook",
      botToken: "xoxb-test",
      signingSecret: "test-secret",
      appId: "A_TEST",
    });
    await provider.initialize();
    const manager = new ChatOpsManager();
    const payload = (event: { type: string; text: string; ts: string }) => ({
      type: "event_callback",
      team_id: "T_TEST",
      event: {
        channel: "C_TEST",
        channel_type: "channel",
        user: "U_TEST",
        thread_ts: "100.000001",
        ...event,
      },
    });
    try {
      await manager.handleIncomingMessage(
        provider,
        payload({
          type: "app_mention",
          text: "<@UBOT123>",
          ts: "100.000002",
        }),
      );
      expect(posts).toHaveLength(1);
      await manager.handleIncomingMessage(provider, {
        type: "event_callback",
        team_id: "T_TEST",
        event: {
          type: "agent_session_stopped",
          channel: "C_TEST",
          thread_ts: "100.000001",
          user: "U_TEST",
          event_ts: "100.000003",
          streaming_message_ts: [],
        },
      });
      // Stopping posts nothing; it moves the session out of "processing".
      expect(posts).toHaveLength(1);
      expect(sessionStatuses.at(-1)).toBe("active");
      await manager.handleIncomingMessage(
        provider,
        payload({
          type: "message",
          text: "hello",
          ts: "100.000004",
        }),
      );
      expect(posts).toHaveLength(1);

      // The ingress cache keeps only the first twin. Exercise the actual
      // parser, manager, database claim, and HTTP reply for either order.
      const dedup = new EventDedupMap();
      for (const type of [
        firstType,
        firstType === "message" ? "app_mention" : "message",
      ]) {
        const body = payload({ type, text: "<@UBOT123>   ", ts: "100.000005" });
        if (!dedup.mark(body.event.ts)) {
          await manager.handleIncomingMessage(provider, body);
        }
      }
      expect(posts).toHaveLength(2);
      expect(posts[1].get("text")).toContain("Hi! What can I do for you?");
      expect(posts[1].get("channel")).toBe("C_TEST");
      expect(posts[1].get("thread_ts")).toBe("100.000001");

      // A retry on another process bypasses the in-memory cache but still
      // must not post again: the database claim owns reply deduplication.
      await manager.handleIncomingMessage(
        provider,
        payload({
          type: "app_mention",
          text: "<@UBOT123>",
          ts: "100.000005",
        }),
      );
      expect(posts).toHaveLength(2);
    } finally {
      await provider.cleanup();
      await manager.cleanup();
    }
  });
});

describe("suggested prompts", () => {
  test("opening the DM offers the bound agent's prompts once per change", async ({
    makeOrganization,
    makeInternalAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    await AgentSuggestedPromptModel.syncForAgent({
      agentId: agent.id,
      prompts: [1, 2, 3, 4, 5].map((n) => ({
        summaryTitle: `Prompt ${n}`,
        prompt: `Do thing ${n}`,
      })),
    });
    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "slack",
      channelId: "D_PROMPTS",
      workspaceId: "T_TEST",
      agentId: agent.id,
    });

    const calls: Record<string, unknown>[] = [];
    server.use(
      http.post("https://slack.com/api/auth.test", () =>
        HttpResponse.json(
          { ok: true, user_id: "UBOT123", team_id: "T_TEST", team: "Test" },
          {
            headers: { "x-oauth-scopes": SLACK_REQUIRED_BOT_SCOPES.join(",") },
          },
        ),
      ),
      http.post("https://slack.com/api/users.info", () =>
        HttpResponse.json({ ok: true, user: { real_name: "Bot" } }),
      ),
      http.post(
        "https://slack.com/api/assistant.threads.setSuggestedPrompts",
        async ({ request }) => {
          const form = new URLSearchParams(await request.text());
          calls.push({
            channel_id: form.get("channel_id"),
            thread_ts: form.get("thread_ts"),
            prompts: JSON.parse(form.get("prompts") ?? "[]"),
          });
          return HttpResponse.json({ ok: true });
        },
      ),
    );
    const provider = new SlackProvider({
      enabled: true,
      connectionMode: "webhook",
      botToken: "xoxb-test",
      signingSecret: "test-secret",
      appId: "A_TEST",
    });
    await provider.initialize();
    const event = (inner: Record<string, unknown>) => ({
      type: "event_callback",
      team_id: "T_TEST",
      event: { user: "U_TEST", event_ts: "1.0", ...inner },
    });
    try {
      const homeOpened = event({
        type: "app_home_opened",
        channel: "D_PROMPTS",
        tab: "messages",
      });
      expect(
        await provider.parseWebhookNotification(homeOpened, {}),
      ).toBeNull();
      // Reopening with an unchanged list sends nothing new.
      await provider.parseWebhookNotification(homeOpened, {});
      // The Home tab is not the conversation.
      await provider.parseWebhookNotification(
        event({ type: "app_home_opened", channel: "D_PROMPTS", tab: "home" }),
        {},
      );
      // Legacy assistant threads get the prompts on the new thread.
      await provider.parseWebhookNotification(
        event({
          type: "assistant_thread_started",
          assistant_thread: { channel_id: "D_PROMPTS", thread_ts: "5.0" },
        }),
        {},
      );

      const expectedPrompts = [1, 2, 3, 4].map((n) => ({
        title: `Prompt ${n}`,
        message: `Do thing ${n}`,
      }));
      expect(calls).toEqual([
        { channel_id: "D_PROMPTS", thread_ts: null, prompts: expectedPrompts },
        { channel_id: "D_PROMPTS", thread_ts: "5.0", prompts: expectedPrompts },
      ]);
    } finally {
      await provider.cleanup();
    }
  });
});
