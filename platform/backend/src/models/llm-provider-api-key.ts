import {
  isVaultReference,
  PROVIDERS_WITH_OPTIONAL_API_KEY,
  parseVaultReference,
  type SupportedProvider,
} from "@shared";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { computeSecretStorageType } from "@/secrets-manager/utils";
import type {
  InsertLlmProviderApiKey,
  LlmProviderApiKey,
  LlmProviderApiKeyWithScopeInfo,
  ResourceVisibilityScope,
  SecretValue,
  UpdateLlmProviderApiKey,
} from "@/types";
import { decryptSecretValue, isEncryptedSecret } from "@/utils/crypto";
import ConversationModel from "./conversation";

class LlmProviderApiKeyModel {
  /**
   * Create a new LLM provider API key.
   */
  static async create(
    data: InsertLlmProviderApiKey,
  ): Promise<LlmProviderApiKey> {
    const [apiKey] = await db
      .insert(schema.llmProviderApiKeysTable)
      .values(data)
      .returning();

    return apiKey;
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
  static async getVisibleKeys(
    organizationId: string,
    userId: string,
    userTeamIds: string[],
    isAgentAdmin: boolean,
    filters?: {
      search?: string;
      provider?: SupportedProvider;
    },
  ): Promise<LlmProviderApiKeyWithScopeInfo[]> {
    // Build conditions based on visibility rules
    const conditions = [
      eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
    ];

    if (isAgentAdmin) {
      // Admins see all keys except other users' personal keys
      const adminConditions = [
        // Own personal keys
        and(
          eq(schema.llmProviderApiKeysTable.scope, "personal"),
          eq(schema.llmProviderApiKeysTable.userId, userId),
        ),
        // All team keys
        eq(schema.llmProviderApiKeysTable.scope, "team"),
        // All org-wide keys
        eq(schema.llmProviderApiKeysTable.scope, "org"),
      ];
      const adminOrCondition = or(...adminConditions);
      if (adminOrCondition) {
        conditions.push(adminOrCondition);
      }
    } else {
      // Regular users see their personal + their teams + org-wide
      const visibilityConditions = [
        // Own personal keys
        and(
          eq(schema.llmProviderApiKeysTable.scope, "personal"),
          eq(schema.llmProviderApiKeysTable.userId, userId),
        ),
        // Org-wide keys
        eq(schema.llmProviderApiKeysTable.scope, "org"),
      ];

      // Team keys (only if user has teams)
      if (userTeamIds.length > 0) {
        visibilityConditions.push(
          and(
            eq(schema.llmProviderApiKeysTable.scope, "team"),
            inArray(schema.llmProviderApiKeysTable.teamId, userTeamIds),
          ),
        );
      }

      const userOrCondition = or(...visibilityConditions);
      if (userOrCondition) {
        conditions.push(userOrCondition);
      }
    }

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

    // Query with team, user, and secrets table joins.
    // NOTE: secretsTable.secret is encrypted at rest — decrypt via
    // parseVaultReferenceFromSecret() before reading the value.
    const apiKeys = await db
      .select({
        id: schema.llmProviderApiKeysTable.id,
        organizationId: schema.llmProviderApiKeysTable.organizationId,
        name: schema.llmProviderApiKeysTable.name,
        provider: schema.llmProviderApiKeysTable.provider,
        secretId: schema.llmProviderApiKeysTable.secretId,
        baseUrl: schema.llmProviderApiKeysTable.baseUrl,
        extraHeaders: schema.llmProviderApiKeysTable.extraHeaders,
        scope: schema.llmProviderApiKeysTable.scope,
        userId: schema.llmProviderApiKeysTable.userId,
        teamId: schema.llmProviderApiKeysTable.teamId,
        isSystem: schema.llmProviderApiKeysTable.isSystem,
        isPrimary: schema.llmProviderApiKeysTable.isPrimary,
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

    // Parse vault references from secrets and compute storage type
    return apiKeys.map((key) => {
      const vaultRef = parseVaultReferenceFromSecret(key.secret);
      const secretStorageType = computeSecretStorageType(
        key.secretId,
        key.secretIsVault,
        key.secretIsByosVault,
      );
      const {
        secret: _secret,
        secretIsVault: _isVault,
        secretIsByosVault: _isByosVault,
        ...rest
      } = key;
      return {
        ...rest,
        vaultSecretPath: vaultRef?.vaultSecretPath ?? null,
        vaultSecretKey: vaultRef?.vaultSecretKey ?? null,
        secretStorageType,
      };
    });
  }

  /**
   * Get available LLM provider API keys for a user to use across product features.
   * Only returns keys the user has access to.
   */
  static async getAvailableKeysForUser(
    organizationId: string,
    userId: string,
    userTeamIds: string[],
    provider?: SupportedProvider,
  ): Promise<LlmProviderApiKeyWithScopeInfo[]> {
    // Build conditions
    const conditions = [
      eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
    ];

    // User can only use: own personal + their teams + org-wide
    const accessConditions = [
      // Own personal keys
      and(
        eq(schema.llmProviderApiKeysTable.scope, "personal"),
        eq(schema.llmProviderApiKeysTable.userId, userId),
      ),
      // Org-wide keys
      eq(schema.llmProviderApiKeysTable.scope, "org"),
    ];

    // Team keys (only if user has teams)
    if (userTeamIds.length > 0) {
      accessConditions.push(
        and(
          eq(schema.llmProviderApiKeysTable.scope, "team"),
          inArray(schema.llmProviderApiKeysTable.teamId, userTeamIds),
        ),
      );
    }

    const accessOrCondition = or(...accessConditions);
    if (accessOrCondition) {
      conditions.push(accessOrCondition);
    }

    // Filter by provider if specified
    if (provider) {
      conditions.push(eq(schema.llmProviderApiKeysTable.provider, provider));
    }

    // Only return keys with configured secrets, system keys, or providers with optional API keys
    const secretOrSystemCondition = or(
      sql`${schema.llmProviderApiKeysTable.secretId} IS NOT NULL`,
      eq(schema.llmProviderApiKeysTable.isSystem, true),
      inArray(schema.llmProviderApiKeysTable.provider, [
        ...PROVIDERS_WITH_OPTIONAL_API_KEY,
      ]),
    );
    if (secretOrSystemCondition) {
      conditions.push(secretOrSystemCondition);
    }

    // Query with team, user, and secrets table joins.
    // NOTE: secretsTable.secret is encrypted at rest — decrypt via
    // parseVaultReferenceFromSecret() before reading the value.
    const apiKeys = await db
      .select({
        id: schema.llmProviderApiKeysTable.id,
        organizationId: schema.llmProviderApiKeysTable.organizationId,
        name: schema.llmProviderApiKeysTable.name,
        provider: schema.llmProviderApiKeysTable.provider,
        secretId: schema.llmProviderApiKeysTable.secretId,
        baseUrl: schema.llmProviderApiKeysTable.baseUrl,
        extraHeaders: schema.llmProviderApiKeysTable.extraHeaders,
        scope: schema.llmProviderApiKeysTable.scope,
        userId: schema.llmProviderApiKeysTable.userId,
        teamId: schema.llmProviderApiKeysTable.teamId,
        isSystem: schema.llmProviderApiKeysTable.isSystem,
        isPrimary: schema.llmProviderApiKeysTable.isPrimary,
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

    // Parse vault references from secrets and compute storage type
    return apiKeys.map((key) => {
      const vaultRef = parseVaultReferenceFromSecret(key.secret);
      const secretStorageType = computeSecretStorageType(
        key.secretId,
        key.secretIsVault,
        key.secretIsByosVault,
      );
      const {
        secret: _secret,
        secretIsVault: _isVault,
        secretIsByosVault: _isByosVault,
        ...rest
      } = key;
      return {
        ...rest,
        vaultSecretPath: vaultRef?.vaultSecretPath ?? null,
        vaultSecretKey: vaultRef?.vaultSecretKey ?? null,
        secretStorageType,
      };
    });
  }

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
        conversationKey.secretId
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
          LlmProviderApiKeyModel.userHasAccessToKey(
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
      if (agentKey && agentKey.provider === provider && agentKey.secretId) {
        return agentKey;
      }
    }

    // Condition: key has a secret OR provider allows optional API keys
    const hasSecretOrOptional = or(
      sql`${schema.llmProviderApiKeysTable.secretId} IS NOT NULL`,
      inArray(schema.llmProviderApiKeysTable.provider, [
        ...PROVIDERS_WITH_OPTIONAL_API_KEY,
      ]),
    );

    // 3. Try personal key (prefer isPrimary, then oldest)
    const [personalKey] = await db
      .select()
      .from(schema.llmProviderApiKeysTable)
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
          eq(schema.llmProviderApiKeysTable.provider, provider),
          eq(schema.llmProviderApiKeysTable.scope, "personal"),
          eq(schema.llmProviderApiKeysTable.userId, userId),
          hasSecretOrOptional,
        ),
      )
      .orderBy(
        sql`${schema.llmProviderApiKeysTable.isPrimary} DESC`,
        schema.llmProviderApiKeysTable.createdAt,
      )
      .limit(1);

    if (personalKey) {
      return personalKey;
    }

    // 4. Try team key (prefer isPrimary, then oldest)
    if (userTeamIds.length > 0) {
      const [teamKey] = await db
        .select()
        .from(schema.llmProviderApiKeysTable)
        .where(
          and(
            eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
            eq(schema.llmProviderApiKeysTable.provider, provider),
            eq(schema.llmProviderApiKeysTable.scope, "team"),
            inArray(schema.llmProviderApiKeysTable.teamId, userTeamIds),
            hasSecretOrOptional,
          ),
        )
        .orderBy(
          sql`${schema.llmProviderApiKeysTable.isPrimary} DESC`,
          schema.llmProviderApiKeysTable.createdAt,
        )
        .limit(1);

      if (teamKey) {
        return teamKey;
      }
    }

    // 5. Try org-wide key (prefer isPrimary, then oldest)
    const [orgWideKey] = await db
      .select()
      .from(schema.llmProviderApiKeysTable)
      .where(
        and(
          eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
          eq(schema.llmProviderApiKeysTable.provider, provider),
          eq(schema.llmProviderApiKeysTable.scope, "org"),
          hasSecretOrOptional,
        ),
      )
      .orderBy(
        sql`${schema.llmProviderApiKeysTable.isPrimary} DESC`,
        schema.llmProviderApiKeysTable.createdAt,
      )
      .limit(1);

    return orgWideKey ?? null;
  }

  /**
   * Check if a user has access to a specific LLM provider API key based on scope.
   */
  private static userHasAccessToKey(
    apiKey: LlmProviderApiKey,
    userId: string,
    userTeamIds: string[],
  ): boolean {
    switch (apiKey.scope) {
      case "personal":
        return apiKey.userId === userId;
      case "team":
        return apiKey.teamId !== null && userTeamIds.includes(apiKey.teamId);
      case "org":
        return true;
      default:
        return false;
    }
  }

  /**
   * Find a key by scope and provider.
   * Primarily used to find org-wide keys for a specific provider.
   *
   * @param organizationId - The organization ID
   * @param provider - The LLM provider (anthropic, openai, gemini)
   * @param scope - The key scope (personal, team, org)
   * @param scopeId - For personal: userId, for team: teamId (optional)
   * @returns The first matching LLM provider API key or null
   */
  static async findByScope(
    organizationId: string,
    provider: SupportedProvider,
    scope: ResourceVisibilityScope,
    scopeId?: string, // userId for personal, teamId for team
  ): Promise<LlmProviderApiKey | null> {
    const conditions = [
      eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
      eq(schema.llmProviderApiKeysTable.provider, provider),
      eq(schema.llmProviderApiKeysTable.scope, scope),
    ];

    if (scope === "personal" && scopeId) {
      conditions.push(eq(schema.llmProviderApiKeysTable.userId, scopeId));
    } else if (scope === "team" && scopeId) {
      conditions.push(eq(schema.llmProviderApiKeysTable.teamId, scopeId));
    }

    const [apiKey] = await db
      .select()
      .from(schema.llmProviderApiKeysTable)
      .where(and(...conditions))
      .orderBy(
        desc(schema.llmProviderApiKeysTable.isPrimary),
        asc(schema.llmProviderApiKeysTable.createdAt),
      )
      .limit(1);

    return apiKey ?? null;
  }

  /**
   * Update an LLM provider API key.
   */
  static async update(
    id: string,
    data: UpdateLlmProviderApiKey,
  ): Promise<LlmProviderApiKey | null> {
    const [updated] = await db
      .update(schema.llmProviderApiKeysTable)
      .set(data)
      .where(eq(schema.llmProviderApiKeysTable.id, id))
      .returning();

    return updated ?? null;
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
      .values({
        organizationId: params.organizationId,
        name: params.name,
        provider: params.provider,
        scope: "org",
        isSystem: true,
        secretId: null,
        userId: null,
        teamId: null,
      })
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
  static async getConfiguredProviders(): Promise<Set<string>> {
    const rows = await db
      .selectDistinct({ provider: schema.llmProviderApiKeysTable.provider })
      .from(schema.llmProviderApiKeysTable);
    return new Set(rows.map((r) => r.provider));
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

/**
 * Helper to parse vault reference from a secret value.
 * For LLM provider API keys, the secret contains { apiKey: "path#key" } format.
 */
function parseVaultReferenceFromSecret(
  secret: SecretValue | null,
): { vaultSecretPath: string; vaultSecretKey: string } | null {
  if (!secret || typeof secret !== "object") return null;
  const decrypted = isEncryptedSecret(secret)
    ? decryptSecretValue(secret)
    : secret;
  const apiKeyValue = (decrypted as Record<string, unknown>).apiKey;
  if (typeof apiKeyValue === "string" && isVaultReference(apiKeyValue)) {
    const parsed = parseVaultReference(apiKeyValue);
    return {
      vaultSecretPath: parsed.path,
      vaultSecretKey: parsed.key,
    };
  }
  return null;
}

export default LlmProviderApiKeyModel;
