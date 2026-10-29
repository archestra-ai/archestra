import { generateKeyPairSync, sign } from "node:crypto";
import { Activity, ActivityTypes } from "@microsoft/agents-activity";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, vi } from "vitest";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import { createFastifyInstance } from "@/fastify-instance";
import { msTeamsWebhookRoutes } from "@/routes/chatops";
import { test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import MSTeamsProvider from "./ms-teams-provider";

// Sign actual channel JWTs; only Microsoft HTTP endpoints are substituted.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const key = {
  ...publicKey.export({ format: "jwk" }),
  kid: "teams-transport-test",
  use: "sig",
  alg: "RS256",
};
const tenantId = "11111111-1111-4111-8111-111111111111";
const appId = "22222222-2222-4222-8222-222222222222";
const serviceUrl = "https://smba.trafficmanager.net/amer/";

function token(claims: Record<string, unknown> = {}, signingKey = privateKey) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: key.kid }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.botframework.com",
      aud: appId,
      serviceurl: serviceUrl,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...claims,
    }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), signingKey).toString("base64url")}`;
}

function activity(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    id: "incoming",
    text: "hello",
    channelId: "msteams",
    serviceUrl,
    from: { id: "sender" },
    recipient: { id: appId },
    conversation: { id: "chat", conversationType: "personal" },
    ...overrides,
  };
}

async function provider(tenant = tenantId) {
  const result = new MSTeamsProvider({
    enabled: true,
    appId,
    appSecret: "test-secret",
    tenantId: tenant,
    graphTenantId: "",
    graphClientId: "",
    graphClientSecret: "",
  });
  await result.initialize();
  return result;
}

function response() {
  const send = vi.fn();
  const status = vi.fn(() => ({ send }));
  return { send, status };
}

describe("Teams Agents SDK transport", () => {
  setupTestCacheManager();
  const outbound: Record<string, unknown>[] = [];
  const server = useMswServer(
    http.get("https://login.botframework.com/v1/.well-known/keys", () =>
      HttpResponse.json({ keys: [key] }),
    ),
    http.get(
      "https://login.microsoftonline.com/:tenant/discovery/v2.0/keys",
      () => HttpResponse.json({ keys: [key] }),
    ),
    http.get(
      "https://login.microsoftonline.com/:tenant/v2.0/.well-known/openid-configuration",
      ({ params }) =>
        HttpResponse.json({
          authorization_endpoint: `https://login.microsoftonline.com/${params.tenant}/oauth2/v2.0/authorize`,
          token_endpoint: `https://login.microsoftonline.com/${params.tenant}/oauth2/v2.0/token`,
          issuer: `https://login.microsoftonline.com/${params.tenant}/v2.0`,
          jwks_uri: `https://login.microsoftonline.com/${params.tenant}/discovery/v2.0/keys`,
        }),
    ),
    http.post(
      "https://login.microsoftonline.com/:tenant/oauth2/v2.0/token",
      () =>
        HttpResponse.json({
          token_type: "Bearer",
          access_token: "connector-token",
          expires_in: 3600,
        }),
    ),
    http.post(
      "https://smba.trafficmanager.net/amer/v3/conversations/:chat/activities/:replyId",
      async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer connector-token",
        );
        outbound.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ id: "reply" });
      },
    ),
  );
  afterEach(() => {
    outbound.length = 0;
  });

  test.each([
    ["missing", undefined],
    ["malformed", "Basic invalid"],
    ["invalid JWT", "Bearer invalid"],
    ["wrong audience", `Bearer ${token({ aud: "another-app" })}`],
    ["expired", `Bearer ${token({ exp: 1 })}`],
    [
      "untrusted issuer",
      `Bearer ${token({ iss: "https://untrusted.example.com" })}`,
    ],
    [
      "forged signature",
      `Bearer ${token({}, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey)}`,
    ],
  ])("rejects %s credentials before acknowledging or executing", async (_name, authorization) => {
    const bot = await provider();
    const res = response();
    const handler = vi.fn();
    await bot.processActivity(
      { body: activity(), headers: { authorization } },
      res,
      handler,
    );
    expect(res.status).toHaveBeenCalledExactlyOnceWith(401);
    expect(handler).not.toHaveBeenCalled();
    expect(outbound).toHaveLength(0);
  });

  test("rejects a service URL that differs from the signed claim", async () => {
    const bot = await provider();
    const res = response();
    const handler = vi.fn();
    await bot.processActivity(
      {
        body: activity(),
        headers: {
          authorization: `Bearer ${token({ serviceurl: "https://different.example.com" })}`,
        },
      },
      res,
      handler,
    );
    expect(res.status).toHaveBeenCalledExactlyOnceWith(400);
    expect(handler).not.toHaveBeenCalled();
  });

  test.each([
    tenantId,
    "",
  ])("acknowledges slow processing and delivers a later card with tenant %j", async (tenant) => {
    const bot = await provider(tenant);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const res = response();
    res.send.mockImplementation(acknowledge);
    let completed = false;
    const work = bot.processActivity(
      { body: activity(), headers: { authorization: `Bearer ${token()}` } },
      res,
      async (context) => {
        await blocked;
        await context.sendActivity(
          Activity.fromObject({
            type: ActivityTypes.Message,
            text: "Finished",
            attachments: [
              {
                contentType: "application/vnd.microsoft.card.adaptive",
                content: { type: "AdaptiveCard", version: "1.4", body: [] },
              },
            ],
          }),
        );
        completed = true;
      },
    );
    try {
      await acknowledged;
      expect(res.status).toHaveBeenCalledExactlyOnceWith(200);
      expect(completed).toBe(false);
      expect(outbound).toHaveLength(0);
    } finally {
      release();
    }
    await work;
    expect(completed).toBe(true);
    expect(outbound).toMatchObject([
      {
        type: "message",
        text: "Finished",
        conversation: { id: "chat" },
        attachments: [
          { contentType: "application/vnd.microsoft.card.adaptive" },
        ],
      },
    ]);
    expect(res.send).toHaveBeenCalledTimes(1);
  });

  test.each([
    false,
    true,
  ])("delivers provider replies with placeholder=%s after acknowledgement", async (placeholder) => {
    const bot = await provider();
    const res = response();
    server.use(
      http.put(
        "https://smba.trafficmanager.net/amer/v3/conversations/chat/activities/placeholder",
        async ({ request }) => {
          outbound.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json({ id: "placeholder" });
        },
      ),
      http.post(
        "https://smba.trafficmanager.net/amer/v3/conversations/chat/activities",
        async ({ request }) => {
          outbound.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json({ id: "proactive-reply" });
        },
      ),
    );
    await bot.processActivity(
      { body: activity(), headers: { authorization: `Bearer ${token()}` } },
      res,
      async (context) => {
        expect(res.send).toHaveBeenCalledTimes(1);
        const message = await bot.parseWebhookNotification(activity(), {});
        if (!message) throw new Error("Expected a parsed message");
        message.metadata = {
          ...message.metadata,
          turnContext: context,
          ...(placeholder && { placeholderActivityId: "placeholder" }),
        };
        await bot.setTypingStatus("chat", "", message.metadata);
        expect(
          await bot.sendReply({
            originalMessage: message,
            text: "Finished",
            footer: "Test agent",
          }),
        ).toBe(placeholder ? "placeholder" : "proactive-reply");
      },
    );
    expect(outbound).toMatchObject([
      { type: "typing" },
      {
        type: "message",
        text: "Finished\n\n---\n\nTest agent",
        conversation: { id: "chat" },
      },
    ]);
  });

  test("the real webhook returns before a slow attachment completes and can still send its help card", async ({
    makeOrganization,
    makeUser,
  }) => {
    await makeOrganization();
    await makeUser({ email: "sender@example.com" });
    const bot = await provider();
    vi.spyOn(chatOpsManager, "getMSTeamsProvider").mockReturnValue(bot);
    const processing = vi.spyOn(bot, "processActivity");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const downloading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let replied!: () => void;
    const replySent = new Promise<void>((resolve) => {
      replied = resolve;
    });
    server.use(
      http.get("https://teams.blob.core.windows.net/test.txt", async () => {
        started();
        await blocked;
        return HttpResponse.text("test attachment");
      }),
      http.get(
        "https://smba.trafficmanager.net/amer/v3/conversations/chat/members/sender",
        () => HttpResponse.json({ id: "sender", email: "sender@example.com" }),
      ),
      http.post(
        "https://smba.trafficmanager.net/amer/v3/conversations/chat/activities/incoming",
        async ({ request }) => {
          outbound.push((await request.json()) as Record<string, unknown>);
          replied();
          return HttpResponse.json({ id: "help-reply" });
        },
      ),
    );
    const app = createFastifyInstance();
    await app.register(msTeamsWebhookRoutes);
    try {
      const request = app.inject({
        method: "POST",
        url: "/api/webhooks/chatops/ms-teams",
        headers: { authorization: `Bearer ${token()}` },
        payload: activity({
          text: "/help",
          attachments: [
            {
              contentType: "text/plain",
              name: "test.txt",
              contentUrl: "https://teams.blob.core.windows.net/test.txt",
            },
          ],
        }),
      });
      const result = await request;
      expect(result.statusCode).toBe(200);
      await downloading;
      expect(outbound).toHaveLength(0);
      release();
      await replySent;
      await processing.mock.results[0].value;
      expect(outbound).toMatchObject([
        { attachments: [{ content: { type: "AdaptiveCard" } }] },
      ]);
    } finally {
      release();
      await app.close();
      vi.restoreAllMocks();
    }
  });

  test("keeps invoke response bodies synchronous", async () => {
    const bot = await provider();
    const res = response();
    await bot.processActivity(
      {
        body: activity({ type: "invoke", name: "adaptiveCard/action" }),
        headers: { authorization: `Bearer ${token()}` },
      },
      res,
      async (context) => {
        expect(res.send).not.toHaveBeenCalled();
        await context.sendActivity(
          Activity.fromObject({
            type: ActivityTypes.InvokeResponse,
            value: {
              status: 200,
              body: {
                statusCode: 200,
                type: "application/vnd.microsoft.activity.message",
                value: "done",
              },
            },
          }),
        );
      },
    );
    expect(res.status).toHaveBeenCalledExactlyOnceWith(200);
    expect(res.send).toHaveBeenCalledExactlyOnceWith({
      statusCode: 200,
      type: "application/vnd.microsoft.activity.message",
      value: "done",
    });
  });
});
