import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { useMswServer } from "@/test/msw";
import type { IncomingChatMessage } from "@/types";
import SlackProvider from "./slack-provider";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer(
  http.post("https://slack.com/api/auth.test", () =>
    HttpResponse.json({ ok: true, team_id: "T_TEST" }),
  ),
);

test.each([
  false,
  true,
])("Slack startup acknowledgments use the bot's thread and do not retry rate limits (rate limited: %s)", async (rateLimited) => {
  const posts: URLSearchParams[] = [];
  server.use(
    http.post("https://slack.com/api/chat.postMessage", async ({ request }) => {
      posts.push(new URLSearchParams(await request.text()));
      return rateLimited
        ? new HttpResponse(null, {
            status: 429,
            headers: { "retry-after": "60" },
          })
        : HttpResponse.json({ ok: true, ts: "1700000000.000300" });
    }),
  );
  const provider = new SlackProvider({
    enabled: true,
    botToken: "xoxb-test",
    signingSecret: "test-secret",
    appId: "A_TEST",
  });
  await provider.initialize();
  try {
    const delivery = provider.sendReply({
      originalMessage: message,
      text: "I'm on it.",
      conversationUrl: "https://platform.example.test/chat/runs/session-id",
      bestEffort: true,
    });
    if (rateLimited) {
      await expect(delivery).rejects.toMatchObject({
        code: "slack_webapi_rate_limited_error",
      });
    } else {
      await expect(delivery).resolves.toBe("1700000000.000300");
    }
    expect(posts).toHaveLength(1);
    expect(posts[0].get("channel")).toBe(message.channelId);
    expect(posts[0].get("thread_ts")).toBe(message.threadId);
    expect(posts[0].get("blocks")).toContain(
      "https://platform.example.test/chat/runs/session-id",
    );
  } finally {
    await provider.cleanup();
  }
});

const message: IncomingChatMessage = {
  messageId: "1700000000.000200",
  channelId: "C_TEST",
  workspaceId: "T_TEST",
  threadId: "1700000000.000100",
  senderId: "U_TEST",
  senderName: "Test User",
  text: "Investigate this issue",
  rawText: "Investigate this issue",
  timestamp: new Date("2026-01-01"),
  isThreadReply: true,
};
