import { SLACK_REQUIRED_BOT_SCOPES } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { ChatOpsChannelBindingModel } from "@/models";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { ChatOpsManager } from "./chatops-manager";
import SlackProvider from "./slack-provider";
import { EventDedupMap } from "./utils";

vi.mock("@/cache-manager");

// biome-ignore lint/correctness/useHookAtTopLevel: registers test lifecycle hooks, not a React hook
const server = useMswServer();

describe("mention reply delivery", () => {
  test.for([
    "message",
    "app_mention",
  ])("replies once after a mute when %s arrives first", async (firstType, {
    makeUser,
    makeOrganization,
    makeInternalAgent,
  }) => {
    const user = await makeUser({ email: "mention-user@example.com" });
    const org = await makeOrganization();
    const agent = await makeInternalAgent({ organizationId: org.id });
    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "slack",
      channelId: "C_TEST",
      workspaceId: "T_TEST",
      agentId: agent.id,
    });

    const posts: URLSearchParams[] = [];
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
        HttpResponse.json({
          ok: true,
          user: { real_name: "Test User", profile: { email: user.email } },
        }),
      ),
      http.post("https://slack.com/api/conversations.list", () =>
        HttpResponse.json({ ok: true, channels: [] }),
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
      await manager.handleIncomingMessage(
        provider,
        payload({
          type: "message",
          text: "mute",
          ts: "100.000003",
        }),
      );
      expect(posts).toHaveLength(2);
      await manager.handleIncomingMessage(
        provider,
        payload({
          type: "message",
          text: "hello",
          ts: "100.000004",
        }),
      );
      expect(posts).toHaveLength(2);

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
      expect(posts).toHaveLength(3);
      expect(posts[2].get("text")).toBe("How can I help you?");
      expect(posts[2].get("channel")).toBe("C_TEST");
      expect(posts[2].get("thread_ts")).toBe("100.000001");

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
      expect(posts).toHaveLength(3);
    } finally {
      await provider.cleanup();
      await manager.cleanup();
    }
  });
});
