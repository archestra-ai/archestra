import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import {
  LlmProviderApiKeyModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import llmProviderApiKeyRoutes from "./llm-provider-api-keys";

describe("DELETE /api/llm-provider-api-keys/bulk", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(llmProviderApiKeyRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const bulkDelete = (ids: unknown) =>
    app.inject({
      method: "DELETE",
      url: "/api/llm-provider-api-keys/bulk",
      payload: { ids },
    });

  const createKey = async (
    name: string,
    makeSecret: (params?: { secret?: Record<string, unknown> }) => Promise<{
      id: string;
    }>,
  ) => {
    const secret = await makeSecret({
      secret: { apiKey: `bulk-secret-${name}` },
    });
    return LlmProviderApiKeyModel.create({
      organizationId,
      name,
      provider: "anthropic",
      secretId: secret.id,
      scope: "org",
      userId: null,
      teamId: null,
    });
  };

  test("deletes eligible keys and reports missing, foreign, system, and in-use keys independently", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const deleted = await createKey("bulk-delete", makeSecret);
    const inUse = await createKey("bulk-in-use", makeSecret);
    const foreignOrganizationId = (await makeOrganization()).id;
    const foreignSecret = await makeSecret();
    const foreign = await LlmProviderApiKeyModel.create({
      organizationId: foreignOrganizationId,
      name: "bulk-foreign",
      provider: "anthropic",
      secretId: foreignSecret.id,
      scope: "org",
      userId: null,
      teamId: null,
    });
    const system = await LlmProviderApiKeyModel.createSystemKey({
      organizationId,
      name: "bulk-system",
      provider: "gemini",
    });
    await OrganizationModel.patch(organizationId, {
      ocrChatApiKeyId: inUse.id,
      ocrModel: "claude-sonnet-5",
    });
    const missing = crypto.randomUUID();
    const cleanup = vi.spyOn(ModelModel, "deleteOrphanedModels");

    const response = await bulkDelete([
      deleted.id,
      missing,
      foreign.id,
      system.id,
      inUse.id,
    ]);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [{ id: deleted.id, name: "bulk-delete" }],
      failed: [
        {
          id: missing,
          name: null,
          error: "LLM provider API key not found",
        },
        {
          id: foreign.id,
          name: null,
          error: "LLM provider API key not found",
        },
        {
          id: system.id,
          name: "bulk-system",
          error: "System API keys cannot be deleted",
        },
        {
          id: inUse.id,
          name: "bulk-in-use",
          error:
            "This API key is used for knowledge base OCR. Remove it from Settings > Knowledge before deleting.",
        },
      ],
    });
    expect(await LlmProviderApiKeyModel.findById(deleted.id)).toBeNull();
    expect(await LlmProviderApiKeyModel.findById(foreign.id)).not.toBeNull();
    expect(await LlmProviderApiKeyModel.findById(system.id)).not.toBeNull();
    expect(await LlmProviderApiKeyModel.findById(inUse.id)).not.toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test("rejects a batch over the cap", async () => {
    const ids = Array.from({ length: 501 }, () => crypto.randomUUID());
    expect((await bulkDelete(ids)).statusCode).toBe(400);
  });

  test("rejects malformed ids before querying UUID columns", async () => {
    const response = await bulkDelete(["not-a-uuid"]);

    expect(response.statusCode).toBe(400);
  });

  test("does not disclose another user's personal key", async ({
    makeSecret,
    makeUser,
  }) => {
    const otherUser = await makeUser();
    const secret = await makeSecret();
    const hidden = await LlmProviderApiKeyModel.create({
      organizationId,
      name: "private credential name",
      provider: "anthropic",
      secretId: secret.id,
      scope: "personal",
      userId: otherUser.id,
      teamId: null,
    });

    const response = await bulkDelete([hidden.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [],
      failed: [
        {
          id: hidden.id,
          name: null,
          error: "LLM provider API key not found",
        },
      ],
    });
    expect(response.body).not.toContain("private credential name");
    expect(await LlmProviderApiKeyModel.findById(hidden.id)).not.toBeNull();
  });

  test("keeps organization-scoped keys protected by their existing authorization rule", async ({
    makeMember,
    makeSecret,
    makeUser,
  }) => {
    const key = await createKey("bulk-rbac", makeSecret);
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: member });
    });

    const response = await bulkDelete([key.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().failed).toEqual([
      {
        id: key.id,
        name: "bulk-rbac",
        error:
          "Only llmProviderApiKey admins can modify organization-wide API keys",
      },
    ]);
    expect(await LlmProviderApiKeyModel.findById(key.id)).not.toBeNull();
  });

  test("writes one redacted audit record for the successful batch", async ({
    makeSecret,
  }) => {
    const key = await createKey("bulk-audited", makeSecret);

    expect((await bulkDelete([key.id])).statusCode).toBe(200);

    const rows = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
        resourceType: schema.auditLogsTable.resourceType,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "llmProviderApiKey.bulk_deleted"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].resourceType).toBe("llmProviderApiKey");
    expect(rows[0].before).toMatchObject({
      llmProviderApiKeys: [
        {
          id: key.id,
          name: "bulk-audited",
          provider: "anthropic",
          scope: "org",
        },
      ],
    });
    expect(rows[0].after).toMatchObject({ llmProviderApiKeys: [] });
    expect(JSON.stringify(rows[0].before)).not.toContain(
      "bulk-secret-bulk-audited",
    );
  });
});
