import {
  getProvidersWithOptionalApiKey,
  isCredentialLevelSubscriptionProvider,
  isVaultReference,
  PROVIDERS_REQUIRING_BASE_URL,
  parseVaultReference,
  providerHasEndpointLocalModels,
  providerRequiresPerUserCredential,
  type ResourcePermissionGrant,
  SUBSCRIPTION_CREDENTIALS,
  type SubscriptionCredentialKind,
  type SupportedProvider,
  subscriptionKindFromCredential,
} from "@archestra/shared";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { type CacheKeyPrefix, cacheManager } from "@/cache-manager";
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
  LlmProviderApiKeyForModelSync,
  LlmProviderApiKeyWithScopeInfo,
  LlmProviderCredentialKind,
  SecretStorageType,
  SecretValue,
  UpdateLlmProviderApiKey,
} from "@/types";
import type { ResourceVisibilityScope } from "@/types/visibility";
import { decryptSecretValue, isEncryptedSecret } from "@/utils/crypto";
import { escapeLikePattern } from "@/utils/sql-search";
import ConversationModel from "./conversation";
import CreatedByModel from "./created-by";
import { LlmProviderApiKeyLabelModel } from "./entity-labels";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import ResourcePermissionSubjectModel, {
  type ResourceAccessFilter,
} from "./resource-permission-subject";

