import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";
import ChatOpsConfigModel from "@/models/chatops-config";
import { setupTestCacheManager } from "@/test/cache-manager";
import { createSlackSocketFixture } from "@/test/slack-socket-fixture";
import SlackProvider from "./slack-provider";

setupTestCacheManager();

// Keep the real SDK and Node sockets; only select the local endpoint and plain
// transport. The provider still owns and destroys its initial Agent sockets.
vi.mock("node:https", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:https")>()),
  Agent: (await import("node:http")).Agent,
}));
vi.mock("@slack/web-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slack/web-api")>();
  const { slackSocketBoundary } = await import("@/test/slack-socket-fixture");
  return {
    ...actual,
    WebClient: class extends actual.WebClient {
      constructor(
        ...[token, options]: ConstructorParameters<typeof actual.WebClient>
      ) {
        super(token, {
          ...options,
          slackApiUrl: slackSocketBoundary.apiUrl ?? options?.slackApiUrl,
        });
      }
    },
  };
});
vi.mock("@slack/socket-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slack/socket-mode")>();
  const { slackSocketBoundary } = await import("@/test/slack-socket-fixture");
  return {
    ...actual,
    SocketModeClient: class extends actual.SocketModeClient {
      constructor(
        options: NonNullable<
          ConstructorParameters<typeof actual.SocketModeClient>[0]
        >,
      ) {
        super({
          ...options,
          clientOptions: {
            ...options.clientOptions,
            slackApiUrl:
              slackSocketBoundary.apiUrl ?? options.clientOptions?.slackApiUrl,
          },
        });
      }
    },
  };
});

const slackConfig = {
  enabled: true,
  connectionMode: "socket" as const,
  botToken: "xoxb-synthetic",
  signingSecret: "",
  appLevelToken: "xapp-synthetic",
  appId: "A_TEST",
};

describe("Slack startup cancellation", () => {
  for (const stage of [
    "apps.connections.open",
    "users.info",
    "handshake",
    "hello-and-close",
    "apps.manifest.export",
    "tooling.tokens.rotate",
  ]) {
    test(`cancels stalled ${stage}, ignores its late response, and permits a fresh retry`, async () => {
      const fixture = await createSlackSocketFixture();
      if (stage === "hello-and-close") fixture.dropHelloAndClose();
      else if (stage === "handshake") fixture.stallHandshake();
      else fixture.stall(stage);
      const managed =
        stage === "apps.manifest.export" || stage === "tooling.tokens.rotate";
      if (managed)
        await ChatOpsConfigModel.saveSlackAppConfigToken({
          accessToken: "xoxe-synthetic",
          refreshToken: "xoxe-refresh-synthetic",
          expiresAt:
            stage === "tooling.tokens.rotate" ? 0 : Date.now() + 86400000,
        });
      const provider = new SlackProvider({
        ...slackConfig,
        appId: `A_${stage}`,
        managed,
      });
      try {
        const pending = provider.initialize().then(
          () => undefined,
          (error: unknown) => error,
        );
        const expectedMethod = ["handshake", "hello-and-close"].includes(stage)
          ? "apps.connections.open"
          : stage;
        for (
          let attempt = 0;
          attempt < 100 && !fixture.calls.includes(expectedMethod);
          attempt++
        )
          await delay(10);
        expect(fixture.calls).toContain(expectedMethod);
        // Allow the real TCP handshake to reach the server.
        await delay(50);
        expect(await pending).toMatchObject({
          message: expect.stringContaining("slack.com"),
        });
        expect(provider.getBotUserId()).toBeNull();
        await delay(100);
        if (!["handshake", "hello-and-close"].includes(stage))
          expect(fixture.abortedRequests).toBe(1);
        fixture.release();
        await delay(100);
        expect(fixture.connections).toBe(stage === "hello-and-close" ? 1 : 0);
        const before = fixture.calls.length;
        await delay(100);
        expect(fixture.calls.length).toBe(before);
        // Retry through a fresh provider after releasing the stalled dependency.
        const retry = new SlackProvider(slackConfig);
        try {
          await retry.initialize();
          expect(retry.getBotUserId()).toBe("UBOT_TEST");
          expect(fixture.connections).toBe(stage === "hello-and-close" ? 2 : 1);
        } finally {
          await retry.cleanup();
        }
      } finally {
        await provider.cleanup();
        await fixture.close();
      }
    });
  }

  test("initial rate limiting fails promptly without retaining a Retry-After timer", async () => {
    const fixture = await createSlackSocketFixture();
    fixture.failNextConnection(429, 60);
    const provider = new SlackProvider(slackConfig);
    try {
      const started = performance.now();
      await expect(provider.initialize()).rejects.toThrow("slack.com");
      expect(performance.now() - started).toBeLessThan(1000);
      await delay(100);
      expect(process.getActiveResourcesInfo()).not.toContain("Timeout");
      expect(
        fixture.calls.filter((method) => method === "apps.connections.open"),
      ).toHaveLength(1);
      expect(fixture.connections).toBe(0);
    } finally {
      await provider.cleanup();
      await fixture.close();
    }
  });

  test("an established session reconnects through rate limiting and a transient HTTP failure", async () => {
    const fixture = await createSlackSocketFixture();
    const provider = new SlackProvider(slackConfig);
    try {
      await provider.initialize();
      expect(fixture.connections).toBe(1);
      fixture.failNextConnection(429);
      fixture.failNextConnection(503);
      fixture.disconnect();
      await expect.poll(() => fixture.connections, { timeout: 12000 }).toBe(2);
      expect(
        fixture.calls.filter((method) => method === "apps.connections.open"),
      ).toHaveLength(4);
      expect(provider.getBotUserId()).toBe("UBOT_TEST");
    } finally {
      await provider.cleanup();
      await fixture.close();
    }
  }, 15000);
});
