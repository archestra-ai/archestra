import {
  isVaultReference,
  PROVIDERS_WITH_OPTIONAL_API_KEY,
  parseVaultReference,
} from "@shared";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { computeSecretStorageType } from "@/secrets-manager/utils";
import type {
  ChatApiKey,
  ChatApiKeyScope,
  ChatApiKeyWithScopeInfo,
  InsertChatApiKey,
  SecretValue,
  SupportedChatProvider,
  UpdateChatApiKey,
} from "@/types";
import ConversationModel from "./conversation";

class ChatApiKeyModel {
  /**
   * Create a new chat API key
   */
  static async create(data: InsertChatApiKey): Promise<ChatApiKey> {
    const [apiKey] = await db
      .insert(schema.chatApiKeysTable)
      .values(data)
      .returning();

    return apiKey;
  }

  /**
   * Find a chat API key by ID
   */
  static async findById(id: string): Promise<ChatApiKey | null> {
    const [apiKey] = await db
      .select()
      .from(schema.chatApiKeysTable)
      .where(eq(schema.chatApiKeysTable.id, id));

    return apiKey ?? null;
  }

  /**
   * Find all chat API keys for an organization
   */
  static async findByOrganizationId(
    organizationId: string,
  ): Promise<ChatApiKey[]> {
    const apiKeys = await db
      .select()
      .from(schema.chatApiKeysTable)
      .where(eq(schema.chatApiKeysTable.organizationId, organizationId))
      .orderBy(schema.chatApiKeysTable.createdAt);

    return apiKeys;
  }

  /**
   * Get visible API keys for a user based on scope access.
   *
   * Visibility rules:
   * - Users see: their personal keys + team keys for their teams + org-wide keys
   * - Users with profile:admin: see all keys EXCEPT personal keys of other users
   */
  static async getVisibleKeys(
    organizationId: string,
    userId: string,
    userTeamIds: string[],
    isProfileAdmin: boolean,
  ): Promise<ChatApiKeyWithScopeInfo[]> {
    // Build conditions based on visibility rules
    const conditions = [
      eq(schema.chatApiKeysTable.organizationId, organizationId),
    ];

    if (isProfileAdmin) {
      // Admins see all keys except other users' personal keys
      const adminConditions = [
        // Own personal keys
        and(
          eq(schema.chatApiKeysTable.scope, "personal"),
          eq(schema.chatApiKeysTable.userId, userId),
        ),
        // All team keys
        eq(schema.chatApiKeysTable.scope, "team"),
        // All org-wide keys
        eq(schema.chatApiKeysTable.scope, "org_wide"),
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
          eq(schema.chatApiKeysTable.scope, "personal"),
          eq(schema.chatApiKeysTable.userId, userId),
        ),
        // Org-wide keys
        eq(schema.chatApiKeysTable.scope, "org_wide"),
      ];

      // Team keys (only if user has teams)
      if (userTeamIds.length > 0) {
        visibilityConditions.push(
          and(
            eq(schema.chatApiKeysTable.scope, "team"),
            inArray(schema.chatApiKeysTable.teamId, userTeamIds),
          ),
        );
      }

      const userOrCondition = or(...visibilityConditions);
      if (userOrCondition) {
        conditions.push(userOrCondition);
      }
    }

