import {
  credentialRequiresPerUserScope,
  getProvidersWithOptionalApiKey,
  isCredentialLevelSubscriptionProvider,
  isVaultReference,
  parseVaultReference,
  providerRequiresPerUserCredential,
  type ResourcePermissionGrant,
  SUBSCRIPTION_CREDENTIALS,
  type SubscriptionCredentialKind,
  type SupportedProvider,
  subscriptionKindFromCredential,
} from "@archestra/shared";
import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { isAnthropicKeylessAuthEnabled } from "@/clients/anthropic-keyless-auth";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import config from "@/config";
import db, { schema, type Transaction } from "@/database";
import logger from "@/logging";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { computeSecretStorageType } from "@/secrets-manager/utils";
import type {
  InsertLlmProviderApiKey,
  LlmProviderApiKey,
  LlmProviderApiKeyWithScopeInfo,
  ResourceVisibilityScope,
  SecretStorageType,
  SecretValue,
  UpdateLlmProviderApiKey,
} from "@/types";
import { decryptSecretValue, isEncryptedSecret } from "@/utils/crypto";
import { escapeLikePattern } from "@/utils/sql-search";
import ConversationModel from "./conversation";
import CreatedByModel from "./created-by";
import { LlmProviderApiKeyLabelModel } from "./entity-labels";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

