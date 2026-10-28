import { and, asc, eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// Model pools are a beta feature; these tests run with it on.
beforeEach(() => {
  config.llmProxy.modelPoolsEnabled = true;
});

describe("POST /api/model-pools", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    await makeMember(user.id, organizationId);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    registerAuditLogHook(app);
    const { default: modelPoolRoutes } = await import("./model-pool.routes");
    await app.register(modelPoolRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates a pool across providers and lists it", async ({
    makeLlmProviderApiKey,
  }) => {
    const zai = await makeLlmProviderApiKey(organizationId, null, {
      provider: "zhipuai",
    });
    const bedrock = await makeLlmProviderApiKey(organizationId, null, {
      provider: "bedrock",
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/model-pools",
      payload: {
        name: "glm-5",
        members: [
          { providerApiKeyId: zai.id, modelId: "glm-5" },
          {
            providerApiKeyId: bedrock.id,
            modelId: "zai.glm-5",
            priority: 2,
            weight: 3,
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(200);

    const listed = await app.inject({ method: "GET", url: "/api/model-pools" });
    expect(listed.json()).toMatchObject([
      {
        name: "glm-5",
        members: [
          {
            providerApiKeyId: zai.id,
            providerApiKeyName: zai.name,
            provider: "zhipuai",
            modelId: "glm-5",
            priority: 1,
            weight: 1,
            enabled: true,
            benchedUntil: null,
          },
          {
            providerApiKeyId: bedrock.id,
            providerApiKeyName: bedrock.name,
            provider: "bedrock",
            modelId: "zai.glm-5",
            priority: 2,
            weight: 3,
            enabled: true,
            benchedUntil: null,
          },
        ],
      },
    ]);
  });

  test("stores the pool's own timeouts and cooldown, kept when an update leaves them out", async ({
    makeLlmProviderApiKey,
  }) => {
    const key = await makeLlmProviderApiKey(organizationId, null);
    const members = [{ providerApiKeyId: key.id, modelId: "claude-haiku-4-5" }];

    const created = await app.inject({
      method: "POST",
      url: "/api/model-pools",
      payload: {
        name: "claude-haiku-4-5",
        members,
        streamTimeoutSeconds: 120,
        timeoutSeconds: 600,
        cooldownSeconds: 300,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({
      streamTimeoutSeconds: 120,
      timeoutSeconds: 600,
      cooldownSeconds: 300,
    });
    const id = created.json().id;

    const kept = await app.inject({
      method: "PUT",
      url: `/api/model-pools/${id}`,
      payload: { name: "claude-haiku-4-5", members },
    });
    expect(kept.json()).toMatchObject({
      streamTimeoutSeconds: 120,
      timeoutSeconds: 600,
      cooldownSeconds: 300,
    });

    const cleared = await app.inject({
      method: "PUT",
      url: `/api/model-pools/${id}`,
      payload: {
        name: "claude-haiku-4-5",
        members,
        streamTimeoutSeconds: null,
        timeoutSeconds: null,
        cooldownSeconds: null,
      },
    });
    expect(cleared.json()).toMatchObject({
      streamTimeoutSeconds: null,
      timeoutSeconds: null,
      cooldownSeconds: null,
    });
    const audits = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "modelPool.updated"),
          eq(schema.auditLogsTable.resourceId, id),
        ),
      )
      .orderBy(asc(schema.auditLogsTable.createdAt));
    // The update that keeps them, then the one that clears them.
    expect(audits).toMatchObject([
      { before: { cooldownSeconds: 300 }, after: { cooldownSeconds: 300 } },
      { before: { cooldownSeconds: 300 }, after: { cooldownSeconds: null } },
    ]);

    for (const timing of [
      { streamTimeoutSeconds: 0 },
      { timeoutSeconds: 1801 },
      { cooldownSeconds: 1.5 },
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: `/api/model-pools/${id}`,
        payload: { name: "claude-haiku-4-5", members, ...timing },
      });
      expect(response.statusCode, response.body).toBe(400);
    }
  });

  test("rejects a personal key, a provider pools can't reach, and a repeated member", async ({
    makeLlmProviderApiKey,
  }) => {
    const shared = await makeLlmProviderApiKey(organizationId, null);
    const personal = await makeLlmProviderApiKey(organizationId, null, {
      userId: user.id,
    });
    const gemini = await makeLlmProviderApiKey(organizationId, null, {
      provider: "gemini",
    });

    for (const member of [
      { providerApiKeyId: personal.id, modelId: "claude-haiku-4-5" },
      { providerApiKeyId: gemini.id, modelId: "claude-haiku-4-5" },
      { providerApiKeyId: shared.id, modelId: "claude-haiku-4-5" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/model-pools",
        payload: {
          name: "claude-haiku-4-5",
          members: [
            { providerApiKeyId: shared.id, modelId: "claude-haiku-4-5" },
            member,
          ],
        },
      });
      expect(response.statusCode, response.body).toBe(400);
    }
  });

  test("refuses a second pool with the same name", async ({
    makeLlmProviderApiKey,
  }) => {
    const key = await makeLlmProviderApiKey(organizationId, null);
    const payload = {
      name: "claude-haiku-4-5",
      members: [{ providerApiKeyId: key.id, modelId: "claude-haiku-4-5" }],
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/model-pools",
      payload,
    });
    expect(first.statusCode, first.body).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/model-pools",
      payload,
    });
    expect(second.statusCode, second.body).toBe(409);

    const renamed = await app.inject({
      method: "PUT",
      url: `/api/model-pools/${first.json().id}`,
      payload: { ...payload, name: "haiku" },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
  });

  test("reserves the auto routing alias as a pool name", async ({
    makeLlmProviderApiKey,
  }) => {
    const key = await makeLlmProviderApiKey(organizationId, null);
    const payload = {
      name: "haiku",
      members: [{ providerApiKeyId: key.id, modelId: "claude-haiku-4-5" }],
    };

    const named = await app.inject({
      method: "POST",
      url: "/api/model-pools",
      payload: { ...payload, name: " auto " },
    });
    expect(named.statusCode, named.body).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/model-pools",
      payload,
    });
    expect(created.statusCode, created.body).toBe(200);
    const renamed = await app.inject({
      method: "PUT",
      url: `/api/model-pools/${created.json().id}`,
      payload: { ...payload, name: "auto" },
    });
    expect(renamed.statusCode, renamed.body).toBe(400);

    const listed = await app.inject({ method: "GET", url: "/api/model-pools" });
    expect(listed.json().map((pool: { name: string }) => pool.name)).toEqual([
      "haiku",
    ]);
  });

  test("is not there while model pools are off", async () => {
    config.llmProxy.modelPoolsEnabled = false;
    const listed = await app.inject({
      method: "GET",
      url: "/api/model-pools",
    });
    expect(listed.statusCode).toBe(404);
  });
});
