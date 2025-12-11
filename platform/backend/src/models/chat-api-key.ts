import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  ChatApiKey,
  ChatApiKeyWithProfiles,
  InsertChatApiKey,
  InsertProfileChatApiKey,
  ProfileChatApiKey,
  SupportedChatProvider,
  UpdateChatApiKey,
} from "@/types";

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

    return apiKey;
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
   * Find all chat API keys for an organization with their assigned profiles
   */
  static async findByOrganizationIdWithProfiles(
    organizationId: string,
  ): Promise<ChatApiKeyWithProfiles[]> {
    const apiKeys = await ChatApiKeyModel.findByOrganizationId(organizationId);

    if (apiKeys.length === 0) {
      return [];
    }

    // Get all profile assignments for these API keys
    const assignments = await db
      .select({
        chatApiKeyId: schema.profileChatApiKeysTable.chatApiKeyId,
        agentId: schema.profileChatApiKeysTable.agentId,
        agentName: schema.agentsTable.name,
      })
      .from(schema.profileChatApiKeysTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.profileChatApiKeysTable.agentId, schema.agentsTable.id),
      )
      .where(
        inArray(
          schema.profileChatApiKeysTable.chatApiKeyId,
          apiKeys.map((k) => k.id),
        ),
      );

    // Group assignments by API key ID
    const assignmentsByKeyId = new Map<
      string,
      { id: string; name: string }[]
    >();
    for (const assignment of assignments) {
      const profiles = assignmentsByKeyId.get(assignment.chatApiKeyId) || [];
      profiles.push({ id: assignment.agentId, name: assignment.agentName });
      assignmentsByKeyId.set(assignment.chatApiKeyId, profiles);
    }

    return apiKeys.map((apiKey) => ({
      ...apiKey,
      profiles: assignmentsByKeyId.get(apiKey.id) || [],
    }));
  }

  /**
   * Find the organization default API key for a specific provider
   */
  static async findOrganizationDefault(
    organizationId: string,
    provider: SupportedChatProvider,
  ): Promise<ChatApiKey | null> {
    const [apiKey] = await db
      .select()
      .from(schema.chatApiKeysTable)
      .where(
        and(
          eq(schema.chatApiKeysTable.organizationId, organizationId),
          eq(schema.chatApiKeysTable.provider, provider),
          eq(schema.chatApiKeysTable.isOrganizationDefault, true),
        ),
      );

    return apiKey ? (apiKey as ChatApiKey) : null;
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

    return updated;
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
   * Set an API key as the organization default for its provider.
   * This will unset any existing default for the same org/provider.
   */
  static async setAsOrganizationDefault(
    id: string,
  ): Promise<ChatApiKey | null> {
    const apiKey = await ChatApiKeyModel.findById(id);
    if (!apiKey) {
      return null;
    }

    // First, unset any existing default for this org/provider
    await db
      .update(schema.chatApiKeysTable)
      .set({ isOrganizationDefault: false })
      .where(
        and(
          eq(schema.chatApiKeysTable.organizationId, apiKey.organizationId),
          eq(schema.chatApiKeysTable.provider, apiKey.provider),
          eq(schema.chatApiKeysTable.isOrganizationDefault, true),
        ),
      );

    // Then set this key as the default
    const [updated] = await db
      .update(schema.chatApiKeysTable)
      .set({ isOrganizationDefault: true })
      .where(eq(schema.chatApiKeysTable.id, id))
      .returning();

    return updated;
  }

  /**
   * Unset the organization default status for an API key
   */
  static async unsetOrganizationDefault(
    id: string,
  ): Promise<ChatApiKey | null> {
    const [updated] = await db
      .update(schema.chatApiKeysTable)
      .set({ isOrganizationDefault: false })
      .where(eq(schema.chatApiKeysTable.id, id))
      .returning();

    return updated;
  }

  /**
   * Assign an API key to a profile.
   * Only one API key per provider is allowed per profile.
   * If a key for the same provider already exists, it will be replaced.
   */
  static async assignToProfile(
    data: InsertProfileChatApiKey,
  ): Promise<ProfileChatApiKey> {
    // Get the API key to determine its provider
    const apiKey = await ChatApiKeyModel.findById(data.chatApiKeyId);
    if (!apiKey) {
      throw new Error("API key not found");
    }

    // Remove any existing assignment for the same provider from this profile
    // This ensures only one API key per provider per profile
    const existingKeys = await db
      .select({
        assignmentId: schema.profileChatApiKeysTable.id,
        apiKeyId: schema.chatApiKeysTable.id,
      })
      .from(schema.profileChatApiKeysTable)
      .innerJoin(
        schema.chatApiKeysTable,
        eq(
          schema.profileChatApiKeysTable.chatApiKeyId,
          schema.chatApiKeysTable.id,
        ),
      )
      .where(
        and(
          eq(schema.profileChatApiKeysTable.agentId, data.agentId),
          eq(schema.chatApiKeysTable.provider, apiKey.provider),
        ),
      );

    // Delete existing same-provider assignments (except if it's the same key)
    for (const existing of existingKeys) {
      if (existing.apiKeyId !== data.chatApiKeyId) {
        await db
          .delete(schema.profileChatApiKeysTable)
          .where(eq(schema.profileChatApiKeysTable.id, existing.assignmentId));
      }
    }

    const [assignment] = await db
      .insert(schema.profileChatApiKeysTable)
      .values(data)
      .onConflictDoNothing()
      .returning();

    // If conflict (already exists), fetch the existing one
    if (!assignment) {
      const [existing] = await db
        .select()
        .from(schema.profileChatApiKeysTable)
        .where(
          and(
            eq(schema.profileChatApiKeysTable.agentId, data.agentId),
            eq(schema.profileChatApiKeysTable.chatApiKeyId, data.chatApiKeyId),
          ),
        );
      return existing;
    }

    return assignment;
  }

  /**
   * Unassign an API key from a profile
   */
  static async unassignFromProfile(
    chatApiKeyId: string,
    agentId: string,
  ): Promise<boolean> {
    const result = await db
      .delete(schema.profileChatApiKeysTable)
      .where(
        and(
          eq(schema.profileChatApiKeysTable.chatApiKeyId, chatApiKeyId),
          eq(schema.profileChatApiKeysTable.agentId, agentId),
        ),
      )
      .returning({ id: schema.profileChatApiKeysTable.id });

    return result.length > 0;
  }

  /**
   * Get all profiles assigned to an API key
   */
  static async getAssignedProfiles(
    chatApiKeyId: string,
  ): Promise<{ id: string; name: string }[]> {
    const assignments = await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
      })
      .from(schema.profileChatApiKeysTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.profileChatApiKeysTable.agentId, schema.agentsTable.id),
      )
      .where(eq(schema.profileChatApiKeysTable.chatApiKeyId, chatApiKeyId));

    return assignments;
  }

  /**
   * Get the API key for a profile for a specific provider.
   * Returns the profile's assigned key if exists, otherwise the org default.
   */
  static async getProfileApiKey(
    agentId: string,
    provider: SupportedChatProvider,
    organizationId: string,
  ): Promise<ChatApiKey | null> {
    // First, try to find a profile-specific API key for this provider
    const [profileKey] = await db
      .select({
        apiKey: schema.chatApiKeysTable,
      })
      .from(schema.profileChatApiKeysTable)
      .innerJoin(
        schema.chatApiKeysTable,
        eq(
          schema.profileChatApiKeysTable.chatApiKeyId,
          schema.chatApiKeysTable.id,
        ),
      )
      .where(
        and(
          eq(schema.profileChatApiKeysTable.agentId, agentId),
          eq(schema.chatApiKeysTable.provider, provider),
        ),
      );

    if (profileKey) {
      return profileKey.apiKey;
    }

    // Fall back to organization default
    return ChatApiKeyModel.findOrganizationDefault(organizationId, provider);
  }

  /**
   * Get all API keys assigned to a profile
   */
  static async getProfileApiKeys(agentId: string): Promise<ChatApiKey[]> {
    const assignments = await db
      .select({
        apiKey: schema.chatApiKeysTable,
      })
      .from(schema.profileChatApiKeysTable)
      .innerJoin(
        schema.chatApiKeysTable,
        eq(
          schema.profileChatApiKeysTable.chatApiKeyId,
          schema.chatApiKeysTable.id,
        ),
      )
      .where(eq(schema.profileChatApiKeysTable.agentId, agentId));

    return assignments.map((a) => a.apiKey);
  }

  /**
   * Bulk assign profiles to an API key.
   * Respects the one-key-per-provider-per-profile constraint by removing
   * existing same-provider assignments.
   */
  static async bulkAssignProfiles(
    chatApiKeyId: string,
    agentIds: string[],
  ): Promise<void> {
    if (agentIds.length === 0) {
      return;
    }

    // Use individual assignments to respect provider constraint
    for (const agentId of agentIds) {
      await ChatApiKeyModel.assignToProfile({ agentId, chatApiKeyId });
    }
  }

  /**
   * Replace all profile assignments for an API key.
   * Respects the one-key-per-provider-per-profile constraint by removing
   * existing same-provider assignments from newly assigned profiles.
   */
  static async replaceProfileAssignments(
    chatApiKeyId: string,
    agentIds: string[],
  ): Promise<void> {
    // Delete all existing assignments for this specific API key
    await db
      .delete(schema.profileChatApiKeysTable)
      .where(eq(schema.profileChatApiKeysTable.chatApiKeyId, chatApiKeyId));

    // Add new assignments (using bulk which respects provider constraint)
    if (agentIds.length > 0) {
      await ChatApiKeyModel.bulkAssignProfiles(chatApiKeyId, agentIds);
    }
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
        ),
      )
      .limit(1);

    return !!result;
  }
}

export default ChatApiKeyModel;