class LlmProviderApiKeyModel {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  static async canUseKey(
    apiKey: LlmProviderApiKey,
    userId: string,
    /** No longer consulted: grants decide, and they resolve teams in SQL. */
    _userTeamIds: string[],
  ): Promise<boolean> {
    const secret = apiKey.secretId
      ? await getSecretValueForLlmProviderApiKey(apiKey.secretId)
      : undefined;
    if (
      credentialRequiresPerUserScope({
        provider: apiKey.provider,
        apiKey: secret,
      }) &&
      apiKey.userId !== userId
    )
      return false;
    const [row] = await db
      .select({ id: schema.llmProviderApiKeysTable.id })
      .from(schema.llmProviderApiKeysTable)
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.id, apiKey.id),
          LlmProviderApiKeyModel.accessCondition({
            organizationId: apiKey.organizationId,
            userId,
            action: "use",
          }),
        ),
      );
    return !!row;
  }
  // SPDX-SnippetEnd

  /**
   * Create a new LLM provider API key.
   *
   * "Primary" is exclusive per (organization, provider, scope[, user/team]) —
   * enforced by partial unique indexes. Creating a new primary demotes the
   * current one in the same transaction, so callers can mark a key primary
   * without first hunting down and unsetting the old one.
   */
  static async create(
    data: InsertLlmProviderApiKey,
    /** Explicit starting audience; omitted derives one from the scope. */
    options?: { initialPermissionGrants?: ResourcePermissionGrant[] },
  ): Promise<LlmProviderApiKey> {
    return await db.transaction(async (tx) => {
      if (data.isPrimary) {
        await demoteCurrentPrimary(tx, {
          organizationId: data.organizationId,
          provider: data.provider,
          scope: data.scope,
          userId: data.userId ?? null,
          teamId: data.teamId ?? null,
        });
      }

      const [apiKey] = await tx
        .insert(schema.llmProviderApiKeysTable)
        .values(
          await CreatedByModel.forInsert({
            data: data,
            userIdField: "createdBy",
            transaction: tx,
          }),
        )
        .returning();
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissionPolicyModel.createInitial({
        tx,
        organizationId: apiKey.organizationId,
        resource: "llmProviderApiKey",
        scope: apiKey.id,
        grants: options?.initialPermissionGrants,
        // A provider key names its owner in `user_id`, not `created_by`.
        authorId: apiKey.userId,
        visibility: apiKey.scope,
        teams: apiKey.teamId ? [{ id: apiKey.teamId }] : undefined,
      });
      // SPDX-SnippetEnd

      return apiKey;
    });
  }

  /**
   * Find an LLM provider API key by ID.
   */
  static async findById(id: string): Promise<LlmProviderApiKey | null> {
    const [apiKey] = await db
      .select()
      .from(schema.llmProviderApiKeysTable)
      .where(eq(schema.llmProviderApiKeysTable.id, id));

    return apiKey ?? null;
  }

  static async findByIds(ids: string[]): Promise<LlmProviderApiKey[]> {
    if (ids.length === 0) {
      return [];
    }

    return db
      .select()
      .from(schema.llmProviderApiKeysTable)
      .where(inArray(schema.llmProviderApiKeysTable.id, ids));
  }

  /**
   * Find a key by ID with its subscription metadata (`subscriptionKind`)
   * derived from the stored secret. Serves the
   * agent-pinned key a viewer can't otherwise list (`includeKeyId`): the
   * chat/agent preflight needs to know that the pinned credential is somebody's
   * personal subscription — and which one — to gate sending behind "connect
   * your own account" for every subscription kind, not just ChatGPT. Only
   * credential-level subscription providers' secrets are ever resolved, and
   * only the derived kind is returned — never the value.
   */
  static async findByIdWithSubscriptionInfo(id: string): Promise<
    | (LlmProviderApiKey & {
        subscriptionKind: SubscriptionCredentialKind | null;
      })
    | null
  > {
    const [row] = await db
      .select({
        apiKey: schema.llmProviderApiKeysTable,
        secret: schema.secretsTable.secret,
        secretIsVault: schema.secretsTable.isVault,
        secretIsByosVault: schema.secretsTable.isByosVault,
      })
      .from(schema.llmProviderApiKeysTable)
      .leftJoin(
        schema.secretsTable,
        eq(schema.llmProviderApiKeysTable.secretId, schema.secretsTable.id),
      )
      .where(eq(schema.llmProviderApiKeysTable.id, id));

    if (!row) {
      return null;
    }

    const subscriptionKind = await subscriptionKindFromStoredSecret({
      provider: row.apiKey.provider,
      secretId: row.apiKey.secretId,
      secret: row.secret,
      secretIsVault: row.secretIsVault,
      secretIsByosVault: row.secretIsByosVault,
    });

    return {
      ...row.apiKey,
      subscriptionKind,
    };
  }

  /**
   * Find all LLM provider API keys for an organization.
   */
  static async findByOrganizationId(
    organizationId: string,
  ): Promise<LlmProviderApiKey[]> {
    const apiKeys = await db
      .select()
      .from(schema.llmProviderApiKeysTable)
      .where(eq(schema.llmProviderApiKeysTable.organizationId, organizationId))
      .orderBy(schema.llmProviderApiKeysTable.createdAt);

    return apiKeys;
  }

  /**
   * Get visible LLM provider API keys for a user based on scope access.
   *
   * Visibility rules:
   * - Users see: their personal keys + team keys for their teams + org-wide keys
   * - Users with agent:admin: see all keys EXCEPT personal keys of other users
   */
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  static async getVisibleKeys(
    organizationId: string,
    userId: string,
    /** No longer consulted: grants decide, and they resolve teams in SQL. */
    _userTeamIds: string[],
    /** No longer consulted: an administrator's reach is its `*` grant. */
    _isAgentAdmin: boolean,
    filters?: {
      search?: string;
      provider?: SupportedProvider;
      ids?: string[];
      labels?: Record<string, string[]>;
    },
    options?: { includeSubscriptionInfo?: boolean },
  ): Promise<LlmProviderApiKeyWithScopeInfo[]> {
    // Build conditions based on visibility rules
    const conditions = [
      eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
    ];

    conditions.push(
      LlmProviderApiKeyModel.accessCondition({
        organizationId,
        userId,
        action: "read",
      }),
    );

    if (filters?.search) {
      conditions.push(
        ilike(
          schema.llmProviderApiKeysTable.name,
          `%${escapeLikePattern(filters.search.trim())}%`,
        ),
      );
    }

    if (filters?.provider) {
      conditions.push(
        eq(schema.llmProviderApiKeysTable.provider, filters.provider),
      );
    }

    if (filters?.ids) {
      if (filters.ids.length === 0) return [];
      conditions.push(inArray(schema.llmProviderApiKeysTable.id, filters.ids));
    }

    if (filters?.labels) {
      const labelFilteredIds =
        await LlmProviderApiKeyLabelModel.getIdsMatchingLabels(filters.labels);
      if (labelFilteredIds.length === 0) return [];
      conditions.push(
        inArray(schema.llmProviderApiKeysTable.id, labelFilteredIds),
      );
    }

    // Query with team, user, and secrets table joins.
    // NOTE: secretsTable.secret is encrypted at rest — decrypt via
    // decryptApiKeyValue() before reading the value.
    const apiKeys = await db
      .select({
        id: schema.llmProviderApiKeysTable.id,
        organizationId: schema.llmProviderApiKeysTable.organizationId,
        name: schema.llmProviderApiKeysTable.name,
        provider: schema.llmProviderApiKeysTable.provider,
        secretId: schema.llmProviderApiKeysTable.secretId,
        baseUrl: schema.llmProviderApiKeysTable.baseUrl,
        inferenceBaseUrl: schema.llmProviderApiKeysTable.inferenceBaseUrl,
        extraHeaders: schema.llmProviderApiKeysTable.extraHeaders,
        scope: schema.llmProviderApiKeysTable.scope,
        userId: schema.llmProviderApiKeysTable.userId,
        teamId: schema.llmProviderApiKeysTable.teamId,
        createdBy: schema.llmProviderApiKeysTable.createdBy,
        createdByServiceAccountId:
          schema.llmProviderApiKeysTable.createdByServiceAccountId,
        isSystem: schema.llmProviderApiKeysTable.isSystem,
        isPrimary: schema.llmProviderApiKeysTable.isPrimary,
        requiresReauthentication:
          schema.llmProviderApiKeysTable.requiresReauthentication,
        createdAt: schema.llmProviderApiKeysTable.createdAt,
        updatedAt: schema.llmProviderApiKeysTable.updatedAt,
        teamName: schema.teamsTable.name,
        userName: schema.usersTable.name,
        secret: schema.secretsTable.secret,
        secretIsVault: schema.secretsTable.isVault,
        secretIsByosVault: schema.secretsTable.isByosVault,
      })
      .from(schema.llmProviderApiKeysTable)
      .leftJoin(
        schema.teamsTable,
        eq(schema.llmProviderApiKeysTable.teamId, schema.teamsTable.id),
      )
      .leftJoin(
        schema.usersTable,
        eq(schema.llmProviderApiKeysTable.userId, schema.usersTable.id),
      )
      .leftJoin(
        schema.secretsTable,
        eq(schema.llmProviderApiKeysTable.secretId, schema.secretsTable.id),
      )
      .where(and(...conditions))
      .orderBy(schema.llmProviderApiKeysTable.createdAt);

    const accessibleKeys = (
      await Promise.all(
        apiKeys.map(async (key) => {
          if (key.userId === userId) return key;
          const apiKey =
            key.secretId && (key.secretIsVault || key.secretIsByosVault)
              ? await getSecretValueForLlmProviderApiKey(key.secretId)
              : decryptApiKeyValue(key.secret);
          return credentialRequiresPerUserScope({
            provider: key.provider,
            apiKey,
          })
            ? null
            : key;
        }),
      )
    ).filter((key) => key !== null);
    const labelsByKey = await LlmProviderApiKeyLabelModel.getLabelsForMany(
      accessibleKeys.map((key) => key.id),
    );

    return CreatedByModel.attach(
      await Promise.all(
        accessibleKeys.map(async (key) => ({
          ...(await toApiKeyWithScopeInfo(
            key,
            options?.includeSubscriptionInfo === true,
          )),
          labels: labelsByKey.get(key.id) ?? [],
        })),
      ),
      (key) => key.createdBy,
    );
  }
  // SPDX-SnippetEnd

  /**
   * Get available LLM provider API keys for a user to use across product features.
   * Only returns keys the user has access to.
   */
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  static async getAvailableKeysForUser(
    organizationId: string,
    userId: string,
    /** No longer consulted: grants decide, and they resolve teams in SQL. */
    _userTeamIds: string[],
    provider?: SupportedProvider,
    options?: { includeSubscriptionInfo?: boolean },
  ): Promise<LlmProviderApiKeyWithScopeInfo[]> {
    // Build conditions
    const conditions = [
      eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
    ];

    conditions.push(
      LlmProviderApiKeyModel.accessCondition({
        organizationId,
        userId,
        action: "use",
      }),
    );

    // Filter by provider if specified
    if (provider) {
      conditions.push(eq(schema.llmProviderApiKeysTable.provider, provider));
    }

    // Only return keys with configured secrets, system keys, or providers with optional API keys
    const secretOrSystemCondition = or(
      sql`${schema.llmProviderApiKeysTable.secretId} IS NOT NULL`,
      eq(schema.llmProviderApiKeysTable.isSystem, true),
      inArray(
        schema.llmProviderApiKeysTable.provider,
        getConfiguredProvidersWithOptionalApiKey(),
      ),
    );
    if (secretOrSystemCondition) {
      conditions.push(secretOrSystemCondition);
    }

    // Query with team, user, and secrets table joins.
    // NOTE: secretsTable.secret is encrypted at rest — decrypt via
    // decryptApiKeyValue() before reading the value.
    const apiKeys = await db
      .select({
        id: schema.llmProviderApiKeysTable.id,
        organizationId: schema.llmProviderApiKeysTable.organizationId,
        name: schema.llmProviderApiKeysTable.name,
        provider: schema.llmProviderApiKeysTable.provider,
        secretId: schema.llmProviderApiKeysTable.secretId,
        baseUrl: schema.llmProviderApiKeysTable.baseUrl,
        inferenceBaseUrl: schema.llmProviderApiKeysTable.inferenceBaseUrl,
        extraHeaders: schema.llmProviderApiKeysTable.extraHeaders,
        scope: schema.llmProviderApiKeysTable.scope,
        userId: schema.llmProviderApiKeysTable.userId,
        teamId: schema.llmProviderApiKeysTable.teamId,
        createdBy: schema.llmProviderApiKeysTable.createdBy,
        createdByServiceAccountId:
          schema.llmProviderApiKeysTable.createdByServiceAccountId,
        isSystem: schema.llmProviderApiKeysTable.isSystem,
        isPrimary: schema.llmProviderApiKeysTable.isPrimary,
        requiresReauthentication:
          schema.llmProviderApiKeysTable.requiresReauthentication,
        createdAt: schema.llmProviderApiKeysTable.createdAt,
        updatedAt: schema.llmProviderApiKeysTable.updatedAt,
        teamName: schema.teamsTable.name,
        userName: schema.usersTable.name,
        secret: schema.secretsTable.secret,
        secretIsVault: schema.secretsTable.isVault,
        secretIsByosVault: schema.secretsTable.isByosVault,
      })
      .from(schema.llmProviderApiKeysTable)
      .leftJoin(
        schema.teamsTable,
        eq(schema.llmProviderApiKeysTable.teamId, schema.teamsTable.id),
      )
      .leftJoin(
        schema.usersTable,
        eq(schema.llmProviderApiKeysTable.userId, schema.usersTable.id),
      )
      .leftJoin(
        schema.secretsTable,
        eq(schema.llmProviderApiKeysTable.secretId, schema.secretsTable.id),
      )
      .where(and(...conditions))
      .orderBy(schema.llmProviderApiKeysTable.createdAt);

    const accessibleKeys = (
      await Promise.all(
        apiKeys.map(async (key) => {
          if (key.userId === userId) return key;
          const apiKey =
            key.secretId && (key.secretIsVault || key.secretIsByosVault)
              ? await getSecretValueForLlmProviderApiKey(key.secretId)
              : decryptApiKeyValue(key.secret);
          return credentialRequiresPerUserScope({
            provider: key.provider,
            apiKey,
          })
            ? null
            : key;
        }),
      )
    ).filter((key) => key !== null);
    const labelsByKey = await LlmProviderApiKeyLabelModel.getLabelsForMany(
      accessibleKeys.map((key) => key.id),
    );

    return CreatedByModel.attach(
      await Promise.all(
        accessibleKeys.map(async (key) => ({
          ...(await toApiKeyWithScopeInfo(
            key,
            options?.includeSubscriptionInfo === true,
          )),
          labels: labelsByKey.get(key.id) ?? [],
        })),
      ),
      (key) => key.createdBy,
    );
  }
  // SPDX-SnippetEnd

  /**
   * Resolve API key with priority:
   * 1. Conversation-specific key (if matches agentLlmApiKeyId, skip user access check)
   * 2. Agent's configured key (if agentLlmApiKeyId provided, use directly without user permission check)
   * 3. Personal key
   * 4. Team key
   * 5. Org-wide key
   *
   * Key principle: If an admin configured an API key on the agent, any user with access
   * to that agent can use the key. Permission flows through agent access, not direct API key access.
   */
  static async getCurrentApiKey({
    organizationId,
    userId,
    userTeamIds,
    provider,
    conversationId,
    agentLlmApiKeyId,
  }: {
    organizationId: string;
    userId: string;
    userTeamIds: string[];
    provider: SupportedProvider;
    conversationId: string | null;
    agentLlmApiKeyId?: string | null;
  }): Promise<LlmProviderApiKey | null> {
    // Per-user providers (e.g. GitHub Copilot) hold an individual's token, so
    // resolution MUST use only the acting user's personal key — never an agent's
    // attached key, a conversation key, or a team/org key, all of which would let
    // one user ride on another's token. Returns null (→ "link your account"
    // prompt) when the user has no personal key of their own.
    if (providerRequiresPerUserCredential(provider)) {
      return LlmProviderApiKeyModel.findPersonalKey({
        organizationId,
        userId,
        provider,
      });
    }

    const conversation = conversationId
      ? await ConversationModel.findById({
          id: conversationId,
          userId,
          organizationId,
        })
      : null;

    // 1. If conversation has an explicit API key set, use it
    if (conversation?.chatApiKeyId) {
      const conversationKey = await LlmProviderApiKeyModel.findById(
        conversation.chatApiKeyId,
      );
      if (
        conversationKey &&
        conversationKey.provider === provider &&
        canUseProviderApiKey(conversationKey)
      ) {
        // If conversation's key matches agent's configured key, skip user access check
        if (
          agentLlmApiKeyId &&
          conversation.chatApiKeyId === agentLlmApiKeyId
        ) {
          return conversationKey;
        }
        // Otherwise, check user access
        if (
          await LlmProviderApiKeyModel.canUseKey(
            conversationKey,
            userId,
            userTeamIds,
          )
        ) {
          return conversationKey;
        }
      }
    }

    // 2. If agent has a configured API key and it matches the provider, use it directly
    //    (no user permission check — permission flows through agent access)
    if (agentLlmApiKeyId) {
      const agentKey = await LlmProviderApiKeyModel.findById(agentLlmApiKeyId);
      if (
        agentKey &&
        agentKey.provider === provider &&
        canUseProviderApiKey(agentKey)
      ) {
        return agentKey;
      }
    }

    const available = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      organizationId,
      userId,
      userTeamIds,
      provider,
    );
    const rank = await LlmProviderApiKeyModel.ownershipRanks({
      organizationId,
      userId,
      keys: available,
    });
    available.sort(
      (a, b) =>
        (rank.get(a.id) ?? 2) - (rank.get(b.id) ?? 2) ||
        Number(b.isPrimary) - Number(a.isPrimary) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
    return available[0]
      ? LlmProviderApiKeyModel.findById(available[0].id)
      : null;
  }

  /**
   * The key whose endpoint actually serves `modelDbId`, for providers where a
   * key IS a server (`providerHasEndpointLocalModels`).
   *
   * `getCurrentApiKey` ranks keys by ownership — conversation pin, agent pin,
   * personal, team, org — which is the right order for a credential but says
   * nothing about which server hosts a given model. With several self-hosted
   * endpoints registered under one provider (the normal way to host more than
   * one model, since `vllm serve` runs one model per process), that ranking
   * routes every model to whichever key happened to win, and the sibling
   * server answers "the model does not exist". This picks among the keys that
   * do serve the model, applying the same ownership order within that set.
   *
   * Only keys the caller may already use are considered — a model link is not
   * an access grant. `agentLlmApiKeyId` is admitted for the same reason
   * `getCurrentApiKey` admits it: permission flows through agent access.
   * Returns null when no such key exists, leaving the caller's own resolution
   * in place.
   */
  static async findKeyServingModel({
    organizationId,
    userId,
    userTeamIds,
    provider,
    modelDbId,
    agentLlmApiKeyId,
  }: {
    organizationId: string;
    userId?: string;
    userTeamIds: string[];
    provider: SupportedProvider;
    modelDbId: string;
    agentLlmApiKeyId?: string | null;
  }): Promise<LlmProviderApiKey | null> {
    const candidates = await db
      .select({ apiKey: schema.llmProviderApiKeysTable })
      .from(schema.llmProviderApiKeyModelsTable)
      .innerJoin(
        schema.llmProviderApiKeysTable,
        eq(
          schema.llmProviderApiKeyModelsTable.apiKeyId,
          schema.llmProviderApiKeysTable.id,
        ),
      )
      .where(
        and(
          eq(schema.llmProviderApiKeyModelsTable.modelId, modelDbId),
          eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
          eq(schema.llmProviderApiKeysTable.provider, provider),
          or(
            sql`${schema.llmProviderApiKeysTable.secretId} IS NOT NULL`,
            inArray(
              schema.llmProviderApiKeysTable.provider,
              getConfiguredProvidersWithOptionalApiKey(),
            ),
          ),
        ),
      )
      .orderBy(
        desc(schema.llmProviderApiKeysTable.isPrimary),
        asc(schema.llmProviderApiKeysTable.createdAt),
      );

    // Without an acting user there is no personal or team membership to read,
    // so only a key published to the organization at large is reachable.
    const usable = (
      await Promise.all(
        candidates.map(async ({ apiKey }) =>
          (agentLlmApiKeyId != null && apiKey.id === agentLlmApiKeyId) ||
          (userId === undefined
            ? await ResourcePermissionPolicyModel.sharedCredentialHasAccess({
                organizationId,
                resource: "llmProviderApiKey",
                scope: apiKey.id,
                teamId: null,
                action: "use",
              })
            : await LlmProviderApiKeyModel.canUseKey(
                apiKey,
                userId,
                userTeamIds,
              ))
            ? apiKey
            : null,
        ),
      )
    ).filter((key) => key !== null);

    const rank = await LlmProviderApiKeyModel.ownershipRanks({
      organizationId,
      userId,
      keys: usable,
    });
    return (
      usable.sort((a, b) => (rank.get(a.id) ?? 2) - (rank.get(b.id) ?? 2))[0] ??
      null
    );
  }

  /**
   * The acting user's own personal key for a given subscription, together with
   * its decrypted credential (prefer isPrimary, then oldest). Subscription
   * credentials are per-user, so when resolution lands on someone else's
   * subscription key (e.g. attached to a shared agent) the acting user's own
   * subscription is substituted — this is that lookup. The marker lives inside
   * the resolved secret, so the user's personal keys for the subscription's
   * provider are read here (the value is only handed to the
   * credential-resolution caller).
   */
  static async findPersonalSubscriptionKey({
    organizationId,
    userId,
    kind,
  }: {
    organizationId: string;
    userId: string;
    kind: SubscriptionCredentialKind;
  }): Promise<{ apiKey: LlmProviderApiKey; apiKeyValue: string } | null> {
    const candidates = await db
      .select({
        apiKey: schema.llmProviderApiKeysTable,
      })
      .from(schema.llmProviderApiKeysTable)
      .innerJoin(
        schema.secretsTable,
        eq(schema.llmProviderApiKeysTable.secretId, schema.secretsTable.id),
      )
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
          eq(
            schema.llmProviderApiKeysTable.provider,
            SUBSCRIPTION_CREDENTIALS[kind].provider,
          ),
          // The owner column, not the retired scope, says whose key it is.
          eq(schema.llmProviderApiKeysTable.userId, userId),
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          LlmProviderApiKeyModel.accessCondition({
            organizationId,
            userId,
            action: "use",
          }),
          // SPDX-SnippetEnd
        ),
      )
      .orderBy(
        sql`${schema.llmProviderApiKeysTable.isPrimary} DESC`,
        schema.llmProviderApiKeysTable.createdAt,
      );

    for (const candidate of candidates) {
      let apiKeyValue: string | undefined;
      try {
        apiKeyValue = candidate.apiKey.secretId
          ? await getSecretValueForLlmProviderApiKey(candidate.apiKey.secretId)
          : undefined;
      } catch (error) {
        // A stale/inaccessible Vault reference must not prevent a later valid
        // personal credential from satisfying the shared-agent substitution.
        // Listing metadata follows the same fail-soft rule.
        logger.warn(
          { error, secretId: candidate.apiKey.secretId },
          "Failed to resolve personal subscription candidate; trying the next credential",
        );
        continue;
      }
      if (
        apiKeyValue !== undefined &&
        subscriptionKindFromCredential(apiKeyValue) === kind
      ) {
        return { apiKey: candidate.apiKey, apiKeyValue };
      }
    }

    return null;
  }

  /**
   * The acting user's own personal key for a provider (prefer isPrimary, then
   * oldest). Self-contained so the per-user-credential guard can call it before
   * the rest of getCurrentApiKey runs.
   */
  /**
   * Resolution order among keys a caller may use: their own key first, then
   * a key their team was granted, then anything else. "Own" is the key's
   * owner column. "Team" is the key's own grants reaching a team, the same
   * label the retired scope column used to carry.
   */
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  private static async ownershipRanks(params: {
    organizationId: string;
    userId: string | undefined;
    keys: Array<{ id: string; userId: string | null }>;
  }): Promise<Map<string, number>> {
    const audiences = await ResourcePermissionPolicyModel.findAudiences({
      organizationId: params.organizationId,
      resource: "llmProviderApiKey",
      scopes: params.keys.map((key) => key.id),
    });
    return new Map(
      params.keys.map((key) => [
        key.id,
        params.userId !== undefined && key.userId === params.userId
          ? 0
          : audiences.get(key.id)?.audience === "team"
            ? 1
            : 2,
      ]),
    );
  }
  // SPDX-SnippetEnd

  /** Grants alone decide who reads or uses a key. */
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  private static accessCondition(params: {
    organizationId: string;
    userId: string;
    action: "read" | "use";
  }) {
    return ResourcePermissionPolicyModel.grantCondition({
      ...params,
      resource: "llmProviderApiKey",
      scopeColumn: schema.llmProviderApiKeysTable.id,
    });
  }
  // SPDX-SnippetEnd

  private static async findPersonalKey({
    organizationId,
    userId,
    provider,
  }: {
    organizationId: string;
    userId: string;
    provider: SupportedProvider;
  }): Promise<LlmProviderApiKey | null> {
    const hasSecretOrOptional = or(
      sql`${schema.llmProviderApiKeysTable.secretId} IS NOT NULL`,
      inArray(
        schema.llmProviderApiKeysTable.provider,
        getConfiguredProvidersWithOptionalApiKey(),
      ),
    );

    const [personalKey] = await db
      .select()
      .from(schema.llmProviderApiKeysTable)
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
          eq(schema.llmProviderApiKeysTable.provider, provider),
          // The owner column, not the retired scope, says whose key it is.
          eq(schema.llmProviderApiKeysTable.userId, userId),
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          LlmProviderApiKeyModel.accessCondition({
            organizationId,
            userId,
            action: "use",
          }),
          // SPDX-SnippetEnd
          hasSecretOrOptional,
        ),
      )
      .orderBy(
        sql`${schema.llmProviderApiKeysTable.isPrimary} DESC`,
        schema.llmProviderApiKeysTable.createdAt,
      )
      .limit(1);

    return personalKey ?? null;
  }

  /**
   * Check if a user has access to a specific LLM provider API key based on scope.
   */

  /**
   * The key for `provider` that the organization at large may use, for
   * resolution with no acting user: a use grant to everyone, or the role
   * grants the conversion wrote for an organization-wide key. Primary first,
   * then oldest.
   */
  static async findOrganizationWideKey(
    organizationId: string,
    provider: SupportedProvider,
  ): Promise<LlmProviderApiKey | null> {
    const [apiKey] = await db
      .select()
      .from(schema.llmProviderApiKeysTable)
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
          eq(schema.llmProviderApiKeysTable.provider, provider),
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          ResourcePermissionPolicyModel.organizationAccessCondition({
            organizationId,
            resource: "llmProviderApiKey",
            scopeColumn: schema.llmProviderApiKeysTable.id,
            action: "use",
          }),
          // SPDX-SnippetEnd
        ),
      )
      .orderBy(
        desc(schema.llmProviderApiKeysTable.isPrimary),
        asc(schema.llmProviderApiKeysTable.createdAt),
      )
      .limit(1);

    return apiKey ?? null;
  }

  /**
   * Store validation status without letting an older request overwrite a reconnect.
   */
  static async setRequiresReauthentication(params: {
    id: string;
    requiresReauthentication: boolean;
    expectedUpdatedAt?: Date;
  }): Promise<void> {
    await db
      .update(schema.llmProviderApiKeysTable)
      .set({
        requiresReauthentication: params.requiresReauthentication,
        updatedAt: params.expectedUpdatedAt ?? new Date(),
      })
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.id, params.id),
          params.expectedUpdatedAt
            ? sql`date_trunc('milliseconds', ${schema.llmProviderApiKeysTable.updatedAt}) = ${params.expectedUpdatedAt}`
            : undefined,
        ),
      );
  }

  static async update(
    id: string,
    data: UpdateLlmProviderApiKey,
  ): Promise<LlmProviderApiKey | null> {
    return await db.transaction(async (tx) => {
      // Promoting a key to primary demotes the current primary in its
      // (post-update) partition — see create() for the exclusivity rules.
      if (data.isPrimary) {
        const [existing] = await tx
          .select()
          .from(schema.llmProviderApiKeysTable)
          .where(eq(schema.llmProviderApiKeysTable.id, id));
        if (existing) {
          await demoteCurrentPrimary(tx, {
            organizationId: existing.organizationId,
            provider: existing.provider as SupportedProvider,
            scope: (data.scope ?? existing.scope) as ResourceVisibilityScope,
            userId: data.userId !== undefined ? data.userId : existing.userId,
            teamId: data.teamId !== undefined ? data.teamId : existing.teamId,
            excludeId: id,
          });
        }
      }

      const [updated] = await tx
        .update(schema.llmProviderApiKeysTable)
        .set(data)
        .where(eq(schema.llmProviderApiKeysTable.id, id))
        .returning();

      return updated ?? null;
    });
  }

  /**
   * Delete an LLM provider API key.
   */
  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.llmProviderApiKeysTable)
      .where(eq(schema.llmProviderApiKeysTable.id, id))
      .returning({ id: schema.llmProviderApiKeysTable.id });

    return result.length > 0;
  }

  /**
   * Check if any LLM provider API key exists for an organization.
   */
  static async hasAnyApiKey(organizationId: string): Promise<boolean> {
    const [result] = await db
      .select({ id: schema.llmProviderApiKeysTable.id })
      .from(schema.llmProviderApiKeysTable)
      .where(eq(schema.llmProviderApiKeysTable.organizationId, organizationId))
      .limit(1);

    return !!result;
  }

  /**
   * Check if an LLM provider API key exists with a configured secret for an organization and provider.
   */
  static async hasConfiguredApiKey(
    organizationId: string,
    provider: SupportedProvider,
  ): Promise<boolean> {
    const [result] = await db
      .select({ id: schema.llmProviderApiKeysTable.id })
      .from(schema.llmProviderApiKeysTable)
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
          eq(schema.llmProviderApiKeysTable.provider, provider),
          sql`${schema.llmProviderApiKeysTable.secretId} IS NOT NULL`,
        ),
      )
      .limit(1);

    return !!result;
  }

  // =========================================================================
  // System LLM Provider API Key Methods
  // =========================================================================

  /**
   * Find the system API key for a provider.
   * System keys are global (one per provider).
   */
  static async findSystemKey(
    provider: SupportedProvider,
  ): Promise<LlmProviderApiKey | null> {
    const [result] = await db
      .select()
      .from(schema.llmProviderApiKeysTable)
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.provider, provider),
          eq(schema.llmProviderApiKeysTable.isSystem, true),
        ),
      )
      .limit(1);

    return result ?? null;
  }

  /**
   * Create a system LLM provider API key for a keyless provider.
   * System keys don't require a secret (credentials from environment/ADC).
   */
  static async createSystemKey(params: {
    organizationId: string;
    name: string;
    provider: SupportedProvider;
  }): Promise<LlmProviderApiKey> {
    const [apiKey] = await db
      .insert(schema.llmProviderApiKeysTable)
      .values(
        await CreatedByModel.forInsert({
          data: {
            organizationId: params.organizationId,
            name: params.name,
            provider: params.provider,
            scope: "org",
            isSystem: true,
            secretId: null,
            userId: null,
            teamId: null,
          },
          userIdField: "createdBy",
        }),
      )
      .returning();

    return apiKey;
  }

  /**
   * Delete the system LLM provider API key for a provider.
   * Also deletes associated model links via cascade.
   */
  static async deleteSystemKey(provider: SupportedProvider): Promise<void> {
    await db
      .delete(schema.llmProviderApiKeysTable)
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.provider, provider),
          eq(schema.llmProviderApiKeysTable.isSystem, true),
        ),
      );
  }

  /**
   * Get all system LLM provider API keys.
   */
  static async findAllSystemKeys(): Promise<LlmProviderApiKey[]> {
    return db
      .select()
      .from(schema.llmProviderApiKeysTable)
      .where(eq(schema.llmProviderApiKeysTable.isSystem, true));
  }

  /**
   * Get the set of distinct providers that have at least one LLM provider API key configured.
   * Used to determine which providers are "configured" for model filtering,
   * independent of whether model sync has linked models to those keys.
   */
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select()
      .from(schema.llmProviderApiKeysTable)
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.id, id),
          eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!row) return null;

    // REDACTED: secretId and any resolved key material are never included.
    // extraHeaders values may carry tokens, so capture header NAMES only.
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      organizationId: row.organizationId,
      scope: row.scope,
      teamId: row.teamId ?? null,
      isPrimary: row.isPrimary,
      requiresReauthentication: row.requiresReauthentication,
      baseUrl: row.baseUrl ?? null,
      inferenceBaseUrl: row.inferenceBaseUrl ?? null,
      extraHeaderNames: row.extraHeaders
        ? Object.keys(row.extraHeaders).sort()
        : [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  static async getConfiguredProviders(): Promise<Set<string>> {
    const rows = await db
      .selectDistinct({ provider: schema.llmProviderApiKeysTable.provider })
      .from(schema.llmProviderApiKeysTable);
    return new Set(rows.map((r) => r.provider));
  }
}