    // Query with team, user, and secrets table joins
    const apiKeys = await db
      .select({
        id: schema.chatApiKeysTable.id,
        organizationId: schema.chatApiKeysTable.organizationId,
        name: schema.chatApiKeysTable.name,
        provider: schema.chatApiKeysTable.provider,
        secretId: schema.chatApiKeysTable.secretId,
        scope: schema.chatApiKeysTable.scope,
        userId: schema.chatApiKeysTable.userId,
        teamId: schema.chatApiKeysTable.teamId,
        isSystem: schema.chatApiKeysTable.isSystem,
        createdAt: schema.chatApiKeysTable.createdAt,
        updatedAt: schema.chatApiKeysTable.updatedAt,
        teamName: schema.teamsTable.name,
        userName: schema.usersTable.name,
        secret: schema.secretsTable.secret,
        secretIsVault: schema.secretsTable.isVault,
        secretIsByosVault: schema.secretsTable.isByosVault,
      })
      .from(schema.chatApiKeysTable)
      .leftJoin(
        schema.teamsTable,
        eq(schema.chatApiKeysTable.teamId, schema.teamsTable.id),
      )
      .leftJoin(
        schema.usersTable,
        eq(schema.chatApiKeysTable.userId, schema.usersTable.id),
      )
      .leftJoin(
        schema.secretsTable,
        eq(schema.chatApiKeysTable.secretId, schema.secretsTable.id),
      )
      .where(and(...conditions))
      .orderBy(schema.chatApiKeysTable.createdAt);

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
   * Get available API keys for a user to use in chat.
   * Only returns keys the user has access to.
   */
  static async getAvailableKeysForUser(
    organizationId: string,
    userId: string,
    userTeamIds: string[],
    provider?: SupportedChatProvider,
  ): Promise<ChatApiKeyWithScopeInfo[]> {
    // Build conditions
    const conditions = [
      eq(schema.chatApiKeysTable.organizationId, organizationId),
    ];

    // User can only use: own personal + their teams + org-wide
    const accessConditions = [
      // Own personal keys
      and(
        eq(schema.chatApiKeysTable.scope, "personal"),
        eq(schema.chatApiKeysTable.userId, userId),
      ),
      // Org-wide keys
      eq(schema.chatApiKeysTable.scope, "org_wide"),
    ];

    // Team keys (only if user has teams)
    if (userTeamIds.length > 0) {
      accessConditions.push(
        and(
          eq(schema.chatApiKeysTable.scope, "team"),
          inArray(schema.chatApiKeysTable.teamId, userTeamIds),
        ),
      );
    }

    const accessOrCondition = or(...accessConditions);
    if (accessOrCondition) {
      conditions.push(accessOrCondition);
    }

    // Filter by provider if specified
    if (provider) {
      conditions.push(eq(schema.chatApiKeysTable.provider, provider));
    }

    // Only return keys with configured secrets, system keys, or providers with optional API keys
    const secretOrSystemCondition = or(
      sql`${schema.chatApiKeysTable.secretId} IS NOT NULL`,
      eq(schema.chatApiKeysTable.isSystem, true),
      inArray(schema.chatApiKeysTable.provider, [
        ...PROVIDERS_WITH_OPTIONAL_API_KEY,
      ]),
    );
    if (secretOrSystemCondition) {
      conditions.push(secretOrSystemCondition);
    }

    // Query with team, user, and secrets table joins
    const apiKeys = await db
      .select({
        id: schema.chatApiKeysTable.id,
        organizationId: schema.chatApiKeysTable.organizationId,
        name: schema.chatApiKeysTable.name,
        provider: schema.chatApiKeysTable.provider,
        secretId: schema.chatApiKeysTable.secretId,
        scope: schema.chatApiKeysTable.scope,
        userId: schema.chatApiKeysTable.userId,
        teamId: schema.chatApiKeysTable.teamId,
        isSystem: schema.chatApiKeysTable.isSystem,
        createdAt: schema.chatApiKeysTable.createdAt,
        updatedAt: schema.chatApiKeysTable.updatedAt,
        teamName: schema.teamsTable.name,
        userName: schema.usersTable.name,
        secret: schema.secretsTable.secret,
        secretIsVault: schema.secretsTable.isVault,
        secretIsByosVault: schema.secretsTable.isByosVault,
      })
      .from(schema.chatApiKeysTable)
      .leftJoin(
        schema.teamsTable,
        eq(schema.chatApiKeysTable.teamId, schema.teamsTable.id),
      )
      .leftJoin(
        schema.usersTable,
        eq(schema.chatApiKeysTable.userId, schema.usersTable.id),
      )
      .leftJoin(
        schema.secretsTable,
        eq(schema.chatApiKeysTable.secretId, schema.secretsTable.id),
      )
      .where(and(...conditions))
      .orderBy(schema.chatApiKeysTable.createdAt);

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
    provider: SupportedChatProvider;
    conversationId: string | null;
    agentLlmApiKeyId?: string | null;
  }): Promise<ChatApiKey | null> {
    const conversation = conversationId
      ? await ConversationModel.findById({
          id: conversationId,
          userId,
          organizationId,
        })
      : null;

    // 1. If conversation has an explicit API key set, use it
    if (conversation?.chatApiKeyId) {
      const conversationKey = await ChatApiKeyModel.findById(
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
          ChatApiKeyModel.userHasAccessToKey(
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
      const agentKey = await ChatApiKeyModel.findById(agentLlmApiKeyId);
      if (agentKey && agentKey.provider === provider && agentKey.secretId) {
        return agentKey;
      }
    }

    // 2. Try personal key
    const [personalKey] = await db
      .select()
      .from(schema.chatApiKeysTable)
      .where(
        and(
          eq(schema.chatApiKeysTable.organizationId, organizationId),
          eq(schema.chatApiKeysTable.provider, provider),
          eq(schema.chatApiKeysTable.scope, "personal"),
          eq(schema.chatApiKeysTable.userId, userId),
          sql`${schema.chatApiKeysTable.secretId} IS NOT NULL`,
        ),
      )
      .limit(1);

    if (personalKey) {
      return personalKey;
    }

    // 3. Try team key (first available from user's teams)
    if (userTeamIds.length > 0) {
      const [teamKey] = await db
        .select()
        .from(schema.chatApiKeysTable)
        .where(
          and(
            eq(schema.chatApiKeysTable.organizationId, organizationId),
            eq(schema.chatApiKeysTable.provider, provider),
            eq(schema.chatApiKeysTable.scope, "team"),
            inArray(schema.chatApiKeysTable.teamId, userTeamIds),
            sql`${schema.chatApiKeysTable.secretId} IS NOT NULL`,
          ),
        )
        .limit(1);

      if (teamKey) {
        return teamKey;
      }
    }

    // 4. Try org-wide key
    const [orgWideKey] = await db
      .select()
      .from(schema.chatApiKeysTable)
      .where(
        and(
          eq(schema.chatApiKeysTable.organizationId, organizationId),
          eq(schema.chatApiKeysTable.provider, provider),
          eq(schema.chatApiKeysTable.scope, "org_wide"),
          sql`${schema.chatApiKeysTable.secretId} IS NOT NULL`,
        ),
      )
      .limit(1);

    return orgWideKey ?? null;
  }

  /**
   * Check if a user has access to a specific API key based on scope
   */
  private static userHasAccessToKey(
    apiKey: ChatApiKey,
    userId: string,
    userTeamIds: string[],
  ): boolean {
    switch (apiKey.scope) {
      case "personal":
        return apiKey.userId === userId;
      case "team":
        return apiKey.teamId !== null && userTeamIds.includes(apiKey.teamId);
      case "org_wide":
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
   * @param scope - The key scope (personal, team, org_wide)
   * @param scopeId - For personal: userId, for team: teamId (optional)
   * @returns The first matching API key or null
   */
  static async findByScope(
    organizationId: string,
    provider: SupportedChatProvider,
    scope: ChatApiKeyScope,
    scopeId?: string, // userId for personal, teamId for team
  ): Promise<ChatApiKey | null> {
    const conditions = [
      eq(schema.chatApiKeysTable.organizationId, organizationId),
      eq(schema.chatApiKeysTable.provider, provider),
      eq(schema.chatApiKeysTable.scope, scope),
    ];

    if (scope === "personal" && scopeId) {
      conditions.push(eq(schema.chatApiKeysTable.userId, scopeId));
    } else if (scope === "team" && scopeId) {
      conditions.push(eq(schema.chatApiKeysTable.teamId, scopeId));
    }

    const [apiKey] = await db
      .select()
      .from(schema.chatApiKeysTable)
      .where(and(...conditions))
      .limit(1);

    return apiKey ?? null;
  }

  /**
   * Update a chat API key
   */
  static async update(
    id: string,
    data: UpdateChatApiKey,
  ): Promise<ChatApiKey | null> {
    const [updated] = await db
      .update(schema.chatApiKeysTable)
      .set(data)
      .where(eq(schema.chatApiKeysTable.id, id))
      .returning();

    return updated ?? null;
  }

  /**
   * Delete a chat API key
   */
  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.chatApiKeysTable)
      .where(eq(schema.chatApiKeysTable.id, id))
      .returning({ id: schema.chatApiKeysTable.id });

    return result.length > 0;
  }

  /**
   * Check if any API key exists for an organization
   */
  static async hasAnyApiKey(organizationId: string): Promise<boolean> {
    const [result] = await db
      .select({ id: schema.chatApiKeysTable.id })
      .from(schema.chatApiKeysTable)
      .where(eq(schema.chatApiKeysTable.organizationId, organizationId))
      .limit(1);

    return !!result;
  }

  /**
   * Check if an API key exists with a configured secret for an organization and provider
   */
  static async hasConfiguredApiKey(
    organizationId: string,
    provider: SupportedChatProvider,
  ): Promise<boolean> {
    const [result] = await db
      .select({ id: schema.chatApiKeysTable.id })
      .from(schema.chatApiKeysTable)
      .where(
        and(
          eq(schema.chatApiKeysTable.organizationId, organizationId),
          eq(schema.chatApiKeysTable.provider, provider),
          sql`${schema.chatApiKeysTable.secretId} IS NOT NULL`,
        ),
      )
      .limit(1);

    return !!result;
  }

  // =========================================================================
  // System API Key Methods
  // =========================================================================

  /**
   * Find the system API key for a provider.
   * System keys are global (one per provider).
   */
  static async findSystemKey(
    provider: SupportedChatProvider,
  ): Promise<ChatApiKey | null> {
    const [result] = await db
      .select()
      .from(schema.chatApiKeysTable)
      .where(
        and(
          eq(schema.chatApiKeysTable.provider, provider),
          eq(schema.chatApiKeysTable.isSystem, true),
        ),
      )
      .limit(1);

    return result ?? null;
  }

  /**
   * Create a system API key for a keyless provider.
   * System keys don't require a secret (credentials from environment/ADC).
   */
  static async createSystemKey(params: {
    organizationId: string;
    name: string;
    provider: SupportedChatProvider;
  }): Promise<ChatApiKey> {
    const [apiKey] = await db
      .insert(schema.chatApiKeysTable)
      .values({
        organizationId: params.organizationId,
        name: params.name,
        provider: params.provider,
        scope: "org_wide",
        isSystem: true,
        secretId: null,
        userId: null,
        teamId: null,
      })
      .returning();

    return apiKey;
  }

  /**
   * Delete the system API key for a provider.
   * Also deletes associated model links via cascade.
   */
  static async deleteSystemKey(provider: SupportedChatProvider): Promise<void> {
    await db
      .delete(schema.chatApiKeysTable)
      .where(
        and(
          eq(schema.chatApiKeysTable.provider, provider),
          eq(schema.chatApiKeysTable.isSystem, true),
        ),
      );
  }

  /**
   * Get all system API keys.
   */
  static async findAllSystemKeys(): Promise<ChatApiKey[]> {
    return db
      .select()
      .from(schema.chatApiKeysTable)
      .where(eq(schema.chatApiKeysTable.isSystem, true));
  }
}

/**
 * Helper to parse vault reference from a secret value
 * For chat API keys, the secret contains { apiKey: "path#key" } format
 */
function parseVaultReferenceFromSecret(
  secret: SecretValue | null,
): { vaultSecretPath: string; vaultSecretKey: string } | null {
  if (!secret || typeof secret !== "object") return null;
  const apiKeyValue = (secret as Record<string, unknown>).apiKey;
  if (typeof apiKeyValue === "string" && isVaultReference(apiKeyValue)) {
    const parsed = parseVaultReference(apiKeyValue);
    return {
      vaultSecretPath: parsed.path,
      vaultSecretKey: parsed.key,
    };
  }
  return null;
}

export default ChatApiKeyModel;
