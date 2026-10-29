import { SLACK_REQUIRED_BOT_SCOPES } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import SlackProvider from "./slack-provider";

setupTestCacheManager();

// biome-ignore lint/correctness/useHookAtTopLevel: registers test lifecycle hooks, not a React hook
const server = useMswServer();

describe("bot handle", () => {
  test("falls back to auth.test's username when users.info is refused", async () => {
    server.use(
      http.post("https://slack.com/api/auth.test", () =>
        HttpResponse.json(
          {
            ok: true,
            user_id: "UBOT123",
            user: "support_bot",
            team_id: "T_TEST",
            team: "Test",
          },
          {
            headers: { "x-oauth-scopes": SLACK_REQUIRED_BOT_SCOPES.join(",") },
          },
        ),
      ),
      // A hand-made app without users:read.
      http.post("https://slack.com/api/users.info", () =>
        HttpResponse.json({ ok: false, error: "missing_scope" }),
      ),
      http.post("https://slack.com/api/conversations.list", () =>
        HttpResponse.json({ ok: true, channels: [] }),
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

    expect(provider.getBotHandle()).toBe("support_bot");
  });
});