/**
 * Maps a list-query row (key + joined secret columns) to the response shape,
 * deriving the secret-value metadata (vault reference, subscription marker)
 * and dropping the secret columns.
 *
 * The secret is decrypted only when its value is actually inspected: BYOS-vault
 * secrets carry the "path#key" reference to surface (the BYOS manager is the
 * only writer of vault references, and it always sets `isByosVault`), and
 * credential-level providers may carry a subscription marker. Vault-backed
 * values are resolved only for explicitly enriched response surfaces and only
 * for those providers; the value never leaves this mapper either way.
 */
async function toApiKeyWithScopeInfo<
  T extends {
    provider: string;
    secretId: string | null;
    secret: SecretValue | null;
    secretIsVault: boolean | null;
    secretIsByosVault: boolean | null;
  },
>(
  key: T,
  includeSubscriptionInfo: boolean,
): Promise<
  Omit<T, "secret" | "secretIsVault" | "secretIsByosVault"> & {
    vaultSecretPath: string | null;
    vaultSecretKey: string | null;
    secretStorageType: SecretStorageType;
    subscriptionKind: SubscriptionCredentialKind | null;
  }
> {
  const storedApiKeyValue =
    isCredentialLevelSubscriptionProvider(key.provider) || key.secretIsByosVault
      ? decryptApiKeyValue(key.secret)
      : null;
  const vaultRef = parseVaultReferenceFromApiKey(storedApiKeyValue);
  const subscriptionKind = includeSubscriptionInfo
    ? await subscriptionKindFromStoredSecret({
        provider: key.provider,
        secretId: key.secretId,
        secret: key.secret,
        secretIsVault: key.secretIsVault,
        secretIsByosVault: key.secretIsByosVault,
      })
    : null;
  const { secret: _secret, secretIsVault, secretIsByosVault, ...rest } = key;
  return {
    ...rest,
    vaultSecretPath: vaultRef?.vaultSecretPath ?? null,
    vaultSecretKey: vaultRef?.vaultSecretKey ?? null,
    secretStorageType: computeSecretStorageType(
      key.secretId,
      secretIsVault,
      secretIsByosVault,
    ),
    subscriptionKind,
  };
}