class LlmProviderApiKeyModel {
  /** Shared primary candidates; credential eligibility is checked by the service. */
  static async findSharedPrimaryKeys(organizationId: string) {
    const rows = await db
      .select({ id: schema.llmProviderApiKeysTable.id })
      .from(schema.llmProviderApiKeysTable)
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
          isNull(schema.llmProviderApiKeysTable.userId),
          eq(schema.llmProviderApiKeysTable.isPrimary, true),
        ),
      )
      .orderBy(
        schema.llmProviderApiKeysTable.provider,
        schema.llmProviderApiKeysTable.id,
      );
    return LlmProviderApiKeyModel.findByIds(rows.map((row) => row.id));
  }

  /** Usable primaries, preserving endpoint-local catalogs and ownership precedence. */
  static async getUsablePrimaryKeys(params: {
    organizationId: string;
    userId: string;
    userTeamIds: string[];
  }): Promise<LlmProviderApiKeyWithScopeInfo[]> {
    const available = await LlmProviderApiKeyModel.withoutOrphans({
      organizationId: params.organizationId,
      keys: (
        await LlmProviderApiKeyModel.getAvailableKeysForUser(
          params.organizationId,
          params.userId,
          params.userTeamIds,
        )
      ).filter(
        (key) =>
          key.isPrimary &&
          !key.requiresReauthentication &&
          (!PROVIDERS_REQUIRING_BASE_URL.has(key.provider) ||
            Boolean(key.baseUrl)),
      ),
    });
    const ranks = await LlmProviderApiKeyModel.ownershipRanks({
      ...params,
      keys: available,
    });
    available.sort(
      (a, b) =>
        (ranks.get(a.id) ?? 2) - (ranks.get(b.id) ?? 2) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const seen = new Set<SupportedProvider>();
    return available.filter((key) => {
      if (providerHasEndpointLocalModels(key.provider)) return true;
      if (seen.has(key.provider)) return false;
      seen.add(key.provider);
      return true;
    });
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  static async canUseKey(
    apiKey: LlmProviderApiKey,
    userId: string,
    /** No longer consulted: grants decide, and they resolve teams in SQL. */
    _userTeamIds: string[],
  ): Promise<boolean> {
    if (
      apiKey.userId !== userId &&
      isPerUserCredential(
        apiKey.provider,
        await LlmProviderApiKeyModel.findCredentialKind(apiKey.id),
      )
    )
      return false;
    const [row] = await db
      .select({ id: schema.llmProviderApiKeysTable.id })
      .from(schema.llmProviderApiKeysTable)
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.id, apiKey.id),
          await LlmProviderApiKeyModel.accessCondition({
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
   * "Primary" is exclusive per (organization, provider, owner) for own keys
   * and per (organization, provider) for shared keys — enforced by partial
   * unique indexes. Creating a new primary demotes the
   * current one in the same transaction, so callers can mark a key primary
   * without first hunting down and unsetting the old one.
   */
  static async create(
    data: InsertLlmProviderApiKey,
    /** Who else can reach the key. Omitted, only its owner or creator. */
    options?: {
      initialPermissionGrants?: ResourcePermissionGrant[];
      /** Publish to the whole organization; for system callers only. */
      publishToOrganization?: boolean;
      /** The value being stored, to record its credential kind. */
      apiKeyValue?: string | null;
    },
  ): Promise<LlmProviderApiKey> {
    return await db.transaction(async (tx) => {
      if (data.isPrimary) {
        await demoteCurrentPrimary(tx, {
          organizationId: data.organizationId,
          provider: data.provider,
          userId: data.userId ?? null,
        });
      }

      const [apiKey] = await tx
        .insert(schema.llmProviderApiKeysTable)
        .values(
          await CreatedByModel.forInsert({
            data: {
              ...data,
              ...(options && "apiKeyValue" in options
                ? { credentialKind: credentialKindOf(options.apiKeyValue) }
                : {}),
            },
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
        // A key of its own belongs to its owner (`user_id`). A shared key has
        // no owner: its creator gets full access, like the author of every
        // other resource, and no one else unless the grants name them.
        authorId:
          apiKey.userId ?? CreatedByModel.id(apiKey, apiKey.createdBy) ?? null,
        publishToOrganization: options?.publishToOrganization,
      });
      // SPDX-SnippetEnd

      return apiKey;
    });
  }

  /**
   * Record what kind of credential a key now stores. Every route that writes a
   * key's value calls this with the value it wrote, so later reads never have
   * to resolve the secret to tell a subscription from an API key.
   */
  static async recordCredentialKind(params: {
    id: string;
    apiKeyValue: string | null | undefined;
  }): Promise<void> {
    await db
      .update(schema.llmProviderApiKeysTable)
      .set({ credentialKind: credentialKindOf(params.apiKeyValue) })
      .where(eq(schema.llmProviderApiKeysTable.id, params.id));
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

    const kinds = await resolveCredentialKinds([
      {
        id: row.apiKey.id,
        secretId: row.apiKey.secretId,
        secret: row.secret,
        secretIsVault: row.secretIsVault,
        secretIsByosVault: row.secretIsByosVault,
        credentialKind: row.apiKey.credentialKind,
      },
    ]);
    const { credentialKind: _credentialKind, ...apiKey } = row.apiKey;

    return {
      ...apiKey,
      subscriptionKind: subscriptionKindOf(
        apiKey.provider,
        kinds.get(apiKey.id),
      ),
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
      /** The list's `access`, `sharedWith`, and `owner` filters. */
      access?: ResourceAccessFilter;
    },
    options?: { includeSubscriptionInfo?: boolean },
  ): Promise<LlmProviderApiKeyWithScopeInfo[]> {
    // Build conditions based on visibility rules
    const conditions = [
      eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
    ];

    conditions.push(
      await LlmProviderApiKeyModel.accessCondition({
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

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const accessCondition =
      filters?.access &&
      ResourcePermissionPolicyModel.accessRelationCondition({
        ...filters.access,
        organizationId,
        resource: "llmProviderApiKey",
        scopeColumn: schema.llmProviderApiKeysTable.id,
        // An own key belongs to its user; a shared one to whoever added it.
        ownerColumn: sql`coalesce(${schema.llmProviderApiKeysTable.userId}, ${schema.llmProviderApiKeysTable.createdBy})`,
      });
    if (accessCondition) conditions.push(accessCondition);
    // SPDX-SnippetEnd

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
        credentialKind: schema.llmProviderApiKeysTable.credentialKind,
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

    // The kind is a column, so listing resolves no secrets; only rows written
    // before it existed are classified (once) here.
    const credentialKinds = await resolveCredentialKinds(apiKeys);
    const accessibleKeys = apiKeys.filter((key) =>
      isListedFor({
        key,
        kind: credentialKinds.get(key.id),
        userId,
      }),
    );
    const [labelsByKey, displayScopes] = await Promise.all([
      LlmProviderApiKeyLabelModel.getLabelsForMany(
        accessibleKeys.map((key) => key.id),
      ),
      LlmProviderApiKeyModel.findDisplayScopes({
        organizationId,
        keys: accessibleKeys,
      }),
    ]);

    return CreatedByModel.attach(
      await Promise.all(
        accessibleKeys.map(async (key) => ({
          ...toApiKeyWithScopeInfo(
            // `scope` from the owner column and grants, not the retired one.
            { ...key, scope: displayScopes.get(key.id) ?? key.scope },
            options?.includeSubscriptionInfo === true
              ? subscriptionKindOf(key.provider, credentialKinds.get(key.id))
              : null,
          ),
          labels: labelsByKey.get(key.id) ?? [],
        })),
      ),
      (key) => key.createdBy,
    );
  }

  /**
   * Ids of the keys {@link getVisibleKeys} returns, without loading what a
   * key list displays (labels, owners, scopes).
   */
  static async getVisibleKeyIds(
    organizationId: string,
    userId: string,
  ): Promise<string[]> {
    const keys = await db
      .select({
        id: schema.llmProviderApiKeysTable.id,
        provider: schema.llmProviderApiKeysTable.provider,
        userId: schema.llmProviderApiKeysTable.userId,
        createdBy: schema.llmProviderApiKeysTable.createdBy,
        credentialKind: schema.llmProviderApiKeysTable.credentialKind,
        secretId: schema.llmProviderApiKeysTable.secretId,
        secret: schema.secretsTable.secret,
        secretIsVault: schema.secretsTable.isVault,
        secretIsByosVault: schema.secretsTable.isByosVault,
      })
      .from(schema.llmProviderApiKeysTable)
      .leftJoin(
        schema.secretsTable,
        eq(schema.llmProviderApiKeysTable.secretId, schema.secretsTable.id),
      )
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
          await LlmProviderApiKeyModel.accessCondition({
            organizationId,
            userId,
            action: "read",
          }),
        ),
      );
    return (await withoutOthersPerUserCredentials(keys, userId)).map(
      (key) => key.id,
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
      await LlmProviderApiKeyModel.accessCondition({
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
        credentialKind: schema.llmProviderApiKeysTable.credentialKind,
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

    // The kind is a column, so listing resolves no secrets; only rows written
    // before it existed are classified (once) here.
    const credentialKinds = await resolveCredentialKinds(apiKeys);
    const accessibleKeys = apiKeys.filter((key) =>
      isListedFor({
        key,
        kind: credentialKinds.get(key.id),
        userId,
      }),
    );
    const [labelsByKey, displayScopes] = await Promise.all([
      LlmProviderApiKeyLabelModel.getLabelsForMany(
        accessibleKeys.map((key) => key.id),
      ),
      LlmProviderApiKeyModel.findDisplayScopes({
        organizationId,
        keys: accessibleKeys,
      }),
    ]);

    return CreatedByModel.attach(
      await Promise.all(
        accessibleKeys.map(async (key) => ({
          ...toApiKeyWithScopeInfo(
            // `scope` from the owner column and grants, not the retired one.
            { ...key, scope: displayScopes.get(key.id) ?? key.scope },
            options?.includeSubscriptionInfo === true
              ? subscriptionKindOf(key.provider, credentialKinds.get(key.id))
              : null,
          ),
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

    const available = await LlmProviderApiKeyModel.withoutOrphans({
      organizationId,
      keys: await LlmProviderApiKeyModel.getAvailableKeysForUser(
        organizationId,
        userId,
        userTeamIds,
        provider,
      ),
    });
    const rank = await LlmProviderApiKeyModel.ownershipRanks({
      organizationId,
      userId,
      userTeamIds,
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
      userTeamIds,
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
          await LlmProviderApiKeyModel.accessCondition({
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
   * The label the retired `scope` column carried, derived for display: a key
   * with an owner is `personal`. A shared key (no owner) is `team` when its
   * grants reach teams and not the organization, and `org` otherwise, the
   * partition shared keys live in. The chatops key label and API responses
   * read this.
   */
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  static async findDisplayScopes(params: {
    organizationId: string;
    keys: Array<{ id: string; userId: string | null }>;
  }): Promise<Map<string, ResourceVisibilityScope>> {
    const shared = params.keys.filter((key) => key.userId === null);
    const audiences = await ResourcePermissionPolicyModel.findAudiences({
      organizationId: params.organizationId,
      resource: "llmProviderApiKey",
      scopes: shared.map((key) => key.id),
    });
    return new Map(
      params.keys.map((key) => [
        key.id,
        key.userId !== null
          ? "personal"
          : audiences.get(key.id)?.audience === "team"
            ? "team"
            : "org",
      ]),
    );
  }
  // SPDX-SnippetEnd

  /**
   * Resolution order among keys a caller may use (decision: owner column
   * first, then team-granted, then organization): their own key first, then
   * a key whose grants reach one of the caller's teams (or reach teams only),
   * then anything else. "Own" is the key's owner column. A key shared with a
   * caller's team AND the organization still ranks as the team's key.
   */
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Drop the keys nobody was given: a personal key whose owner was deleted,
   * which the upgrade left without an owner and with a policy that grants no
   * one. An administrator reaches it through their authority over every key,
   * to manage it, but it is nobody's to pick as a default credential. A shared
   * key created without grants is not an orphan: it is for administrators.
   */
  private static async findCredentialKind(
    id: string,
  ): Promise<LlmProviderCredentialKind | null> {
    const [row] = await db
      .select({
        id: schema.llmProviderApiKeysTable.id,
        secretId: schema.llmProviderApiKeysTable.secretId,
        credentialKind: schema.llmProviderApiKeysTable.credentialKind,
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
    if (!row) return null;
    return (await resolveCredentialKinds([row])).get(id) ?? null;
  }

  private static async withoutOrphans<
    T extends { id: string; userId: string | null },
  >(params: { organizationId: string; keys: T[] }): Promise<T[]> {
    const ownerlessIds = params.keys
      .filter((key) => key.userId === null)
      .map((key) => key.id);
    if (ownerlessIds.length === 0) return params.keys;
    // The retired scope column still says which keys were personal. Callers
    // pass a display scope derived from grants, so read the stored one.
    const formerlyPersonal = await db
      .select({ id: schema.llmProviderApiKeysTable.id })
      .from(schema.llmProviderApiKeysTable)
      .where(
        and(
          inArray(schema.llmProviderApiKeysTable.id, ownerlessIds),
          eq(schema.llmProviderApiKeysTable.scope, "personal"),
        ),
      );
    if (formerlyPersonal.length === 0) return params.keys;
    const policies = await ResourcePermissionPolicyModel.findApplicableBatch({
      organizationId: params.organizationId,
      resource: "llmProviderApiKey",
      scopes: formerlyPersonal.map((key) => key.id),
    });
    const granted = new Set(
      policies
        .filter((policy) => policy.scope !== "*" && policy.grants.length > 0)
        .map((policy) => policy.scope),
    );
    const orphans = new Set(
      formerlyPersonal.map((key) => key.id).filter((id) => !granted.has(id)),
    );
    return params.keys.filter((key) => !orphans.has(key.id));
  }

  private static async ownershipRanks(params: {
    organizationId: string;
    userId: string | undefined;
    userTeamIds: string[];
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
          : // A team key ranks as the caller's own team key only when the
            // caller is in one of its teams. An admin reaches every team key
            // through `*`, and must not prefer it over the organization key.
            (audiences.get(key.id)?.teamIds ?? []).some((teamId) =>
                params.userTeamIds.includes(teamId),
              )
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
  private static async accessCondition(params: {
    organizationId: string;
    userId: string;
    action: "read" | "use";
  }) {
    const principal =
      await ResourcePermissionSubjectModel.resolvePrincipal(params);
    // A key with an owner is that person's own key: no grant, not even `*`,
    // reaches it for anyone else.
    return and(
      or(
        isNull(schema.llmProviderApiKeysTable.userId),
        eq(schema.llmProviderApiKeysTable.userId, params.userId),
      ),
      ResourcePermissionPolicyModel.grantCondition({
        ...principal,
        action: params.action,
        resource: "llmProviderApiKey",
        scopeColumn: schema.llmProviderApiKeysTable.id,
      }),
    ) as SQL;
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
          await LlmProviderApiKeyModel.accessCondition({
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
   * The key for `provider` when no user is acting: the configured key
   * (`agentLlmApiKeyId`, an agent's own key or the organization default)
   * when it belongs to this organization and provider, else the
   * organization-wide key. Mirrors the agent-key rung of `getCurrentApiKey`:
   * permission flows through whoever configured the key, so no further
   * access check applies.
   */
  static async getOrganizationApiKey(params: {
    organizationId: string;
    provider: SupportedProvider;
    agentLlmApiKeyId?: string | null;
  }): Promise<LlmProviderApiKey | null> {
    const { organizationId, provider, agentLlmApiKeyId } = params;
    if (agentLlmApiKeyId) {
      const configuredKey =
        await LlmProviderApiKeyModel.findById(agentLlmApiKeyId);
      if (
        configuredKey &&
        configuredKey.organizationId === organizationId &&
        configuredKey.provider === provider &&
        canUseProviderApiKey(configuredKey)
      ) {
        return configuredKey;
      }
    }
    return LlmProviderApiKeyModel.findOrganizationWideKey(
      organizationId,
      provider,
    );
  }

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
            userId: data.userId !== undefined ? data.userId : existing.userId,
            excludeId: id,
          });
        }
      }

      const [updated] = await tx
        .update(schema.llmProviderApiKeysTable)
        .set({
          ...data,
          // A different secret may hold a different kind of credential: clear
          // the record so the next read classifies the new value, unless the
          // caller records it (recordCredentialKind) after this update.
          ...(data.secretId !== undefined && { credentialKind: null }),
        })
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
    const values = await CreatedByModel.forInsert({
      data: {
        organizationId: params.organizationId,
        name: params.name,
        provider: params.provider,
        scope: "org" as const,
        isSystem: true,
        secretId: null,
        userId: null,
        teamId: null,
      },
      userIdField: "createdBy",
    });
    return await db.transaction(async (tx) => {
      const [apiKey] = await tx
        .insert(schema.llmProviderApiKeysTable)
        .values(values)
        .returning();
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      // The platform provides this key to the whole organization, so it is
      // published there rather than left to whoever holds authority over
      // every key.
      await ResourcePermissionPolicyModel.createInitial({
        tx,
        organizationId: apiKey.organizationId,
        resource: "llmProviderApiKey",
        scope: apiKey.id,
        authorId: null,
        publishToOrganization: true,
      });
      // SPDX-SnippetEnd
      return apiKey;
    });
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
   * The keys whose models are due for a scheduled sync, across all
   * organizations, in one statement. A key is due when it can be synced (a
   * secret, a system key, or a provider that needs no API key — the rule
   * `getAvailableKeysForUser` applies), its oldest link is at least its
   * provider's TTL old (or it has no links at all), and no live attempt
   * marker for it is in the cache table. Never-synced keys come first, then
   * the oldest syncs.
   */
  static async findDueForModelSync(params: {
    now: Date;
    ttlMsByProvider: Partial<Record<SupportedProvider, number>>;
    defaultTtlMs: number;
    /** Cache key prefix of the attempt markers; each marker ends in the key id. */
    attemptMarkerPrefix: CacheKeyPrefix;
    limit: number;
  }): Promise<LlmProviderApiKeyForModelSync[]> {
    const { now, ttlMsByProvider, defaultTtlMs, attemptMarkerPrefix, limit } =
      params;
    const keys = schema.llmProviderApiKeysTable;
    const links = schema.llmProviderApiKeyModelsTable;
    const ttlCases = Object.entries(ttlMsByProvider).map(
      ([provider, ttlMs]) => sql`WHEN ${provider} THEN ${ttlMs}::bigint`,
    );
    const ttlMs =
      ttlCases.length > 0
        ? sql`(CASE ${keys.provider} ${sql.join(ttlCases, sql` `)} ELSE ${defaultTtlMs}::bigint END)`
        : sql`${defaultTtlMs}::bigint`;
    // The key's least recently synced link, one probe of
    // api_key_models_api_key_id_synced_at_idx. A link without synced_at
    // predates the column, sorts first and counts as stale. A key with no
    // links gets null, which counts as stale too.
    const oldestSyncedAt = sql<Date | null>`(
      SELECT coalesce(${links.syncedAt}, to_timestamp(0) AT TIME ZONE 'UTC')
      FROM ${links}
      WHERE ${links.apiKeyId} = ${keys.id}
      ORDER BY ${links.syncedAt} ASC NULLS FIRST
      LIMIT 1
    )`;
    const syncableCondition = or(
      isNotNull(keys.secretId),
      eq(keys.isSystem, true),
      inArray(keys.provider, getConfiguredProvidersWithOptionalApiKey()),
    );

    return db
      .select({
        id: keys.id,
        organizationId: keys.organizationId,
        name: keys.name,
        provider: keys.provider,
        secretId: keys.secretId,
        baseUrl: keys.baseUrl,
        extraHeaders: keys.extraHeaders,
        isSystem: keys.isSystem,
      })
      .from(keys)
      .where(
        and(
          syncableCondition,
          // synced_at is a UTC timestamp without time zone.
          sql`coalesce(${oldestSyncedAt} <= (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC') - ${ttlMs} * interval '1 millisecond', true)`,
          sql`NOT ${cacheManager.liveEntryExists({
            prefix: attemptMarkerPrefix,
            id: sql`${keys.id}::text`,
            now,
          })}`,
        ),
      )
      .orderBy(
        sql`${oldestSyncedAt} ASC NULLS FIRST`,
        asc(keys.createdAt),
        asc(keys.id),
      )
      .limit(limit);
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
 * deriving the vault reference and dropping the secret columns.
 *
 * The secret is decrypted only for BYOS-vault rows, whose stored value is the
 * "path#key" reference to surface (the BYOS manager is the only writer of
 * vault references, and it always sets `isByosVault`). The subscription kind
 * comes from the recorded credential kind; no secret is read for it.
 */
function toApiKeyWithScopeInfo<
  T extends {
    provider: string;
    secretId: string | null;
    secret: SecretValue | null;
    secretIsVault: boolean | null;
    secretIsByosVault: boolean | null;
    credentialKind: LlmProviderCredentialKind | null;
  },
>(
  key: T,
  subscriptionKind: SubscriptionCredentialKind | null,
): Omit<
  T,
  "secret" | "secretIsVault" | "secretIsByosVault" | "credentialKind"
> & {
  vaultSecretPath: string | null;
  vaultSecretKey: string | null;
  secretStorageType: SecretStorageType;
  subscriptionKind: SubscriptionCredentialKind | null;
} {
  const vaultRef = key.secretIsByosVault
    ? parseVaultReferenceFromApiKey(decryptApiKeyValue(key.secret))
    : null;
  const {
    secret: _secret,
    secretIsVault,
    secretIsByosVault,
    credentialKind: _credentialKind,
    ...rest
  } = key;
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

/**
 * The kind of credential a stored value is: the subscription it encodes, or
 * `api_key` for anything else. No value at all (a system key, or a provider
 * whose key is optional) carries no subscription marker, so it is `api_key`.
 */
function credentialKindOf(
  apiKeyValue: string | null | undefined,
): LlmProviderCredentialKind {
  return subscriptionKindFromCredential(apiKeyValue) ?? "api_key";
}

/**
 * Whether only the key's owner may use it: providers whose credential is
 * always personal, and subscription credentials on any provider. An unknown
 * kind (a legacy value that could not be read) counts as personal, so a
 * shared reader never gets a credential that might be somebody's account.
 */
function isPerUserCredential(
  provider: SupportedProvider,
  kind: LlmProviderCredentialKind | null | undefined,
): boolean {
  return providerRequiresPerUserCredential(provider) || kind !== "api_key";
}

/**
 * Whether a list read shows the key to this user. A per-user credential is
 * listed for its owner only. When the kind is unknown (a legacy secret that
 * could not be read this time), a shared key is listed for whoever added it,
 * so the one person who can fix it still sees it, and hidden from everyone
 * else until a later read classifies it.
 */
function isListedFor(params: {
  key: {
    provider: SupportedProvider;
    userId: string | null;
    createdBy: string | null;
  };
  kind: LlmProviderCredentialKind | null | undefined;
  userId: string;
}): boolean {
  const { key, kind, userId } = params;
  if (key.userId === userId) return true;
  if (!kind && key.userId === null && key.createdBy === userId) return true;
  return !isPerUserCredential(key.provider, kind);
}

/** The subscription a key's credential encodes, for the response. */
function subscriptionKindOf(
  provider: string,
  kind: LlmProviderCredentialKind | null | undefined,
): SubscriptionCredentialKind | null {
  if (!isCredentialLevelSubscriptionProvider(provider)) return null;
  return kind && kind !== "api_key" ? kind : null;
}

/**
 * The recorded credential kind of each key. Rows written before the column
 * existed are classified from their secret once and the result stored, so
 * the next read resolves nothing. A secret that cannot be read stays
 * unclassified (and is treated as personal) rather than stored as a guess.
 */
async function resolveCredentialKinds(
  keys: Array<{
    id: string;
    secretId: string | null;
    secret: SecretValue | null;
    secretIsVault: boolean | null;
    secretIsByosVault: boolean | null;
    credentialKind: LlmProviderCredentialKind | null;
  }>,
): Promise<Map<string, LlmProviderCredentialKind | null>> {
  const kinds = new Map<string, LlmProviderCredentialKind | null>();
  await Promise.all(
    keys.map(async (key) => {
      if (key.credentialKind) {
        kinds.set(key.id, key.credentialKind);
        return;
      }
      let value: string | null;
      try {
        value =
          key.secretId && (key.secretIsVault || key.secretIsByosVault)
            ? ((await getSecretValueForLlmProviderApiKey(key.secretId)) ?? null)
            : decryptApiKeyValue(key.secret);
      } catch (error) {
        logger.warn(
          { error, secretId: key.secretId },
          "Failed to resolve an LLM provider secret while classifying its credential",
        );
        // A concurrent read that could reach the secret may have stored the
        // kind meanwhile; use it rather than treating the key as unknown.
        kinds.set(key.id, await storedCredentialKind(key.id));
        return;
      }
      const kind = credentialKindOf(value);
      kinds.set(key.id, kind);
      await db
        .update(schema.llmProviderApiKeysTable)
        .set({ credentialKind: kind })
        .where(
          and(
            eq(schema.llmProviderApiKeysTable.id, key.id),
            isNull(schema.llmProviderApiKeysTable.credentialKind),
          ),
        );
    }),
  );
  return kinds;
}

/** The kind recorded on the key's row, or null while it is unclassified. */
async function storedCredentialKind(
  id: string,
): Promise<LlmProviderCredentialKind | null> {
  const [row] = await db
    .select({ credentialKind: schema.llmProviderApiKeysTable.credentialKind })
    .from(schema.llmProviderApiKeysTable)
    .where(eq(schema.llmProviderApiKeysTable.id, id));
  return row?.credentialKind ?? null;
}

/**
 * Drop the keys a list read must not show this user: other people's
 * credentials that work for one person only (see isListedFor). The kind comes
 * from its column; only rows written before it existed resolve their secret,
 * once.
 */
async function withoutOthersPerUserCredentials<
  T extends {
    id: string;
    provider: SupportedProvider;
    userId: string | null;
    createdBy: string | null;
    secretId: string | null;
    secret: SecretValue | null;
    secretIsVault: boolean | null;
    secretIsByosVault: boolean | null;
    credentialKind: LlmProviderCredentialKind | null;
  },
>(keys: T[], userId: string): Promise<T[]> {
  const kinds = await resolveCredentialKinds(keys);
  return keys.filter((key) =>
    isListedFor({ key, kind: kinds.get(key.id), userId }),
  );
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
 * the partial unique indexes (chat_api_keys_primary_{owner,shared}_unique): an
 * owner's own keys are exclusive per (organization, provider, owner), and the
 * shared keys (no owner) per (organization, provider).
 */
async function demoteCurrentPrimary(
  tx: Transaction,
  partition: {
    organizationId: string;
    provider: SupportedProvider;
    /** The key's owner; null for a shared key. */
    userId: string | null;
    excludeId?: string;
  },
): Promise<void> {
  const conditions = [
    eq(schema.llmProviderApiKeysTable.organizationId, partition.organizationId),
    eq(schema.llmProviderApiKeysTable.provider, partition.provider),
    eq(schema.llmProviderApiKeysTable.isPrimary, true),
    partition.userId === null
      ? isNull(schema.llmProviderApiKeysTable.userId)
      : eq(schema.llmProviderApiKeysTable.userId, partition.userId),
  ];
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
