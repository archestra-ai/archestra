import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import MSTeamsProvider from "@/agents/chatops/ms-teams-provider";
import { cacheManager } from "@/cache-manager";
import { createFastifyInstance } from "@/fastify-instance";
import chatopsRoutes, { msTeamsWebhookRoutes } from "./chatops";

/**
 * The MS Teams incoming webhook is exported as its own plugin so the optional
 * public-endpoints listener (ARCHESTRA_PUBLIC_ENDPOINTS_PORT) can serve it
 * without the rest of the chatops routes. These tests pin both sides of that
 * contract: the standalone plugin serves the webhook (and no other chatops
 * endpoint), and the main chatops plugin still serves it on the main API port.
 *
 * No chatops provider is configured in tests, so a request that reaches the
 * handler is answered with the handler's own 400 "provider not configured" —
 * distinguishing "route exists and executed" (400) from "route missing" (404).
 */
describe("MS Teams webhook route registration", () => {
  test("standalone plugin serves the webhook without the rest of the chatops routes", async () => {
    const app = createFastifyInstance();
    await app.register(msTeamsWebhookRoutes);

    const webhookResponse = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/ms-teams",
      payload: { type: "message", text: "hello" },
    });
    expect(webhookResponse.statusCode).toBe(400);
    expect(webhookResponse.json().error.message).toBe(
      "MS Teams chatops provider not configured",
    );

    // The dedicated listener must not expose any other chatops endpoint
    const statusResponse = await app.inject({
      method: "GET",
      url: "/api/chatops/status",
    });
    expect(statusResponse.statusCode).toBe(404);

    const slackWebhookResponse = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/slack",
      payload: {},
    });
    expect(slackWebhookResponse.statusCode).toBe(404);
  });

  test("webhook stays reachable through the main chatops plugin", async () => {
    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const webhookResponse = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/ms-teams",
      payload: { type: "message", text: "hello" },
    });
    expect(webhookResponse.statusCode).toBe(400);
    expect(webhookResponse.json().error.message).toBe(
      "MS Teams chatops provider not configured",
    );
  });
});

describe("MS Teams webhook Bot Framework rejections", () => {
  beforeEach(() => {
    // The webhook's rate limiter reads and writes through the cache manager.
    cacheManager.start();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The Bot Framework SDK answers with `res.status(code)` and `res.send(body)`
   * as two separate calls. The route must keep that status, so a rejected
   * activity is not reported as a 200 and the SDK's reason reaches the caller.
   */
  test("relays the SDK's status and message when it rejects the activity", async () => {
    const provider = new MSTeamsProvider({
      enabled: true,
      appId: "app-id-123",
      appSecret: "test-secret",
      tenantId: "tenant-1",
      graphTenantId: "",
      graphClientId: "",
      graphClientSecret: "",
    });
    await provider.initialize();
    vi.spyOn(chatOpsManager, "getMSTeamsProvider").mockReturnValue(provider);

    const app = createFastifyInstance();
    await app.register(msTeamsWebhookRoutes);

    // No Authorization header: the SDK rejects the activity before any
    // network call to the Bot Framework token endpoints.
    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/ms-teams",
      payload: {
        type: "message",
        text: "ping",
        from: { id: "test" },
        conversation: { id: "test" },
        recipient: { id: "app-id-123" },
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.type).toBe("api_authentication_error");
    expect(response.json().error.message).toMatch(/unauthorized/i);
  });
});
