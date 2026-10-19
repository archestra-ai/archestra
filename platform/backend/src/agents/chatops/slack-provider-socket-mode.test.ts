import { SLACK_REQUIRED_BOT_SCOPES, TimeInMs } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, test, vi } from "vitest";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import { SLACK_CONNECT_TIMEOUT_MS } from "./constants";
import SlackProvider from "./slack-provider";

setupTestCacheManager();

// biome-ignore lint/correctness/useHookAtTopLevel: registers test lifecycle hooks, not a React hook
const server = useMswServer();

afterEach(() => {
  vi.useRealTimers();
});

describe("Socket Mode startup", () => {
  test("stops waiting for a Socket Mode connection that never opens", async () => {
    server.use(
      http.post("https://slack.com/api/auth.test", () =>
        HttpResponse.json(
          { ok: true, user_id: "UBOT123", user: "bot", team_id: "T_TEST" },
          {
            headers: { "x-oauth-scopes": SLACK_REQUIRED_BOT_SCOPES.join(",") },
          },
        ),
      ),
      http.post("https://slack.com/api/users.info", () =>
        HttpResponse.json({ ok: false, error: "missing_scope" }),
      ),
      http.post("https://slack.com/api/apps.connections.open", () =>
        HttpResponse.json({
          ok: true,
          url: "wss://wss-primary.slack.com/link/?ticket=test",
        }),
      ),
      // Traffic to the WebSocket host is dropped: the handshake never answers.
      http.get(
        "https://wss-primary.slack.com/link/",
        () => new Promise(() => {}),
      ),
    );
    const provider = new SlackProvider({
      enabled: true,
      connectionMode: "socket",
      botToken: "xoxb-test",
      signingSecret: "",
      appLevelToken: "xapp-test",
      appId: "A_TEST",
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const initialized = provider.initialize();
    let settled = false;
    void initialized.finally(() => {
      settled = true;
    });
    for (let waited = 0; !settled && waited < SLACK_CONNECT_TIMEOUT_MS * 2; ) {
      await vi.advanceTimersByTimeAsync(TimeInMs.Second);
      waited += TimeInMs.Second;
    }
    vi.useRealTimers();

    await expect(initialized).resolves.toBeUndefined();
    expect(provider.getBotUserId()).toBe("UBOT123");
    await provider.cleanup();
  });
});
