import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import AgentTeamModel from "./agent-team";
import ToolModel from "./tool";

/**
 * Prompt agent with details for display
 */
export interface PromptAgentWithDetails {
  id: string;
  promptId: string;
  agentPromptId: string;
  createdAt: Date;
  // Details from the agent prompt
  name: string;
  systemPrompt: string | null;
  // Details from the agent prompt's profile
  profileId: string;
  profileName: string;
}

/**
 * Model for managing prompt-to-agent relationships
 * A prompt can have multiple agents (other prompts) that it can delegate tasks to
 */
class PromptAgentModel {
  /**
   * Assign an agent to a prompt
   */
  static async create(params: {
    promptId: string;
    agentPromptId: string;
  }): Promise<{ id: string; promptId: string; agentPromptId: string }> {
    const { promptId, agentPromptId } = params;

    logger.debug(
      { promptId, agentPromptId },
      "PromptAgentModel.create: assigning agent to prompt",
    );

    const [result] = await db
      .insert(schema.promptAgentsTable)
      .values({
        promptId,
        agentPromptId,
      })
      .returning();

    // Get the delegated prompt's details for the tool
    const [agentPrompt] = await db
      .select({
        name: schema.promptsTable.name,
        systemPrompt: schema.promptsTable.systemPrompt,
      })
      .from(schema.promptsTable)
      .where(eq(schema.promptsTable.id, agentPromptId))
      .limit(1);

    if (agentPrompt) {
      // Create the agent delegation tool in the tools table
      await ToolModel.createAgentDelegationTool({
        promptAgentId: result.id,
        agentName: agentPrompt.name,
        description: agentPrompt.systemPrompt,
      });
    }

    return result;
  }