/** Resolve Vault-backed values only for providers whose credential kind needs it. */
async function subscriptionKindFromStoredSecret(params: {
  provider: string;
  secretId: string | null;
  secret: SecretValue | null;
  secretIsVault: boolean | null;
  secretIsByosVault: boolean | null;
}): Promise<SubscriptionCredentialKind | null> {
  if (!isCredentialLevelSubscriptionProvider(params.provider)) {
    return null;
  }

  let apiKeyValue = decryptApiKeyValue(params.secret);
  if (
    params.secretId &&
    (params.secretIsVault === true || params.secretIsByosVault === true)
  ) {
    try {
      apiKeyValue =
        (await getSecretValueForLlmProviderApiKey(params.secretId)) ?? null;
    } catch (error) {
      logger.warn(
        { error, secretId: params.secretId },
        "Failed to resolve Vault-backed LLM provider secret while deriving subscription metadata",
      );
      apiKeyValue = null;
    }
  }
  return subscriptionKindFromCredential(apiKeyValue);
}

/**
 * Decrypts a stored secret and returns its `apiKey` string (LLM provider key
 * secrets are `{ apiKey: "..." }`), or null when absent/non-string.
 * {@link toApiKeyWithScopeInfo} calls this at most once per key and derives
 * metadata from the returned value — the value itself is never included in a
 * response.
 *
 * Callers only use the value for optional metadata (vault reference,
 * ChatGPT-subscription marker), so an undecryptable secret — e.g. one
 * encrypted under a previous ARCHESTRA_AUTH_SECRET — degrades to null instead
 * of throwing; otherwise a single stale secret would break key listing for
 * everyone.
 */
