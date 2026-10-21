import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { count } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
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

async function countSecrets(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(schema.secretsTable);
  return row.n;
}

describe("PATCH /api/llm-provider-api-keys/:id when the update fails", () => {
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
    const { default: llmProviderApiKeyRoutes } = await import(
      "./llm-provider-api-keys"
    );
    await app.register(llmProviderApiKeyRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("removes the secret it stored for a key that had none", async ({
    makeLlmProviderApiKey,
  }) => {
    const apiKey = await makeLlmProviderApiKey(organizationId, null, {
      provider: "openai",
    });
    // A concurrent writer took the primary slot between the demotion and
    // this update. The test database has one connection, so that race is
    // injected here as the unique violation Postgres would raise.
    vi.spyOn(LlmProviderApiKeyModel, "update").mockRejectedValueOnce(
      Object.assign(
        new Error("duplicate key value violates unique constraint"),
        {
          code: "23505",
        },
      ),
    );
    const secretsBefore = await countSecrets();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${apiKey.id}`,
      payload: { apiKey: "sk-new-key", isPrimary: true },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(await countSecrets()).toBe(secretsBefore);
    expect((await LlmProviderApiKeyModel.findById(apiKey.id))?.secretId).toBe(
      null,
    );
  });
});
