/**
 * Hydrate a parallel dev stack's database with admin-configured rows from a
 * SOURCE Postgres so chat / agents / proxy work without re-entering keys.
 * Invoked via `pnpm dev:stack:hydrate`. The "hydrate" verb is deliberately
 * generic: today this copies the LLM-provider tables (secret, models,
 * chat_api_keys/llm_provider_api_keys, api_key_models), but future categories
 * (policies, agents, optimization rules) can be added here without renaming
 * the command.
 *
 * Source connection: SOURCE_DATABASE_URL env var.
 * Target connection: ARCHESTRA_DATABASE_URL env var (the standard one).
 *
 * Ownership rewrite: every copied chat_api_keys row is reassigned to the
 * target admin (env-driven via ARCHESTRA_AUTH_ADMIN_EMAIL, default
 * `admin@example.com`)'s user and organization with scope='personal' and
 * teamId=null. Source orgs/users/teams aren't mirrored — the parallel stack
 * is a sandbox where only admin exists.
 *
 * Idempotent: every INSERT uses ON CONFLICT DO NOTHING, so re-runs top up
 * rows the target is missing and never delete rows the dev added by hand.
 *
 * Encryption: secrets are inserted verbatim. Decryption requires the target's
 * ARCHESTRA_AUTH_SECRET to match the source's. `pnpm dev:stack:up` copies the
 * source .env (which carries ARCHESTRA_AUTH_SECRET) into the parallel
 * worktree, so that precondition is satisfied by the default flow.
 */

import { and, eq, inArray, not, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { withTransactionRetry } from "@/database/retry";
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
  // is missing rather than guessing. The admin email is overridable in .env;
  // matches the seeder in backend startup.
  const adminEmail =
    process.env.ARCHESTRA_AUTH_ADMIN_EMAIL || "admin@example.com";
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
    .where(eq(schema.usersTable.email, adminEmail))
    .limit(1);

  if (adminRows.length === 0) {
    logger.error(
      `ERROR: no ${adminEmail} user with a membership in the target DB. ` +
        "Has the parallel stack finished booting and seeded the default admin?",
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
  // `isPrimary=true` row in that bucket. Pre-seed the "already-primary"
  // providers from target's existing rows (the dev may have already added a
  // primary by hand) AND track within the source set; only keep
  // `isPrimary=true` when neither already claims it, otherwise demote. Force
  // `isSystem=false` because target seeds its own system key per provider
  // (the `chat_api_keys_system_unique` partial index would otherwise collide).
  //
  // Exclude rows whose UUID matches a source key — on re-hydrate those are
  // our own previous copies, not a dev-added primary, and demoting them
  // would clobber a key we're about to re-upsert.
  const sourceKeyIds = providerKeys.map((k) => k.id);
  const primaryFilters = [
    eq(schema.llmProviderApiKeysTable.organizationId, targetOrgId),
    eq(schema.llmProviderApiKeysTable.userId, targetUserId),
    eq(schema.llmProviderApiKeysTable.scope, "personal"),
    eq(schema.llmProviderApiKeysTable.isPrimary, true),
  ];
  if (sourceKeyIds.length) {
    primaryFilters.push(
      not(inArray(schema.llmProviderApiKeysTable.id, sourceKeyIds)),
    );
  }
  const existingTargetPrimaryProviders = new Set(
    (
      await target
        .select({ provider: schema.llmProviderApiKeysTable.provider })
        .from(schema.llmProviderApiKeysTable)
        .where(and(...primaryFilters))
    ).map((r) => r.provider),
  );
  const seenPrimaryProviders = new Set<string>(existingTargetPrimaryProviders);
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

  await withTransactionRetry(() =>
    target.transaction(async (tx) => {
      if (secrets.length) {
        // Re-hydrate after the source admin rotated a secret would otherwise
        // skip the row (same PK) and leave target with the stale/revoked
        // payload. Upsert the payload so rotations propagate.
        const result = await tx
          .insert(schema.secretsTable)
          .values(secrets)
          .onConflictDoUpdate({
            target: schema.secretsTable.id,
            set: {
              secret: sql`excluded.secret`,
              isVault: sql`excluded.is_vault`,
              isByosVault: sql`excluded.is_byos_vault`,
            },
          })
          .returning({ id: schema.secretsTable.id });
        copiedSecrets = result.length;
      }
      if (models.length) {
        // Models hit `models_provider_model_unique` when target already has the
        // same (provider, modelId) under a different UUID. ON CONFLICT DO
        // NOTHING would preserve target's row — including target's DEFAULT
        // values for fields the source admin actually edited (custom prices,
        // ignored flag). Upsert just those admin-editable columns from source
        // so hydrating carries the admin's intent across. Catalog columns
        // (externalId, contextLength, modalities, pricing-from-models.dev) are
        // left as-is because target's models.dev sync may be fresher.
        const result = await tx
          .insert(schema.modelsTable)
          .values(models)
          .onConflictDoUpdate({
            target: [schema.modelsTable.provider, schema.modelsTable.modelId],
            set: {
              customPricePerMillionInput: sql`excluded.custom_price_per_million_input`,
              customPricePerMillionOutput: sql`excluded.custom_price_per_million_output`,
              ignored: sql`excluded.ignored`,
            },
          })
          .returning({ id: schema.modelsTable.id });
        copiedModels = result.length;
      }
      if (rewrittenKeys.length) {
        // Re-hydrate after the source admin renamed a key, swapped its
        // secret, or tweaked the base URLs / extra headers would otherwise
        // skip the row (same PK) and leave the stale config. Upsert the
        // source-owned columns on PK conflict. Target-created keys (dev
        // added by hand) have target-side UUIDs and never match this
        // conflict target, so they're untouched. Ownership columns
        // (organization_id / user_id / team_id / scope) and isSystem aren't
        // re-set because they're always our chosen values. isPrimary uses
        // `excluded.is_primary` so the demotion logic above applies on
        // re-hydrate too.
        const result = await tx
          .insert(schema.llmProviderApiKeysTable)
          .values(rewrittenKeys)
          .onConflictDoUpdate({
            target: schema.llmProviderApiKeysTable.id,
            set: {
              name: sql`excluded.name`,
              secretId: sql`excluded.secret_id`,
              baseUrl: sql`excluded.base_url`,
              inferenceBaseUrl: sql`excluded.inference_base_url`,
              extraHeaders: sql`excluded.extra_headers`,
              isPrimary: sql`excluded.is_primary`,
            },
          })
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
        const sourceProviders = Array.from(
          new Set(models.map((m) => m.provider)),
        );
        const sourceModelIds = Array.from(
          new Set(models.map((m) => m.modelId)),
        );
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
    }),
  );

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
