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

  test("creates and edits two Gemini models on a shared keyless Vertex credential", async ({
    makeLlmProviderApiKey,
  }) => {
    const key = await makeLlmProviderApiKey(organizationId, null, {
      provider: "gemini",
      name: "Vertex AI (Gemini)",
    });
    const members = ["gemini-2.5-flash", "gemini-2.5-flash-lite"].map(
      (modelId, index) => ({
        providerApiKeyId: key.id,
        modelId,
        priority: index + 1,
      }),
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/model-pools",
      payload: { name: "gemini-fallback", members },
    });
    expect(created.statusCode, created.body).toBe(200);
    const updated = await app.inject({
      method: "PUT",
      url: `/api/model-pools/${created.json().id}`,
      payload: {
        name: "gemini-fallback",
        members: members.map((member) => ({
          ...member,
          priority: 3 - member.priority,
        })),
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const listed = await app.inject({ method: "GET", url: "/api/model-pools" });
    expect(listed.json()[0].members).toEqual(
      expect.arrayContaining(
        members.map((member) =>
          expect.objectContaining({
            ...member,
            provider: "gemini",
            priority: 3 - member.priority,
          }),
        ),
      ),
    );
  });

  test("creates, edits, and audits a pool with the owner's Copilot subscription", async ({
    makeLlmProviderApiKey,
  }) => {
    const key = await makeLlmProviderApiKey(organizationId, null, {
      provider: "github-copilot",
      userId: user.id,
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/model-pools",
      payload: {
        name: "subscription-pool",
        members: [{ providerApiKeyId: key.id, modelId: "gpt-4.1" }],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id;
    const updated = await app.inject({
      method: "PUT",
      url: `/api/model-pools/${id}`,
      payload: {
        name: "subscription-pool",
        members: [{ providerApiKeyId: key.id, modelId: "gpt-5-mini" }],
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const listed = await app.inject({ method: "GET", url: "/api/model-pools" });
    expect(listed.json()[0].members).toMatchObject([
      {
        providerApiKeyId: key.id,
        provider: "github-copilot",
        modelId: "gpt-5-mini",
      },
    ]);
    const audits = await db
      .select({
        action: schema.auditLogsTable.action,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, id))
      .orderBy(asc(schema.auditLogsTable.createdAt));
    expect(audits).toMatchObject([
      {
        action: "modelPool.created",
        after: { members: [{ providerApiKeyId: key.id, modelId: "gpt-4.1" }] },
      },
      {
        action: "modelPool.updated",
        before: { members: [{ modelId: "gpt-4.1" }] },
        after: { members: [{ modelId: "gpt-5-mini" }] },
      },
    ]);
  });

  test("retains another owner's member during edits but rejects new foreign members", async ({
    makeLlmProviderApiKey,
    makeUser,
    makeMember,
  }) => {
    const ownerKey = await makeLlmProviderApiKey(organizationId, null, {
      provider: "github-copilot",
      userId: user.id,
    });
    const foreignKey = await makeLlmProviderApiKey(organizationId, null, {
      provider: "github-copilot",
      userId: user.id,
    });
    const retained = { providerApiKeyId: ownerKey.id, modelId: "gpt-4.1" };
    const created = await app.inject({
      method: "POST",
      url: "/api/model-pools",
      payload: { name: "owner-pool", members: [retained] },
    });
    expect(created.statusCode, created.body).toBe(200);
    user = await makeUser();
    await makeMember(user.id, organizationId);
    const editorKey = await makeLlmProviderApiKey(organizationId, null, {
      provider: "github-copilot",
      userId: user.id,
    });
    const members = [
      retained,
      { providerApiKeyId: editorKey.id, modelId: "gpt-4.1" },
    ];
    const url = `/api/model-pools/${created.json().id}`;
    const updated = await app.inject({
      method: "PUT",
      url,
      payload: { name: "renamed-pool", timeoutSeconds: 120, members },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      name: "renamed-pool",
      timeoutSeconds: 120,
    });
    expect(updated.json().members).toHaveLength(2);
    for (const addition of [
      { providerApiKeyId: foreignKey.id, modelId: "gpt-4.1" },
      { providerApiKeyId: ownerKey.id, modelId: "gpt-5-mini" },
    ]) {
      const rejected = await app.inject({
        method: "PUT",
        url,
        payload: { name: "renamed-pool", members: [...members, addition] },
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.body).toContain("belongs to another user");
    }
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

  test("persists, preserves, resets and audits retry settings", async ({
    makeLlmProviderApiKey,
  }) => {
    const key = await makeLlmProviderApiKey(organizationId, null);
    const retrySettings = {
      numRetries: 3,
      retryPolicy: { rateLimitError: 0 },
      initialDelayMs: 100,
      maxDelayMs: 1000,
    };
    const member = {
      providerApiKeyId: key.id,
      modelId: "test-model",
      retrySettings: { numRetries: 1, maxDelayMs: 100 },
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/model-pools",
      payload: { name: "retry-pool", retrySettings, members: [member] },
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id;
    const listed = await app.inject({ method: "GET", url: "/api/model-pools" });
    expect(listed.json()[0]).toMatchObject({
      retrySettings,
      members: [{ retrySettings: { numRetries: 1, maxDelayMs: 100 } }],
    });
    const kept = await app.inject({
      method: "PUT",
      url: `/api/model-pools/${id}`,
      payload: { name: "retry-pool", members: [member] },
    });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json().retrySettings).toEqual(retrySettings);
    const cleared = await app.inject({
      method: "PUT",
      url: `/api/model-pools/${id}`,
      payload: {
        name: "retry-pool",
        retrySettings: null,
        members: [{ ...member, retrySettings: null }],
      },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({
      retrySettings: null,
      members: [{ retrySettings: null }],
    });
    const audits = await db
      .select()
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "modelPool.updated"),
          eq(schema.auditLogsTable.resourceId, id),
        ),
      )
      .orderBy(asc(schema.auditLogsTable.createdAt));
    expect(audits[1]).toMatchObject({
      before: {
        retrySettings,
        members: [{ retrySettings: { numRetries: 1, maxDelayMs: 100 } }],
      },
      after: { retrySettings: null, members: [{ retrySettings: null }] },
    });
    for (const invalid of [
      { numRetries: -1 },
      { numRetries: 11 },
      { retryPolicy: { timeoutError: 1.5 } },
      { initialDelayMs: 99 },
      { maxDelayMs: 60001 },
      { initialDelayMs: 1000, maxDelayMs: 500 },
    ]) {
      for (const payload of [
        { retrySettings: invalid, members: [member] },
        { members: [{ ...member, retrySettings: invalid }] },
      ]) {
        const response = await app.inject({
          method: "PUT",
          url: `/api/model-pools/${id}`,
          payload: { name: "retry-pool", ...payload },
        });
        expect(response.statusCode, response.body).toBe(400);
      }
    }
  });

  test("rejects another user's key, an unsupported provider, and a repeated member", async ({
    makeLlmProviderApiKey,
    makeUser,
  }) => {
    const shared = await makeLlmProviderApiKey(organizationId, null);
    const personal = await makeLlmProviderApiKey(organizationId, null, {
      userId: (await makeUser()).id,
    });
    const cohere = await makeLlmProviderApiKey(organizationId, null, {
      provider: "cohere",
    });

    for (const member of [
      { providerApiKeyId: personal.id, modelId: "claude-haiku-4-5" },
      { providerApiKeyId: cohere.id, modelId: "claude-haiku-4-5" },
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
