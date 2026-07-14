import { createFastifyInstance } from "@/server";
import { describe, expect, test } from "@/test";
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
