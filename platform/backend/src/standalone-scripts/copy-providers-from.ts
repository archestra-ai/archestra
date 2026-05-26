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

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@/database/schemas";
import logger from "@/logging";

const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.ARCHESTRA_DATABASE_URL;

if (!sourceUrl) {
  logger.error("ERROR: SOURCE_DATABASE_URL is not set");
  process.exit(1);
}
if (!targetUrl) {
  logger.error("ERROR: ARCHESTRA_DATABASE_URL is not set");
  process.exit(1);
}
if (sourceUrl === targetUrl) {
  logger.error(
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
    logger.error(
      "ERROR: no admin@example.com user with a membership in the target DB. " +
        "Has the parallel stack finished booting and seeding the default admin?",
    );
    process.exit(1);
  }

  const { userId: targetUserId, organizationId: targetOrgId } = adminRows[0];

  // Read source-side rows. The `secret` table also stores OAuth tokens,
  // virtual-API-key secrets, etc. — we only want the rows referenced by
  // provider keys, otherwise we'd import orphan credentials into target.
  const [models, providerKeys, apiKeyModels] = await Promise.all([
    source.select().from(schema.modelsTable),
    source.select().from(schema.llmProviderApiKeysTable),
    source.select().from(schema.llmProviderApiKeyModelsTable),
  ]);
  const referencedSecretIds = Array.from(
    new Set(
      providerKeys
        .map((k) => k.secretId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const secrets = referencedSecretIds.length
    ? await source
        .select()
        .from(schema.secretsTable)
        .where(inArray(schema.secretsTable.id, referencedSecretIds))
    : [];

  // Collapsing scope to 'personal' means many source keys can flatten onto
  // the same (org, provider, scope='personal', user_id) tuple — the partial
  // unique index `chat_api_keys_primary_personal_unique` allows only one
  // `isPrimary=true` row in that bucket. Keep `isPrimary=true` for the FIRST
  // copied key per provider; demote the rest. Force `isSystem=false` because
  // target seeds its own system key per provider (the
  // `chat_api_keys_system_unique` partial index would otherwise collide).
  const seenPrimaryProviders = new Set<string>();
  const rewrittenKeys = providerKeys.map((k) => {
    const keepPrimary = k.isPrimary && !seenPrimaryProviders.has(k.provider);
    if (keepPrimary) seenPrimaryProviders.add(k.provider);
    return {
      ...k,
      organizationId: targetOrgId,
      userId: targetUserId,
      teamId: null,
      scope: "personal" as const,
      isPrimary: keepPrimary,
      isSystem: false,
    };
  });

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
      // For keys we filter by what landed in target (a source key whose
      // insert was skipped by a unique-index conflict has no target row to
      // FK to). For models we have to REMAP — `models_provider_model_unique`
      // means target may already have a logically-equivalent row under a
      // different UUID, in which case the source row was skipped but the
      // link should still resolve to target's existing UUID instead of
      // being dropped.
      const sourceKeyIds = providerKeys.map((k) => k.id);
      const sourceProviders = Array.from(
        new Set(models.map((m) => m.provider)),
      );
      const sourceModelIds = Array.from(new Set(models.map((m) => m.modelId)));
      const [presentKeys, targetMatchingModels] = await Promise.all([
        sourceKeyIds.length
          ? tx
              .select({ id: schema.llmProviderApiKeysTable.id })
              .from(schema.llmProviderApiKeysTable)
              .where(inArray(schema.llmProviderApiKeysTable.id, sourceKeyIds))
          : Promise.resolve([] as { id: string }[]),
        sourceProviders.length && sourceModelIds.length
          ? tx
              .select({
                id: schema.modelsTable.id,
                provider: schema.modelsTable.provider,
                modelId: schema.modelsTable.modelId,
              })
              .from(schema.modelsTable)
              .where(
                and(
                  inArray(schema.modelsTable.provider, sourceProviders),
                  inArray(schema.modelsTable.modelId, sourceModelIds),
                ),
              )
          : Promise.resolve(
              [] as { id: string; provider: string; modelId: string }[],
            ),
      ]);
      const presentKeyIds = new Set(presentKeys.map((r) => r.id));
      const targetModelByCompound = new Map(
        targetMatchingModels.map((t) => [`${t.provider}:${t.modelId}`, t.id]),
      );
      const sourceToTargetModelId = new Map<string, string>();
      for (const sm of models) {
        const tid = targetModelByCompound.get(`${sm.provider}:${sm.modelId}`);
        if (tid) sourceToTargetModelId.set(sm.id, tid);
      }
      const linkable = apiKeyModels.flatMap((l) => {
        if (!presentKeyIds.has(l.apiKeyId)) return [];
        const remappedModelId = sourceToTargetModelId.get(l.modelId);
        if (!remappedModelId) return [];
        return [{ ...l, modelId: remappedModelId }];
      });
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

  logger.info(
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
