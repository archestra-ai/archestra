import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { authPlugin } from "@/auth/fastify-plugin";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import ServiceAccountModel from "@/models/service-account";
import { testProviderApiKey } from "@/routes/chat/model-fetchers/registry";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// The provider is a process boundary: validating a key would call it.
vi.mock("@/routes/chat/model-fetchers/registry", () => ({
  testProviderApiKey: vi.fn(async () => undefined),
}));
vi.mock("@/services/model-sync", () => ({
  modelSyncService: {
    syncModelsForApiKey: vi.fn(),
    maybeAutoSetOrgDefaultModel: vi.fn(),
  },
}));

describe("POST /api/llm-provider-api-keys with a service-account token", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let authorization: string;

  beforeEach(async ({ makeOrganization }) => {
    vi.clearAllMocks();
    organizationId = (await makeOrganization()).id;
    const account = await ServiceAccountModel.create({
      organizationId,
      name: "Terraform",
      role: "admin",
      createdBy: null,
    });
    ({ token: authorization } = await ServiceAccountModel.createToken({
      serviceAccountId: account.id,
      organizationId,
      name: "terraform",
    }));

    app = createFastifyInstance();
    await app.register(authPlugin);
    const { default: llmProviderApiKeyRoutes } = await import(
      "./llm-provider-api-keys"
    );
    await app.register(llmProviderApiKeyRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  function createKey(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/llm-provider-api-keys",
      headers: { authorization },
      payload,
    });
  }

  test("400s for a key of its own, before the key is tested or stored", async () => {
    const secretsBefore = await db.$count(schema.secretsTable);

    const response = await createKey({
      name: "Terraform OpenAI",
      provider: "openai",
      apiKey: "sk-terraform-key",
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.message).toBe(
      "A service account cannot own a key. Set shared to true to create a shared key.",
    );
    expect(testProviderApiKey).not.toHaveBeenCalled();
    expect(await db.$count(schema.secretsTable)).toBe(secretsBefore);
    expect(
      await LlmProviderApiKeyModel.findByOrganizationId(organizationId),
    ).toEqual([]);
  });

  test("400s for a per-user credential without suggesting a shared key", async () => {
    const response = await createKey({
      name: "Terraform Copilot",
      provider: "github-copilot",
      apiKey: "gho_terraform_token",
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.message).toBe(
      "github-copilot keys are per-user, so a service account cannot hold one.",
    );
  });

  test("creates a shared key with the service account as its creator", async () => {
    const response = await createKey({
      name: "Terraform OpenAI",
      provider: "openai",
      apiKey: "sk-terraform-key",
      shared: true,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "org",
      userId: null,
      createdBy: { name: "Terraform", type: "service_account" },
    });
    expect(testProviderApiKey).toHaveBeenCalledOnce();
  });
});

describe("POST /api/llm-provider-api-keys when the insert fails", () => {
  test("removes the secret it stored for the key", async ({
    makeOrganization,
  }) => {
    vi.clearAllMocks();
    const organizationId = (await makeOrganization()).id;
    // A user deleted while the request runs: the key is tested and its secret
    // stored, then the insert fails on the owner's foreign key to users.
    const deletedUser = {
      id: randomUUID(),
      name: "Deleted user",
      email: "deleted@example.com",
    } as User;
    const app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: deletedUser, organizationId });
    });
    const { default: llmProviderApiKeyRoutes } = await import(
      "./llm-provider-api-keys"
    );
    try {
      await app.register(llmProviderApiKeyRoutes);
      const secretsBefore = await db.$count(schema.secretsTable);

      const response = await app.inject({
        method: "POST",
        url: "/api/llm-provider-api-keys",
        payload: { name: "My OpenAI", provider: "openai", apiKey: "sk-my-key" },
      });

      expect(response.statusCode, response.body).toBe(500);
      expect(testProviderApiKey).toHaveBeenCalledOnce();
      expect(await db.$count(schema.secretsTable)).toBe(secretsBefore);
    } finally {
      await app.close();
    }
  });
});
