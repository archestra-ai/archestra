import { SLACK_REQUIRED_BOT_SCOPES } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, test, vi } from "vitest";
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

describe("channel discovery", () => {
  let provider: SlackProvider;

  async function initializeProvider() {
    server.use(
      http.post("https://slack.com/api/auth.test", () =>
        HttpResponse.json({
          ok: true,
          user_id: "UBOT",
          team_id: "T_LOCAL",
          team: "Local",
        }),
      ),
      http.post("https://slack.com/api/users.info", () =>
        HttpResponse.json({
          ok: true,
          user: { name: "bot", profile: { display_name: "Bot" } },
        }),
      ),
    );
    provider = new SlackProvider({
      enabled: true,
      connectionMode: "webhook",
      botToken: "xoxb-synthetic",
      signingSecret: "synthetic",
      appId: "A_SYNTHETIC",
    });
    await provider.initialize();
    return provider;
  }

  afterEach(async () => {
    await provider?.cleanup();
  });

  test("paginates memberships without is_member and keeps shared channels in the authenticated workspace", async () => {
    const cursors: Array<string | null> = [];
    server.use(
      http.post(
        "https://slack.com/api/users.conversations",
        async ({ request }) => {
          const form = new URLSearchParams(await request.text());
          expect(form.get("user")).toBeNull();
          expect(form.get("limit")).toBe("200");
          expect(form.get("types")).toBe("public_channel,private_channel");
          expect(form.get("exclude_archived")).toBe("true");
          cursors.push(form.get("cursor"));
          return HttpResponse.json(
            form.get("cursor")
              ? {
                  ok: true,
                  channels: [{ id: "C_PRIVATE", name: "private" }],
                }
              : {
                  ok: true,
                  channels: [
                    {
                      id: "C_SHARED",
                      name: "shared",
                      shared_team_ids: ["T_REMOTE", "T_LOCAL"],
                    },
                  ],
                  response_metadata: { next_cursor: "page2" },
                },
          );
        },
      ),
    );
    await initializeProvider();
    expect(await provider.discoverChannels(undefined)).toEqual([
      {
        channelId: "C_SHARED",
        channelName: "shared",
        workspaceId: "T_LOCAL",
        workspaceName: "Local",
      },
      {
        channelId: "C_PRIVATE",
        channelName: "private",
        workspaceId: "T_LOCAL",
        workspaceName: "Local",
      },
    ]);
    expect(cursors).toEqual([null, "page2"]);
  });

  test("a failed later page rejects instead of publishing a partial membership snapshot", async () => {
    server.use(
      http.post(
        "https://slack.com/api/users.conversations",
        async ({ request }) => {
          const form = new URLSearchParams(await request.text());
          return HttpResponse.json(
            form.get("cursor")
              ? { ok: false, error: "missing_scope" }
              : {
                  ok: true,
                  channels: [{ id: "C_FIRST" }],
                  response_metadata: { next_cursor: "page2" },
                },
          );
        },
      ),
    );
    await initializeProvider();
    await expect(provider.discoverChannels(undefined)).rejects.toThrow(
      "missing_scope",
    );
  });

  test("rate-limited discovery exposes Retry-After without blocking interactive channel listing", async () => {
    server.use(
      http.post(
        "https://slack.com/api/users.conversations",
        () =>
          new HttpResponse(null, {
            status: 429,
            headers: { "retry-after": "30" },
          }),
      ),
      http.post("https://slack.com/api/conversations.list", () =>
        HttpResponse.json({
          ok: true,
          channels: [{ id: "C_JOINABLE", name: "joinable", is_member: false }],
        }),
      ),
    );
    await initializeProvider();
    await expect(provider.discoverChannels(undefined)).rejects.toMatchObject({
      retryAfter: 30,
    });
    expect(await provider.listJoinableChannels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channelId: "C_JOINABLE" }),
      ]),
    );
  });

  test("does not publish a snapshot completed after shutdown", async () => {
    server.use(
      http.post("https://slack.com/api/users.conversations", async () => {
        await provider.beginShutdown();
        return HttpResponse.json({ ok: true, channels: [{ id: "C_STALE" }] });
      }),
    );
    await initializeProvider();
    await expect(provider.discoverChannels(undefined)).rejects.toThrow(
      "interrupted",
    );
  });

  test("stops pagination at the total scan deadline", async () => {
    let pages = 0;
    const now = Date.now();
    server.use(
      http.post("https://slack.com/api/users.conversations", () => {
        pages++;
        vi.spyOn(Date, "now").mockReturnValue(now + 121_000);
        return HttpResponse.json({
          ok: true,
          channels: [{ id: "C_FIRST" }],
          response_metadata: { next_cursor: "page2" },
        });
      }),
    );
    await initializeProvider();
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await expect(provider.discoverChannels(undefined)).rejects.toThrow(
        "interrupted",
      );
      expect(pages).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("successful empty membership is distinct from shutdown", async () => {
    server.use(
      http.post("https://slack.com/api/users.conversations", () =>
        HttpResponse.json({ ok: true, channels: [] }),
      ),
    );
    await initializeProvider();
    expect(await provider.discoverChannels(undefined)).toEqual([]);
    await provider.cleanup();
    await expect(provider.discoverChannels(undefined)).rejects.toThrow(
      "not initialized",
    );
  });
});
