import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { sql } from "drizzle-orm";
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

/**
 * Make every update of a provider key row do what a concurrent writer would
 * cause: "conflict" raises the unique violation Postgres reports when another
 * writer took the primary slot, "gone" skips the row as if it was deleted.
 * The test database has one connection, so the real race cannot happen here.
 */
async function interceptKeyRowUpdates(effect: "conflict" | "gone") {
  const body =
    effect === "conflict"
      ? "RAISE EXCEPTION 'duplicate key value violates unique constraint' USING ERRCODE = '23505';"
      : "RETURN NULL;";
  await db.execute(
    sql.raw(`
      CREATE FUNCTION intercept_key_row_update() RETURNS trigger AS $$
      BEGIN
        ${body}
      END;
      $$ LANGUAGE plpgsql;
    `),
  );
  await db.execute(sql`
    CREATE TRIGGER intercept_key_row_update
      BEFORE UPDATE ON chat_api_keys
      FOR EACH ROW EXECUTE FUNCTION intercept_key_row_update();
  `);
}

describe("provider key writes that fail after the secret is stored", () => {
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
    await db.execute(
      sql`DROP FUNCTION IF EXISTS intercept_key_row_update() CASCADE`,
    );
    await app.close();
  });

  test.for([
    ["the update conflicts", "conflict"],
    ["the key is gone", "gone"],
  ] as const)("PATCH deletes the secret it stored for a key that had none when %s", async ([
    ,
    effect,
  ], { makeLlmProviderApiKey }) => {
    const apiKey = await makeLlmProviderApiKey(organizationId, null, {
      provider: "openai",
    });
    await interceptKeyRowUpdates(effect);
    const secretsBefore = await db.$count(schema.secretsTable);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/llm-provider-api-keys/${apiKey.id}`,
      payload: { apiKey: "sk-new-key", isPrimary: true },
    });

    if (effect === "conflict") {
      expect(response.statusCode, response.body).toBe(409);
    }
    expect(await db.$count(schema.secretsTable)).toBe(secretsBefore);
    expect((await LlmProviderApiKeyModel.findById(apiKey.id))?.secretId).toBe(
      null,
    );
  });

  test("reconnect deletes the secret it stored when the key is gone", async ({
    makeLlmProviderApiKey,
  }) => {
    const apiKey = await makeLlmProviderApiKey(organizationId, null, {
      provider: "github-copilot",
      userId: user.id,
    });
    await interceptKeyRowUpdates("gone");
    const secretsBefore = await db.$count(schema.secretsTable);

    await app.inject({
      method: "POST",
      url: `/api/llm-provider-api-keys/${apiKey.id}/reconnect`,
      payload: { apiKey: "gho_new_token" },
    });

    expect(await db.$count(schema.secretsTable)).toBe(secretsBefore);
  });
});
