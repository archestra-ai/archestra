import { TimeInMs } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { SLACK_CONNECT_TIMEOUT_MS } from "@/agents/chatops/constants";
import { createFastifyInstance } from "@/fastify-instance";
import { ChatOpsConfigModel } from "@/models";
import { afterEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import chatopsRoutes from "./chatops";

describe("PUT /api/chatops/config/slack when Slack is unreachable", () => {
  const server = useMswServer();

  afterEach(() => {
    vi.useRealTimers();
  });

  test("names slack.com when the connection fails", async ({
    makeOrganization,
    makeUser,
  }) => {
    server.use(
      http.post("https://slack.com/api/auth.test", () => HttpResponse.error()),
    );
    const app = await makeApp({ makeOrganization, makeUser });

    const response = await app.inject({
      method: "PUT",
      url: "/api/chatops/config/slack",
      payload: slackConfig,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain(
      "Could not reach slack.com",
    );
    expect(response.json().error.message).toContain("wss-primary.slack.com");
    expect(await ChatOpsConfigModel.getSlackConfig()).toBeNull();
    await app.close();
  });

  test("gives up on a Slack API call that never answers", async ({
    makeOrganization,
    makeUser,
  }) => {
    // Egress dropped without a reset: the request never gets an answer.
    server.use(
      http.post("https://slack.com/api/auth.test", () => new Promise(() => {})),
    );
    const app = await makeApp({ makeOrganization, makeUser });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const pending = app.inject({
      method: "PUT",
      url: "/api/chatops/config/slack",
      payload: slackConfig,
    });
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    for (let waited = 0; !settled && waited < SLACK_CONNECT_TIMEOUT_MS * 2; ) {
      await vi.advanceTimersByTimeAsync(TimeInMs.Second);
      waited += TimeInMs.Second;
    }
    vi.useRealTimers();
    const response = await pending;

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain(
      `Could not reach slack.com within ${SLACK_CONNECT_TIMEOUT_MS / TimeInMs.Second}s`,
    );
    await app.close();
  });
});

const slackConfig = {
  enabled: true,
  botToken: "xoxb-test-token",
  appLevelToken: "xapp-test-token",
  connectionMode: "socket",
  appId: "A12345",
};

async function makeApp({
  makeOrganization,
  makeUser,
}: {
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
}) {
  const org = await makeOrganization();
  const user = await makeUser();
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    request.organizationId = org.id;
    request.user = user as typeof request.user;
  });
  await app.register(chatopsRoutes);
  return app;
}
