import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertPrompt,
  Prompt,
  PromptHistoryEntry,
  PromptVersionsResponse,
  UpdatePrompt,
} from "@/types";
import type { ChatOpsProviderType } from "@/types/chatops";
import ToolModel from "./tool";

/**
 * Model for managing prompts with JSONB history versioning
 * Provides CRUD operations and version management
 *
 * Versioning approach:
 * - Each prompt has a stable ID (never changes)
 * - Current content stored in regular columns
 * - Previous versions stored in `history` JSONB array
 * - Update pushes current to history, then updates in-place
 * - Rollback copies from history to current (increments version)
 */
class PromptModel {
  /**
   * Create a new prompt
   */
  static async create(
    organizationId: string,
    input: InsertPrompt,
  ): Promise<Prompt> {
    const [prompt] = await db
      .insert(schema.promptsTable)
      .values({
        organizationId,
        ...input,
      })
      .returning();

    return prompt;
  }

  /**
   * Find all prompts for an organization
   */
  static async findByOrganizationId(organizationId: string): Promise<Prompt[]> {
    const prompts = await db
      .select()
      .from(schema.promptsTable)
      .where(eq(schema.promptsTable.organizationId, organizationId))
      .orderBy(desc(schema.promptsTable.createdAt));

    return prompts;
  }

  /**
   * Find all prompts for an organization filtered by accessible agent IDs
   * Returns only prompts assigned to agents the user has access to
   */
  static async findByOrganizationIdAndAccessibleAgents(
    organizationId: string,
    accessibleAgentIds: string[],
  ): Promise<Prompt[]> {
    if (accessibleAgentIds.length === 0) {
      return [];
    }

    const prompts = await db
      .select()
      .from(schema.promptsTable)
      .where(
        and(
          eq(schema.promptsTable.organizationId, organizationId),
          inArray(schema.promptsTable.agentId, accessibleAgentIds),
        ),
      )
      .orderBy(desc(schema.promptsTable.createdAt));

    return prompts;
  }

  /**
   * Find all prompts for a specific agent
   */
  static async findByAgentId(agentId: string): Promise<Prompt[]> {
    const prompts = await db
      .select()
      .from(schema.promptsTable)
      .where(eq(schema.promptsTable.agentId, agentId))
      .orderBy(desc(schema.promptsTable.createdAt));

    return prompts;
  }

  /**
   * Find all prompts (agents in UI) that allow a specific chatops provider.
   * Used to populate the agent selection dropdown in Teams/Slack/etc.
   * Returns only prompts where the provider is in the allowedChatops array.
   */
  static async findByAllowedChatopsProvider(
    provider: ChatOpsProviderType,
  ): Promise<Pick<Prompt, "id" | "name">[]> {
    // Use JSONB containment operator to check if provider is in the array
    const prompts = await db
      .select({
        id: schema.promptsTable.id,
        name: schema.promptsTable.name,
      })
      .from(schema.promptsTable)
      .where(
        sql`${schema.promptsTable.allowedChatops} @> ${JSON.stringify([provider])}::jsonb`,
      )
      .orderBy(asc(schema.promptsTable.name));

    return prompts;
  }

  /**
   * Find a prompt by ID
   */
  static async findById(id?: string | null): Promise<Prompt | null> {
    if (!id) {
      return null;
    }
    const [prompt] = await db
      .select()
      .from(schema.promptsTable)
      .where(eq(schema.promptsTable.id, id));

    return prompt || null;
  }

  /**
   * Find a prompt by ID and organization ID
   */
  static async findByIdAndOrganizationId(
    id: string,
    organizationId: string,
  ): Promise<Prompt | null> {
    const [prompt] = await db
      .select()
      .from(schema.promptsTable)
      .where(
        and(
          eq(schema.promptsTable.id, id),
          eq(schema.promptsTable.organizationId, organizationId),
        ),
      );

    return prompt || null;
  }

  /**
   * Get all versions of a prompt (current + history)
   */
  static async findVersions(
    promptId: string,
  ): Promise<PromptVersionsResponse | null> {
    const prompt = await PromptModel.findById(promptId);
    if (!prompt) {
      return null;
    }

    return {
      current: prompt,
      history: prompt.history,
    };
  }

  /**
   * Update a prompt - creates a new version by pushing current to history
   * The prompt ID stays the same (no FK migration needed)
   */
  static async update(id: string, input: UpdatePrompt): Promise<Prompt | null> {
    const prompt = await PromptModel.findById(id);
    if (!prompt) {
      return null;
    }

    // Handle name change - sync tool names
    const newName = input.name ?? prompt.name;
    const nameChanged = input.name !== undefined && input.name !== prompt.name;

    if (nameChanged) {
      await ToolModel.syncAgentDelegationToolNames([id], newName);
    }

    // Create history entry from current state
    const historyEntry: PromptHistoryEntry = {
      version: prompt.version,
      userPrompt: prompt.userPrompt,
      systemPrompt: prompt.systemPrompt,
      createdAt: prompt.createdAt.toISOString(),
    };

    // Update in-place with new version
    const [updated] = await db
      .update(schema.promptsTable)
      .set({
        name: newName,
        agentId: input.agentId ?? prompt.agentId,
        userPrompt: input.userPrompt ?? prompt.userPrompt,
        systemPrompt: input.systemPrompt ?? prompt.systemPrompt,
        allowedChatops: input.allowedChatops ?? prompt.allowedChatops,
        incomingEmailEnabled:
          input.incomingEmailEnabled ?? prompt.incomingEmailEnabled,
        incomingEmailSecurityMode:
          input.incomingEmailSecurityMode ?? prompt.incomingEmailSecurityMode,
        incomingEmailAllowedDomain:
          input.incomingEmailAllowedDomain ?? prompt.incomingEmailAllowedDomain,
        version: prompt.version + 1,
        history: sql`${schema.promptsTable.history} || ${JSON.stringify([historyEntry])}::jsonb`,
      })
      .where(eq(schema.promptsTable.id, id))
      .returning();

    return updated || null;
  }

  /**
   * Rollback to a specific version number
   * Copies content from history entry to current fields and increments version
   */
  static async rollback(
    id: string,
    targetVersion: number,
  ): Promise<Prompt | null> {
    const prompt = await PromptModel.findById(id);
    if (!prompt) {
      return null;
    }

    // Find the target version in history
    const targetEntry = prompt.history.find((h) => h.version === targetVersion);
    if (!targetEntry) {
      return null;
    }

    // Create history entry from current state before rollback
    const historyEntry: PromptHistoryEntry = {
      version: prompt.version,
      userPrompt: prompt.userPrompt,
      systemPrompt: prompt.systemPrompt,
      createdAt: prompt.createdAt.toISOString(),
    };

    // Rollback by copying target content to current and incrementing version
    const [updated] = await db
      .update(schema.promptsTable)
      .set({
        userPrompt: targetEntry.userPrompt,
        systemPrompt: targetEntry.systemPrompt,
        version: prompt.version + 1,
        history: sql`${schema.promptsTable.history} || ${JSON.stringify([historyEntry])}::jsonb`,
      })
      .where(eq(schema.promptsTable.id, id))
      .returning();

    return updated || null;
  }

  /**
   * Delete a prompt
   */
  static async delete(id: string): Promise<boolean> {
    const prompt = await PromptModel.findById(id);
    if (!prompt) {
      return false;
    }

    await db.delete(schema.promptsTable).where(eq(schema.promptsTable.id, id));

    return true;
  }
}

export default PromptModel;
