import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import ChatOpsConfigModel from "@/models/chatops-config";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import { createSlackSocketFixture } from "@/test/slack-socket-fixture";
import { SLACK_CONNECT_TIMEOUT_MS } from "./constants";
import SlackProvider from "./slack-provider";

setupTestCacheManager();
// biome-ignore lint/correctness/useHookAtTopLevel: test lifecycle helper
const boundary = useMswServer();
afterEach(() => vi.useRealTimers());

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
      boundary.use(...fixture.handlers);
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
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
        // Let the real TCP handshake reach the server before advancing the deadline.
        await delay(50);
        await vi.advanceTimersByTimeAsync(SLACK_CONNECT_TIMEOUT_MS);
        expect(await pending).toMatchObject({
          message: expect.stringContaining("slack.com"),
        });
        vi.useRealTimers();
        expect(provider.getBotUserId()).toBeNull();
        await delay(100);
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
        vi.useRealTimers();
        await provider.cleanup();
        await fixture.close();
      }
    });
  }

  test("initial rate limiting fails promptly without retaining a Retry-After timer", async () => {
    const fixture = await createSlackSocketFixture();
    boundary.use(...fixture.handlers);
    fixture.failNextConnection(429, 60);
    const provider = new SlackProvider(slackConfig);
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let settled = false;
      const pending = provider.initialize().then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      for (
        let attempt = 0;
        attempt < 100 && !fixture.calls.includes("apps.connections.open");
        attempt++
      )
        await delay(10);
      expect(fixture.calls).toContain("apps.connections.open");
      await delay(100);
      const failedPromptly = settled;
      await vi.advanceTimersByTimeAsync(SLACK_CONNECT_TIMEOUT_MS);
      expect(await pending).toMatchObject({
        message: expect.stringContaining("slack.com"),
      });
      expect(failedPromptly).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60000);
      expect(
        fixture.calls.filter((method) => method === "apps.connections.open"),
      ).toHaveLength(1);
      expect(fixture.connections).toBe(0);
    } finally {
      vi.useRealTimers();
      await provider.cleanup();
      await fixture.close();
    }
  });

  test("an established session reconnects through rate limiting and a transient HTTP failure", async () => {
    const fixture = await createSlackSocketFixture();
    boundary.use(...fixture.handlers);
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
