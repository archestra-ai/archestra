import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { ModelModel } from "@/models";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0412_migrate_gemini_embedding_2.sql"),
  "utf-8",
);

async function runMigration() {
  await db.execute(sql.raw(migrationSql));
}

async function createGeminiEmbeddingModel(
  modelId: string,
  embeddingDimensions: 384 | 768 | 1024 | 1536 | 3072,
  inputModalities: Array<"text" | "image"> = ["text", "image"],
) {
  return ModelModel.create({
    externalId: `gemini/${modelId}`,
    provider: "gemini",
    modelId,
    description: modelId,
    contextLength: null,
    inputModalities,
    outputModalities: [],
    supportsToolCalling: false,
    promptPricePerToken: null,
    completionPricePerToken: null,
    embeddingDimensions,
    ignored: false,
    lastSyncedAt: new Date(),
  });
}

describe("0411 Gemini stable embedding migration", () => {
  test("preserves a live stable dimension and does not rewrite incompatible preview configs", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const stableOrg = await makeOrganization();
    const previewOrg = await makeOrganization();
    const otherProviderOrg = await makeOrganization();
    const stableSecret = await makeSecret({ secret: { apiKey: "stable" } });
    const previewSecret = await makeSecret({ secret: { apiKey: "preview" } });
    const otherSecret = await makeSecret({ secret: { apiKey: "other" } });
    const stableKey = await makeLlmProviderApiKey(
      stableOrg.id,
      stableSecret.id,
      { provider: "gemini" },
    );
    const previewKey = await makeLlmProviderApiKey(
      previewOrg.id,
      previewSecret.id,
      { provider: "gemini" },
    );
    const otherKey = await makeLlmProviderApiKey(
      otherProviderOrg.id,
      otherSecret.id,
      { provider: "openrouter" },
    );
    await createGeminiEmbeddingModel("gemini-embedding-2-preview", 768);
    const stable = await createGeminiEmbeddingModel(
      "gemini-embedding-2",
      3072,
      ["text"],
    );
    await db
      .update(schema.organizationsTable)
      .set({
        embeddingChatApiKeyId: stableKey.id,
        embeddingModel: "gemini-embedding-2",
      })
      .where(eq(schema.organizationsTable.id, stableOrg.id));
    const stableKnowledgeBase = await makeKnowledgeBase(stableOrg.id);
    const stableConnector = await makeKnowledgeBaseConnector(
      stableKnowledgeBase.id,
      stableOrg.id,
    );
    await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set({ checkpoint: { type: "dropbox", cursor: "already-advanced" } })
      .where(eq(schema.knowledgeBaseConnectorsTable.id, stableConnector.id));
    await db
      .update(schema.organizationsTable)
      .set({
        embeddingChatApiKeyId: previewKey.id,
        embeddingModel: "gemini-embedding-2-preview",
      })
      .where(eq(schema.organizationsTable.id, previewOrg.id));
    await db
      .update(schema.organizationsTable)
      .set({
        embeddingChatApiKeyId: otherKey.id,
        embeddingModel: "gemini-embedding-2-preview",
      })
      .where(eq(schema.organizationsTable.id, otherProviderOrg.id));

    await runMigration();

    expect((await ModelModel.findById(stable.id))?.embeddingDimensions).toBe(
      3072,
    );
    expect((await ModelModel.findById(stable.id))?.inputModalities).toEqual([
      "text",
      "image",
    ]);
    const [rewoundConnector] = await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.id, stableConnector.id));
    expect(rewoundConnector.checkpoint).toBeNull();
    const [unchangedPreview] = await db
      .select()
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, previewOrg.id));
    const [unchangedOther] = await db
      .select()
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, otherProviderOrg.id));
    expect(unchangedPreview.embeddingModel).toBe("gemini-embedding-2-preview");
    expect(unchangedOther.embeddingModel).toBe("gemini-embedding-2-preview");
  });

  test("renames a preview-only Gemini config without touching another provider", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const geminiOrg = await makeOrganization();
    const otherOrg = await makeOrganization();
    const geminiSecret = await makeSecret({ secret: { apiKey: "gemini" } });
    const otherSecret = await makeSecret({ secret: { apiKey: "other" } });
    const geminiKey = await makeLlmProviderApiKey(
      geminiOrg.id,
      geminiSecret.id,
      { provider: "gemini" },
    );
    const otherKey = await makeLlmProviderApiKey(otherOrg.id, otherSecret.id, {
      provider: "openrouter",
    });
    await createGeminiEmbeddingModel("gemini-embedding-2-preview", 1536);
    for (const [organizationId, keyId] of [
      [geminiOrg.id, geminiKey.id],
      [otherOrg.id, otherKey.id],
    ]) {
      await db
        .update(schema.organizationsTable)
        .set({
          embeddingChatApiKeyId: keyId,
          embeddingModel: "gemini-embedding-2-preview",
        })
        .where(eq(schema.organizationsTable.id, organizationId));
    }

    await runMigration();

    const [migratedGemini] = await db
      .select()
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, geminiOrg.id));
    const [unchangedOther] = await db
      .select()
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, otherOrg.id));
    expect(migratedGemini.embeddingModel).toBe("gemini-embedding-2");
    expect(unchangedOther.embeddingModel).toBe("gemini-embedding-2-preview");
  });
});
