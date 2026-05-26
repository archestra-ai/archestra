/**
 * Copy LLM-provider rows (secrets, models, chat_api_keys/llm_provider_api_keys,
 * api_key_models) from a SOURCE Postgres into the TARGET Postgres (the one this
 * backend is configured for). Used by `pnpm dev:stack:copy-providers` to make a
 * fresh parallel dev stack immediately usable for chat/agents/proxy without
 * re-entering API keys.
 *
 * Source connection: SOURCE_DATABASE_URL env var.
 * Target connection: ARCHESTRA_DATABASE_URL env var (the standard one).
 *
 * Ownership rewrite: every copied chat_api_keys row is reassigned to the target
 * admin (`admin@example.com`)'s user and organization with scope='personal' and
 * teamId=null. Source orgs/users/teams aren't mirrored — the parallel stack is
 * a sandbox where only admin exists.
 *
 * Idempotent: every INSERT uses ON CONFLICT DO NOTHING, so re-runs top up rows
 * the target is missing and never delete rows the dev added by hand.
 *
 * Encryption: secrets are inserted verbatim. Decryption requires the target's
 * ARCHESTRA_AUTH_SECRET to match the source's. `pnpm dev:stack:up` copies the
 * source .env (which carries ARCHESTRA_AUTH_SECRET) into the parallel worktree,
 * so that precondition is satisfied by the default flow.
 */

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@/database/schemas";

const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.ARCHESTRA_DATABASE_URL;

if (!sourceUrl) {
  console.error("ERROR: SOURCE_DATABASE_URL is not set");
  process.exit(1);
}
if (!targetUrl) {
  console.error("ERROR: ARCHESTRA_DATABASE_URL is not set");
  process.exit(1);
}
if (sourceUrl === targetUrl) {
  console.error(
    "ERROR: SOURCE_DATABASE_URL and ARCHESTRA_DATABASE_URL are the same",
  );
  process.exit(1);
}

const sourcePool = new pg.Pool({ connectionString: sourceUrl });
const targetPool = new pg.Pool({ connectionString: targetUrl });
const source = drizzle(sourcePool, { schema });
const target = drizzle(targetPool, { schema });

try {
  // Resolve target admin's user + org. Without a member row the user can't own
  // a chat_api_key (organization_id is NOT NULL), so we fail loudly if either
  // is missing rather than guessing.
  const adminRows = await target
    .select({
      userId: schema.usersTable.id,
      organizationId: schema.membersTable.organizationId,
    })
    .from(schema.usersTable)
    .innerJoin(
      schema.membersTable,
      eq(schema.membersTable.userId, schema.usersTable.id),
    )
    .where(eq(schema.usersTable.email, "admin@example.com"))
    .limit(1);

  if (adminRows.length === 0) {
    console.error(
      "ERROR: no admin@example.com user with a membership in the target DB. " +
        "Has the parallel stack finished booting and seeding the default admin?",
    );
    process.exit(1);
  }

  const { userId: targetUserId, organizationId: targetOrgId } = adminRows[0];

  // Read source-side rows.
  const [secrets, models, providerKeys, apiKeyModels] = await Promise.all([
    source.select().from(schema.secretsTable),
    source.select().from(schema.modelsTable),
    source.select().from(schema.llmProviderApiKeysTable),
    source.select().from(schema.llmProviderApiKeyModelsTable),
  ]);

  const rewrittenKeys = providerKeys.map((k) => ({
    ...k,
    organizationId: targetOrgId,
    userId: targetUserId,
    teamId: null,
    scope: "personal" as const,
  }));

  let copiedSecrets = 0;
  let copiedModels = 0;
  let copiedKeys = 0;
  let copiedKeyModels = 0;

  await target.transaction(async (tx) => {
    if (secrets.length) {
      const result = await tx
        .insert(schema.secretsTable)
        .values(secrets)
        .onConflictDoNothing()
        .returning({ id: schema.secretsTable.id });
      copiedSecrets = result.length;
    }
    if (models.length) {
      const result = await tx
        .insert(schema.modelsTable)
        .values(models)
        .onConflictDoNothing()
        .returning({ id: schema.modelsTable.id });
      copiedModels = result.length;
    }
    if (rewrittenKeys.length) {
      const result = await tx
        .insert(schema.llmProviderApiKeysTable)
        .values(rewrittenKeys)
        .onConflictDoNothing()
        .returning({ id: schema.llmProviderApiKeysTable.id });
      copiedKeys = result.length;
    }
    if (apiKeyModels.length) {
      // Filter link rows to those whose api_key_id AND model_id are actually
      // present in target. Without this, a source key whose insert was
      // skipped (because target already had a logically-equivalent key under
      // a different UUID and the unique index on org/provider/scope/user_id
      // blocked the new row) leaves a dangling source api_key_id in the link
      // rows, and the link insert aborts the whole transaction on an FK
      // violation. Same for models.
      const sourceKeyIds = providerKeys.map((k) => k.id);
      const sourceModelIds = models.map((m) => m.id);
      const [presentKeys, presentModels] = await Promise.all([
        sourceKeyIds.length
          ? tx
              .select({ id: schema.llmProviderApiKeysTable.id })
              .from(schema.llmProviderApiKeysTable)
              .where(inArray(schema.llmProviderApiKeysTable.id, sourceKeyIds))
          : Promise.resolve([] as { id: string }[]),
        sourceModelIds.length
          ? tx
              .select({ id: schema.modelsTable.id })
              .from(schema.modelsTable)
              .where(inArray(schema.modelsTable.id, sourceModelIds))
          : Promise.resolve([] as { id: string }[]),
      ]);
      const presentKeyIds = new Set(presentKeys.map((r) => r.id));
      const presentModelIds = new Set(presentModels.map((r) => r.id));
      const linkable = apiKeyModels.filter(
        (l) => presentKeyIds.has(l.apiKeyId) && presentModelIds.has(l.modelId),
      );
      if (linkable.length) {
        const result = await tx
          .insert(schema.llmProviderApiKeyModelsTable)
          .values(linkable)
          .onConflictDoNothing()
          .returning({
            apiKeyId: schema.llmProviderApiKeyModelsTable.apiKeyId,
          });
        copiedKeyModels = result.length;
      }
    }
  });

  console.log(
    `✅ Copied: ${copiedSecrets}/${secrets.length} secrets, ` +
      `${copiedModels}/${models.length} models, ` +
      `${copiedKeys}/${providerKeys.length} provider keys, ` +
      `${copiedKeyModels}/${apiKeyModels.length} key/model links ` +
      `(rows already present were skipped via ON CONFLICT DO NOTHING)`,
  );
} finally {
  await sourcePool.end();
  await targetPool.end();
}