function decryptApiKeyValue(secret: SecretValue | null): string | null {
  if (!secret || typeof secret !== "object") return null;
  let decrypted: SecretValue;
  if (isEncryptedSecret(secret)) {
    try {
      decrypted = decryptSecretValue(secret);
    } catch (error) {
      logger.warn(
        { error },
        "Failed to decrypt LLM provider API key secret while deriving key metadata; treating the value as unreadable",
      );
      return null;
    }
  } else {
    decrypted = secret;
  }
  const apiKeyValue = (decrypted as Record<string, unknown>).apiKey;
  return typeof apiKeyValue === "string" ? apiKeyValue : null;
}

/**
 * Helper to parse a vault reference from a decrypted apiKey value
 * ("path#key" format).
 */
function parseVaultReferenceFromApiKey(
  apiKeyValue: string | null,
): { vaultSecretPath: string; vaultSecretKey: string } | null {
  if (apiKeyValue && isVaultReference(apiKeyValue)) {
    const parsed = parseVaultReference(apiKeyValue);
    return {
      vaultSecretPath: parsed.path,
      vaultSecretKey: parsed.key,
    };
  }
  return null;
}

/**
 * Unset is_primary on the current primary key of the given partition, matching
 * the partial unique indexes (chat_api_keys_primary_{org,personal,team}_unique):
 * org scope is exclusive per (organization, provider); personal and team scopes
 * additionally key on the user / team.
 */
