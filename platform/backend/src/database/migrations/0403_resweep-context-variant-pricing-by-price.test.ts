import fs from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0403_resweep-context-variant-pricing-by-price.sql"),
  "utf-8",
);

async function runMigration() {
  await db.execute(sql.raw(migrationSql));
}

async function insertModel(values: {
  modelId: string;
  discoveredViaLlmProxy: boolean;
  promptPricePerToken?: string | null;
  completionPricePerToken?: string | null;
  contextLength?: number | null;
  inputModalities?: ("text" | "image")[] | null;
}) {
  const [row] = await db
    .insert(schema.modelsTable)
    .values({
      externalId: `anthropic/${values.modelId}`,
      provider: "anthropic",
      modelId: values.modelId,
      discoveredViaLlmProxy: values.discoveredViaLlmProxy,
      promptPricePerToken: values.promptPricePerToken ?? null,
      completionPricePerToken: values.completionPricePerToken ?? null,
      contextLength: values.contextLength ?? null,
      inputModalities: values.inputModalities ?? null,
      lastSyncedAt: new Date(),
    })
    .returning();
  return row;
}

async function readModel(modelId: string) {
  const [row] = await db
    .select()
    .from(schema.modelsTable)
    .where(
      and(
        eq(schema.modelsTable.provider, "anthropic"),
        eq(schema.modelsTable.modelId, modelId),
      ),
    );
  return row ?? null;
}

describe("0403 context-variant pricing re-sweep", () => {
  test("prices a marked row whose canonical model is itself still flagged proxy-discovered", async () => {
    // The state the earlier passes could not match: nothing ever clears
    // discovered_via_llm_proxy, so a model the proxy named before a key had
    // synced it stays flagged even once a catalog priced it.
    await insertModel({
      modelId: "claude-opus-4-7",
      discoveredViaLlmProxy: true,
      promptPricePerToken: "0.000005000000",
      completionPricePerToken: "0.000025000000",
      contextLength: 1000000,
    });
    await insertModel({
      modelId: "claude-opus-4-7[1m]",
      discoveredViaLlmProxy: true,
    });

    await runMigration();

    const variant = await readModel("claude-opus-4-7[1m]");
    expect(variant?.promptPricePerToken).toBe("0.000005000000");
    expect(variant?.completionPricePerToken).toBe("0.000025000000");
    expect(variant?.contextLength).toBe(1000000);
    // The marked row is genuinely proxy-discovered, so it keeps the protection
    // that spares it from deleteOrphanedModels.
    expect(variant?.discoveredViaLlmProxy).toBe(true);
  });

  test("leaves a marked row alone when the model it names has no price yet", async () => {
    await insertModel({
      modelId: "claude-opus-9",
      discoveredViaLlmProxy: false,
    });
    const before = await insertModel({
      modelId: "claude-opus-9[1m]",
      discoveredViaLlmProxy: true,
    });

    await runMigration();

    const variant = await readModel("claude-opus-9[1m]");
    expect(variant?.promptPricePerToken).toBeNull();
    // Copying an unpriced row would leave the same null behind, so the
    // untouched timestamp is what separates "skipped" from "matched and copied
    // nothing" -- every row the statement matches gets last_synced_at = now().
    expect(variant?.lastSyncedAt).toEqual(before.lastSyncedAt);
  });

  test("does not overwrite a marked row that already carries a price", async () => {
    // A price that differs from the marked row's, so an overwrite would show.
    await insertModel({
      modelId: "claude-fable-5",
      discoveredViaLlmProxy: false,
      promptPricePerToken: "0.000099000000",
      completionPricePerToken: "0.000050000000",
    });
    const before = await insertModel({
      modelId: "claude-fable-5[1m]",
      discoveredViaLlmProxy: true,
      promptPricePerToken: "0.000010000000",
      completionPricePerToken: "0.000050000000",
    });

    await runMigration();
    await runMigration();

    const variant = await readModel("claude-fable-5[1m]");
    expect(variant?.promptPricePerToken).toBe("0.000010000000");
    expect(variant?.lastSyncedAt).toEqual(before.lastSyncedAt);
  });

  test("leaves a bracketed id from another vendor alone", async () => {
    await insertModel({
      modelId: "gpt-5.4",
      discoveredViaLlmProxy: false,
      promptPricePerToken: "0.000001000000",
    });
    await insertModel({
      modelId: "gpt-5.4[1m]",
      discoveredViaLlmProxy: true,
    });

    await runMigration();

    const variant = await readModel("gpt-5.4[1m]");
    expect(variant?.promptPricePerToken).toBeNull();
  });

  test("keeps modalities someone edited on the marked row", async () => {
    await insertModel({
      modelId: "claude-opus-4-8",
      discoveredViaLlmProxy: true,
      promptPricePerToken: "0.000005000000",
      inputModalities: ["text", "image"],
    });
    await insertModel({
      modelId: "claude-opus-4-8[1m]",
      discoveredViaLlmProxy: true,
      inputModalities: ["text"],
    });

    await runMigration();

    const variant = await readModel("claude-opus-4-8[1m]");
    // Priced from the canonical row, but the edit dialog writes modalities
    // straight to this column with no override to fall back on, so the copy
    // deliberately leaves it out.
    expect(variant?.promptPricePerToken).toBe("0.000005000000");
    expect(variant?.inputModalities).toEqual(["text"]);
  });
});
