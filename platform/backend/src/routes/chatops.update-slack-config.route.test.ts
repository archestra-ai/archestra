import { setTimeout as delay } from "node:timers/promises";
import { TimeInMs } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import { SLACK_CONNECT_TIMEOUT_MS } from "@/agents/chatops/constants";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { ChatOpsConfigModel } from "@/models";
import { describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import { createSlackSocketFixture } from "@/test/slack-socket-fixture";
import chatopsRoutes from "./chatops";

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

describe("PUT /api/chatops/config/slack when Slack is unreachable", () => {
  const server = useMswServer();

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

  test("a rate-limited credential check fails promptly and asks for retry", async ({
    makeOrganization,
    makeUser,
  }) => {
    server.use(
      http.post(
        "https://slack.com/api/auth.test",
        () =>
          new HttpResponse(null, {
            status: 429,
            headers: { "Retry-After": "60" },
          }),
      ),
    );
    const app = await makeApp({ makeOrganization, makeUser });
    try {
      const started = performance.now();
      const response = await app.inject({
        method: "PUT",
        url: "/api/chatops/config/slack",
        payload: slackConfig,
      });
      expect(response.statusCode).toBe(502);
      expect(response.json().error.message).toContain("retry");
      expect(performance.now() - started).toBeLessThan(1000);
      expect(await ChatOpsConfigModel.getSlackConfig()).toBeNull();
    } finally {
      await app.close();
    }
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
    const pending = app.inject({
      method: "PUT",
      url: "/api/chatops/config/slack",
      payload: slackConfig,
    });
    const response = await pending;

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toContain(
      `Could not reach slack.com within ${SLACK_CONNECT_TIMEOUT_MS / TimeInMs.Second}s`,
    );
    await app.close();
  });
  for (const method of ["auth.test", "apps.connections.open"]) {
    test(`the ${method} credential check aborts a continuously dribbling response`, async ({
      makeOrganization,
      makeUser,
    }) => {
      server.close();
      const fixture = await createSlackSocketFixture();
      fixture.dribble(method);
      const app = await makeApp({ makeOrganization, makeUser });
      let finished = false;
      const started = performance.now();
      const pending = app
        .inject({
          method: "PUT",
          url: "/api/chatops/config/slack",
          payload: slackConfig,
        })
        .then((response) => {
          finished = true;
          return response;
        });
      try {
        await delay(SLACK_CONNECT_TIMEOUT_MS + 1000);
        const finishedBeforeRelease = finished;
        fixture.release();
        const response = await pending;
        expect(finishedBeforeRelease).toBe(true);
        expect(response.statusCode).toBe(502);
        expect(response.json().error.message).toContain("slack.com");
        expect(performance.now() - started).toBeLessThan(
          SLACK_CONNECT_TIMEOUT_MS + 2000,
        );
        expect(fixture.dribbleWrites).toBeGreaterThan(50);
        expect(fixture.abortedDribbles).toBe(1);
        expect(await ChatOpsConfigModel.getSlackConfig()).toBeNull();
      } finally {
        fixture.release();
        await pending;
        await app.close();
        await fixture.close();
      }
    }, 15000);
  }

  for (const target of ["main", "agent"] as const) {
    test(`${target} Save reports failed socket startup and an explicit retry connects`, async ({
      makeOrganization,
      makeUser,
      makeInternalAgent,
    }) => {
      server.close();
      const fixture = await createSlackSocketFixture();
      if (target === "main") fixture.dropHelloAndClose();
      else fixture.stallHandshake();
      const org = await makeOrganization();
      const user = await makeUser();
      const agent =
        target === "agent"
          ? await makeInternalAgent({ organizationId: org.id })
          : undefined;
      const app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        request.organizationId = org.id;
        request.user = user as typeof request.user;
      });
      registerAuditLogHook(app);
      await app.register(chatopsRoutes);
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const url = `${origin}/api/chatops/config/slack${agent ? `/agents/${agent.id}` : ""}`;
      const save = () =>
        fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(slackConfig),
        });
      try {
        const started = performance.now();
        const failed = await save();
        expect(failed.status).toBe(502);
        expect(await failed.json()).toMatchObject({
          error: { message: expect.stringContaining("wss-primary.slack.com") },
        });
        expect(performance.now() - started).toBeLessThan(
          SLACK_CONNECT_TIMEOUT_MS + 3000,
        );
        expect(
          chatOpsManager.getSlackProvider(agent?.id)?.getBotUserId(),
        ).toBeNull();
        const stored = agent
          ? (await ChatOpsConfigModel.getSlackAgentBots())[0]
          : await ChatOpsConfigModel.getSlackConfig();
        expect(stored).toMatchObject({
          enabled: true,
          botToken: slackConfig.botToken,
        });
        const [audit] = await db
          .select()
          .from(schema.auditLogsTable)
          .where(eq(schema.auditLogsTable.resourceId, org.id));
        expect(audit).toBeDefined();
        expect(audit.before).not.toEqual(audit.after);
        expect(JSON.stringify(audit)).not.toContain(slackConfig.botToken);
        fixture.release();
        await delay(100);
        expect(fixture.connections).toBe(target === "main" ? 1 : 0);
        const calls = fixture.calls.length;
        await delay(100);
        expect(fixture.calls.length).toBe(calls);
        const retried = await save();
        expect(retried.status).toBe(200);
        expect(await retried.json()).toEqual({ success: true });
        expect(chatOpsManager.getSlackProvider(agent?.id)?.getBotUserId()).toBe(
          "UBOT_TEST",
        );
        expect(fixture.connections).toBe(target === "main" ? 2 : 1);
      } finally {
        await chatOpsManager.cleanup();
        await app.close();
        await fixture.close();
      }
    });
  }
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