async function demoteCurrentPrimary(
  tx: Transaction,
  partition: {
    organizationId: string;
    provider: SupportedProvider;
    scope: ResourceVisibilityScope;
    userId: string | null;
    teamId: string | null;
    excludeId?: string;
  },
): Promise<void> {
  const conditions = [
    eq(schema.llmProviderApiKeysTable.organizationId, partition.organizationId),
    eq(schema.llmProviderApiKeysTable.provider, partition.provider),
    eq(schema.llmProviderApiKeysTable.scope, partition.scope),
    eq(schema.llmProviderApiKeysTable.isPrimary, true),
  ];
  if (partition.scope === "personal" && partition.userId) {
    conditions.push(
      eq(schema.llmProviderApiKeysTable.userId, partition.userId),
    );
  }
  if (partition.scope === "team" && partition.teamId) {
    conditions.push(
      eq(schema.llmProviderApiKeysTable.teamId, partition.teamId),
    );
  }
  if (partition.excludeId) {
    conditions.push(ne(schema.llmProviderApiKeysTable.id, partition.excludeId));
  }

  await tx
    .update(schema.llmProviderApiKeysTable)
    .set({ isPrimary: false })
    .where(and(...conditions));
}

function canUseProviderApiKey(
  apiKey: Pick<LlmProviderApiKey, "provider" | "secretId">,
): boolean {
  if (apiKey.secretId) {
    return true;
  }

  return getConfiguredProvidersWithOptionalApiKey().includes(apiKey.provider);
}

function getConfiguredProvidersWithOptionalApiKey(): SupportedProvider[] {
  const providers = getProvidersWithOptionalApiKey({
    azureEntraIdEnabled: isAzureOpenAiEntraIdEnabled(),
    anthropicKeylessAuthEnabled: isAnthropicKeylessAuthEnabled(),
  });
  if (config.llm.gemini.vertexAi.enabled) {
    providers.push("gemini");
  }
  if (config.llm.bedrock.iamAuthEnabled) {
    providers.push("bedrock");
  }
  return providers;
}

export default LlmProviderApiKeyModel;