  /**
   * Remove an agent from a prompt
   */
  static async delete(params: {
    promptId: string;
    agentPromptId: string;
  }): Promise<boolean> {
    const { promptId, agentPromptId } = params;

    logger.debug(
      { promptId, agentPromptId },
      "PromptAgentModel.delete: removing agent from prompt",
    );

    const result = await db
      .delete(schema.promptAgentsTable)
      .where(
        and(
          eq(schema.promptAgentsTable.promptId, promptId),
          eq(schema.promptAgentsTable.agentPromptId, agentPromptId),
        ),
      );

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get all agent prompt IDs for a prompt
   */
  static async findByPromptId(
    promptId: string,
  ): Promise<Array<{ id: string; promptId: string; agentPromptId: string }>> {
    logger.debug(
      { promptId },
      "PromptAgentModel.findByPromptId: fetching agents for prompt",
    );

    const results = await db
      .select()
      .from(schema.promptAgentsTable)
      .where(eq(schema.promptAgentsTable.promptId, promptId));

    return results;
  }

  /**
   * Get all agent prompts with their details for a prompt
   * Used for displaying agent tools in the tool list
   */
  static async findByPromptIdWithDetails(
    promptId: string,
  ): Promise<PromptAgentWithDetails[]> {
    logger.debug(
      { promptId },
      "PromptAgentModel.findByPromptIdWithDetails: fetching agents with details",
    );

    const results = await db
      .select({
        id: schema.promptAgentsTable.id,
        promptId: schema.promptAgentsTable.promptId,
        agentPromptId: schema.promptAgentsTable.agentPromptId,
        createdAt: schema.promptAgentsTable.createdAt,
        // Agent prompt details
        name: schema.promptsTable.name,
        systemPrompt: schema.promptsTable.systemPrompt,
        // Profile details
        profileId: schema.agentsTable.id,
        profileName: schema.agentsTable.name,
      })
      .from(schema.promptAgentsTable)
      .innerJoin(
        schema.promptsTable,
        eq(schema.promptAgentsTable.agentPromptId, schema.promptsTable.id),
      )
      .innerJoin(
        schema.agentsTable,
        eq(schema.promptsTable.agentId, schema.agentsTable.id),
      )
      .where(
        and(
          eq(schema.promptAgentsTable.promptId, promptId),
          eq(schema.promptsTable.isActive, true),
        ),
      );

    return results;
  }

  /**
   * Sync agents for a prompt - removes agents not in the list and adds new ones
   */
  static async sync(params: {
    promptId: string;
    agentPromptIds: string[];
  }): Promise<{
    added: string[];
    removed: string[];
  }> {
    const { promptId, agentPromptIds } = params;

    logger.debug(
      { promptId, agentPromptIds },
      "PromptAgentModel.sync: syncing agents for prompt",
    );

    // Get current assignments
    const current = await PromptAgentModel.findByPromptId(promptId);
    const currentIds = new Set(current.map((c) => c.agentPromptId));
    const newIds = new Set(agentPromptIds);

    // Find agents to remove
    const toRemove = current.filter((c) => !newIds.has(c.agentPromptId));
    // Find agents to add
    const toAdd = agentPromptIds.filter((id) => !currentIds.has(id));

    // Remove old assignments (cascade will delete associated tools)
    if (toRemove.length > 0) {
      const idsToRemove = toRemove.map((c) => c.agentPromptId);
      await db
        .delete(schema.promptAgentsTable)
        .where(
          and(
            eq(schema.promptAgentsTable.promptId, promptId),
            inArray(schema.promptAgentsTable.agentPromptId, idsToRemove),
          ),
        );
    }

    // Add new assignments and create tools
    if (toAdd.length > 0) {
      const insertedRows = await db
        .insert(schema.promptAgentsTable)
        .values(
          toAdd.map((agentPromptId) => ({
            promptId,
            agentPromptId,
          })),
        )
        .returning();

      // Get prompt details for all added agents
      const promptDetails = await db
        .select({
          id: schema.promptsTable.id,
          name: schema.promptsTable.name,
          systemPrompt: schema.promptsTable.systemPrompt,
        })
        .from(schema.promptsTable)
        .where(inArray(schema.promptsTable.id, toAdd));

      const promptDetailsMap = new Map(promptDetails.map((p) => [p.id, p]));

      // Create tools for each new prompt_agent
      for (const row of insertedRows) {
        const promptDetail = promptDetailsMap.get(row.agentPromptId);
        if (promptDetail) {
          await ToolModel.createAgentDelegationTool({
            promptAgentId: row.id,
            agentName: promptDetail.name,
            description: promptDetail.systemPrompt,
          });
        }
      }
    }

    return {
      added: toAdd,
      removed: toRemove.map((c) => c.agentPromptId),
    };
  }

  /**
   * Bulk assign agents to a prompt
   * Ignores duplicates
   */
  static async bulkAssign(params: {
    promptId: string;
    agentPromptIds: string[];
  }): Promise<{ assigned: string[]; duplicates: string[] }> {
    const { promptId, agentPromptIds } = params;

    logger.debug(
      { promptId, agentPromptIds },
      "PromptAgentModel.bulkAssign: bulk assigning agents to prompt",
    );

    // Get current assignments to avoid duplicates
    const current = await PromptAgentModel.findByPromptId(promptId);
    const currentIds = new Set(current.map((c) => c.agentPromptId));

    const toAssign = agentPromptIds.filter((id) => !currentIds.has(id));
    const duplicates = agentPromptIds.filter((id) => currentIds.has(id));

    if (toAssign.length > 0) {
      const insertedRows = await db
        .insert(schema.promptAgentsTable)
        .values(
          toAssign.map((agentPromptId) => ({
            promptId,
            agentPromptId,
          })),
        )
        .returning();

      // Get prompt details for all assigned agents
      const promptDetails = await db
        .select({
          id: schema.promptsTable.id,
          name: schema.promptsTable.name,
          systemPrompt: schema.promptsTable.systemPrompt,
        })
        .from(schema.promptsTable)
        .where(inArray(schema.promptsTable.id, toAssign));

      const promptDetailsMap = new Map(promptDetails.map((p) => [p.id, p]));

      // Create tools for each new prompt_agent
      for (const row of insertedRows) {
        const promptDetail = promptDetailsMap.get(row.agentPromptId);
        if (promptDetail) {
          await ToolModel.createAgentDelegationTool({
            promptAgentId: row.id,
            agentName: promptDetail.name,
            description: promptDetail.systemPrompt,
          });
        }
      }
    }

    return {
      assigned: toAssign,
      duplicates,
    };
  }

  /**
   * Get all prompt-agent connections for an organization
   * Used for canvas visualization of agent relationships
   * Filters by user's team access unless they're an admin
   */
  static async findAllByOrganizationId(
    organizationId: string,
    userId: string,
    isAgentAdmin: boolean,
  ): Promise<Array<{ id: string; promptId: string; agentPromptId: string }>> {
    logger.debug(
      { organizationId, userId, isAgentAdmin },
      "PromptAgentModel.findAllByOrganizationId: fetching all connections for organization",
    );

    const results = await db
      .select({
        id: schema.promptAgentsTable.id,
        promptId: schema.promptAgentsTable.promptId,
        agentPromptId: schema.promptAgentsTable.agentPromptId,
        // Include agentId for filtering
        agentId: schema.promptsTable.agentId,
      })
      .from(schema.promptAgentsTable)
      .innerJoin(
        schema.promptsTable,
        eq(schema.promptAgentsTable.promptId, schema.promptsTable.id),
      )
      .where(eq(schema.promptsTable.organizationId, organizationId));

    // Admins see all connections
    if (isAgentAdmin) {
      return results.map(({ id, promptId, agentPromptId }) => ({
        id,
        promptId,
        agentPromptId,
      }));
    }

    // For non-admins, batch-load accessible agent IDs and filter in memory
    const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
      userId,
      false,
    );
    const accessibleAgentIdSet = new Set(accessibleAgentIds);

    return results
      .filter((r) => r.agentId && accessibleAgentIdSet.has(r.agentId))
      .map(({ id, promptId, agentPromptId }) => ({
        id,
        promptId,
        agentPromptId,
      }));
  }

  /**
   * Check if a prompt has a specific agent assigned
   */
  static async hasAgent(params: {
    promptId: string;
    agentPromptId: string;
  }): Promise<boolean> {
    const { promptId, agentPromptId } = params;

    const [result] = await db
      .select({ id: schema.promptAgentsTable.id })
      .from(schema.promptAgentsTable)
      .where(
        and(
          eq(schema.promptAgentsTable.promptId, promptId),
          eq(schema.promptAgentsTable.agentPromptId, agentPromptId),
        ),
      )
      .limit(1);

    return !!result;
  }
}

export default PromptAgentModel;
