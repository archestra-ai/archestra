import { createHmac, randomUUID } from "node:crypto";
import db, { schema } from "@/database";
import ChatOpsConfigModel from "@/models/chatops-config";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import type { JiraDbConfig } from "@/types/chatops-jira";
import routes from "./chatops-jira-webhook";

describe("Jira authenticated durable ingress", () => {
  let beforeWebhookHandler: (() => Promise<void>) | undefined;
  const context = useRouteTestApp(async (app) => {
    app.addHook("preValidation", async () => {
      await beforeWebhookHandler?.();
    });
    await app.register(routes);
  });
  let config: JiraDbConfig;
  beforeEach(async ({ makeAgent }) => {
    beforeWebhookHandler = undefined;
    const agent = await makeAgent({
      organizationId: context.organizationId,
      agentType: "agent",
    });
    config = {
      id: randomUUID(),
      organizationId: context.organizationId,
      enabled: true,
      siteUrl: "https://example.atlassian.net",
      ingressMode: "hmac",
      webhookSecret: "synthetic-secret",
      bots: [
        {
          id: randomUUID(),
          agentId: agent.id,
          accountId: "bot-account",
          displayName: "Helpful Bot",
          email: "bot@example.test",
          apiToken: "synthetic-token",
          enabled: true,
        },
      ],
    };
    await ChatOpsConfigModel.saveJiraConfig(config);
  });

  test("authenticates original bytes before JSON parsing and stores nothing on rejection", async () => {
    const response = await context.app.inject({
      method: "POST",
      url: `/api/webhooks/chatops/jira/${config.id}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature": "sha256=invalid",
      },
      payload: "{invalid-json",
    });
    expect(response.statusCode).toBe(401);
    expect(await db.select().from(schema.jiraChatOpsEventsTable)).toHaveLength(
      0,
    );
    expect(await db.select().from(schema.tasksTable)).toHaveLength(0);
  });

  test("ACK follows committed receipt and job; Jira retries remain one receipt", async () => {
    const raw = JSON.stringify({
      webhookEvent: "comment_created",
      issue: { id: "10000" },
      comment: { id: "20000", updated: "2026-10-26T10:00:00.000+0000" },
    });
    const headers = {
      "content-type": "application/json",
      "x-hub-signature": `sha256=${createHmac("sha256", config.webhookSecret).update(raw).digest("hex")}`,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await context.app.inject({
        method: "POST",
        url: `/api/webhooks/chatops/jira/${config.id}`,
        headers,
        payload: raw,
      });
      expect(response.statusCode).toBe(200);
    }
    expect(await db.select().from(schema.jiraChatOpsEventsTable)).toHaveLength(
      1,
    );
    expect(await db.select().from(schema.tasksTable)).toHaveLength(1);
  });

  for (const change of [
    { siteUrl: "https://replacement.atlassian.net" },
    { webhookSecret: "rotated-synthetic-secret" },
    { ingressMode: "automation" as const },
    { organizationId: randomUUID() },
  ]) {
    test(`rejects a ${Object.keys(change)[0]} change after authentication`, async () => {
      beforeWebhookHandler = async () => {
        await ChatOpsConfigModel.saveJiraConfig({ ...config, ...change });
      };
      const raw = JSON.stringify({
        webhookEvent: "comment_created",
        issue: { id: "10000" },
        comment: { id: "20000", updated: "2026-10-26T10:00:00.000+0000" },
      });
      const response = await context.app.inject({
        method: "POST",
        url: `/api/webhooks/chatops/jira/${config.id}`,
        headers: {
          "content-type": "application/json",
          "x-hub-signature": `sha256=${createHmac("sha256", config.webhookSecret).update(raw).digest("hex")}`,
        },
        payload: raw,
      });
      expect(response.statusCode).toBe(409);
      expect(
        await db.select().from(schema.jiraChatOpsEventsTable),
      ).toHaveLength(0);
      expect(await db.select().from(schema.tasksTable)).toHaveLength(0);
    });
  }

  test("does not route an authenticated event to a newly connected bot", async () => {
    const originalBotId = config.bots[0].id;
    beforeWebhookHandler = async () => {
      await ChatOpsConfigModel.saveJiraConfig({
        ...config,
        bots: [{ ...config.bots[0], id: randomUUID() }],
      });
    };
    const raw = JSON.stringify({
      webhookEvent: "comment_created",
      issue: { id: "10000" },
      comment: { id: "20000", updated: "2026-10-26T10:00:00.000+0000" },
    });
    const response = await context.app.inject({
      method: "POST",
      url: `/api/webhooks/chatops/jira/${config.id}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature": `sha256=${createHmac("sha256", config.webhookSecret).update(raw).digest("hex")}`,
      },
      payload: raw,
    });
    expect(response.statusCode).toBe(200);
    const receipts = await db.select().from(schema.jiraChatOpsEventsTable);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].botId).toBe(originalBotId);
  });
});
