import { generateKeyPairSync } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { LlmProviderApiKeyModel } from "@/models";
import { testProviderApiKey } from "@/routes/chat/model-fetchers/registry";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// The provider is a process boundary: validating a key would call GitHub.
vi.mock("@/routes/chat/model-fetchers/registry", () => ({
  testProviderApiKey: vi.fn(async () => undefined),
}));
vi.mock("@/services/model-sync", () => ({
  modelSyncService: {
    syncModelsForApiKey: vi.fn(),
    maybeAutoSetOrgDefaultModel: vi.fn(),
  },
}));

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("POST /api/llm-provider-api-keys with a GitHub App credential", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    const { default: routes } = await import("./llm-provider-api-keys");
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  const createKey = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      payload,
    });

  test("creates a shared Copilot key, stores one marker secret, and audits without the private key", async () => {
    const response = await createKey({
      name: "Org Copilot",
      provider: "github-copilot",
      shared: true,
      githubAppId: "4242",
      githubAppInstallationId: "777",
      githubAppPrivateKey: privateKey,
    });

    expect(response.statusCode, response.body).toBe(200);
    const created = response.json();
    expect(created).toMatchObject({ scope: "org", userId: null });
    expect(response.body).not.toContain("PRIVATE KEY");

    // Validated with the encoded credential, not the raw fields.
    expect(testProviderApiKey).toHaveBeenCalledOnce();
    const tested = vi.mocked(testProviderApiKey).mock.calls[0][0];
    expect(tested.apiKey.startsWith("github-app:")).toBe(true);

    const key = await LlmProviderApiKeyModel.findById(created.id);
    const stored = await getSecretValueForLlmProviderApiKey(
      key?.secretId ?? "",
    );
    expect(stored).toBe(tested.apiKey);

    const rows = await db
      .select({
        action: schema.auditLogsTable.action,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.organizationId, organizationId),
          eq(schema.auditLogsTable.resourceId, created.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].after).toMatchObject({
      name: "Org Copilot",
      provider: "github-copilot",
    });
    const audited = JSON.stringify(rows[0]);
    expect(audited).not.toContain("PRIVATE KEY");
    expect(audited).not.toContain("github-app:");
  });

  test("still refuses to share a personal Copilot sign-in", async () => {
    const response = await createKey({
      name: "My Copilot",
      provider: "github-copilot",
      shared: true,
      apiKey: "gho_personal_token",
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.message).toContain("per-user");
    expect(testProviderApiKey).not.toHaveBeenCalled();
  });

  test("rejects a bad private key before testing it", async () => {
    const response = await createKey({
      name: "Org Copilot",
      provider: "github-copilot",
      shared: true,
      githubAppId: "4242",
      githubAppInstallationId: "777",
      githubAppPrivateKey: "not-a-pem-secret",
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).not.toContain("not-a-pem-secret");
    expect(testProviderApiKey).not.toHaveBeenCalled();
  });

  test("lets another member's resolution use the shared App key but never a personal key", async ({
    makeUser,
    makeMember,
  }) => {
    const created = (
      await createKey({
        name: "Org Copilot",
        provider: "github-copilot",
        shared: true,
        githubAppId: "4242",
        githubAppInstallationId: "777",
        githubAppPrivateKey: privateKey,
        initialGrants: [
          { subject: { type: "organization", id: "*" }, actions: ["use"] },
        ],
      })
    ).json();
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });

    const resolved = await LlmProviderApiKeyModel.getCurrentApiKey({
      organizationId,
      userId: member.id,
      userTeamIds: [],
      provider: "github-copilot",
      conversationId: null,
    });

    expect(resolved?.id).toBe(created.id);
  });
});
