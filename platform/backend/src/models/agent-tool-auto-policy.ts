import logger from "@/logging";
import { secretManager } from "@/secretsmanager";
import { policyConfigSubagent } from "@/subagents";
import AgentToolModel from "./agent-tool";
import ChatApiKeyModel from "./chat-api-key";
import McpServerModel from "./mcp-server";

type PolicyConfig = {
  allowUsageWhenUntrustedDataIsPresent: boolean;
  toolResultTreatment: "trusted" | "sanitize_with_dual_llm" | "untrusted";
  reasoning: string;
};

interface AutoPolicyResult {
  success: boolean;
  config?: PolicyConfig;
  error?: string;
}

interface BulkAutoPolicyResult {
  success: boolean;
  results: Array<
    {
      agentToolId: string;
    } & AutoPolicyResult
  >;
}

/**
 * Auto-configure security policies for agent-tool assignments using LLM analysis
 */
export class AgentToolAutoPolicyService {
  /**
   * Check if auto-policy service is available for an organization
   * Requires Anthropic API key to be configured as default chat API key
   */
  async isAvailable(organizationId: string): Promise<boolean> {
    logger.debug(
      { organizationId },
      "isAvailable: checking auto-policy availability",
    );

    const chatApiKey = await ChatApiKeyModel.findOrganizationDefault(
      organizationId,
      "anthropic",
    );

    if (!chatApiKey?.secretId) {
      logger.debug(
        { organizationId },
        "isAvailable: no Anthropic API key configured",
      );
      return false;
    }

    const secret = await secretManager().getSecret(chatApiKey.secretId);
    const available = !!secret?.secret?.apiKey;
    logger.debug({ organizationId, available }, "isAvailable: result");
    return available;
  }

  /**
   * Get Anthropic API key for an organization from default chat API key
   */
  private async getAnthropicApiKey(
    organizationId: string,
  ): Promise<string | null> {
    logger.debug({ organizationId }, "getAnthropicApiKey: fetching API key");

    const chatApiKey = await ChatApiKeyModel.findOrganizationDefault(
      organizationId,
      "anthropic",
    );

    if (!chatApiKey?.secretId) {
      logger.debug(
        { organizationId },
        "getAnthropicApiKey: no default Anthropic chat API key configured",
      );
      return null;
    }

    const secret = await secretManager().getSecret(chatApiKey.secretId);
    if (!secret?.secret?.apiKey) {
      logger.debug({ organizationId }, "getAnthropicApiKey: secret not found");
      return null;
    }

    logger.debug({ organizationId }, "getAnthropicApiKey: API key retrieved");
    return secret.secret.apiKey as string;
  }

  /**
   * Analyze a tool and determine appropriate security policies using the PolicyConfigSubagent
   */
  private async analyzeTool(
    tool: Parameters<typeof policyConfigSubagent.analyze>[0]["tool"],
    mcpServerName: string | null,
    anthropicApiKey: string,
    organizationId: string,
  ): Promise<PolicyConfig> {
    logger.info(
      {
        toolName: tool.name,
        mcpServerName,
        subagent: "PolicyConfigSubagent",
      },
      "analyzeTool: delegating to PolicyConfigSubagent",
    );

    try {
      // Delegate to the PolicyConfigSubagent
      const result = await policyConfigSubagent.analyze({
        tool,
        mcpServerName,
        anthropicApiKey,
        organizationId,
      });

      logger.info(
        {
          toolName: tool.name,
          mcpServerName,
          config: result,
        },
        "analyzeTool: PolicyConfigSubagent analysis completed",
      );

      return result;
    } catch (error) {
      logger.error(
        {
          toolName: tool.name,
          mcpServerName,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "analyzeTool: PolicyConfigSubagent analysis failed",
      );
      throw error;
    }
  }

  /**
   * Auto-configure policies for a specific agent-tool assignment
   */
  async configurePoliciesForAgentTool(
    agentToolId: string,
    organizationId: string,
  ): Promise<AutoPolicyResult> {
    logger.info(
      { agentToolId, organizationId },
      "configurePoliciesForAgentTool: starting",
    );

    // Check if API key is available
    const anthropicApiKey = await this.getAnthropicApiKey(organizationId);
    if (!anthropicApiKey) {
      logger.warn(
        { agentToolId, organizationId },
        "configurePoliciesForAgentTool: no API key",
      );
      return {
        success: false,
        error:
          "Default Anthropic chat API key not configured for this organization",
      };
    }

    try {
      // Get agent-tool assignment with tool details
      const agentTools = await AgentToolModel.findAll();
      const assignment = agentTools.find((at) => at.id === agentToolId);

      if (!assignment) {
        logger.warn(
          { agentToolId },
          "configurePoliciesForAgentTool: assignment not found",
        );
        return {
          success: false,
          error: "Agent-tool assignment not found",
        };
      }

      // Get MCP server name if available
      let mcpServerName: string | null = null;
      if (assignment.tool.mcpServerId) {
        const mcpServer = await McpServerModel.findById(
          assignment.tool.mcpServerId,
        );
        mcpServerName = mcpServer?.name || null;
      }

      logger.debug(
        { agentToolId, toolName: assignment.tool.name, mcpServerName },
        "configurePoliciesForAgentTool: fetched tool details",
      );

      // Analyze tool and get policy configuration using PolicyConfigSubagent
      const policyConfig = await this.analyzeTool(
        {
          ...assignment.tool,
          agentId: null, // Tools from agent assignments don't have agentId field
        },
        mcpServerName,
        anthropicApiKey,
        organizationId,
      );

      // Update agent-tool with new configuration including reasoning
      await AgentToolModel.update(agentToolId, {
        allowUsageWhenUntrustedDataIsPresent:
          policyConfig.allowUsageWhenUntrustedDataIsPresent,
        toolResultTreatment: policyConfig.toolResultTreatment,
        policiesAutoConfiguredAt: new Date(),
        policiesAutoConfiguredReasoning: policyConfig.reasoning,
      });

      logger.info(
        { agentToolId, policyConfig },
        "configurePoliciesForAgentTool: policies updated successfully",
      );

      return {
        success: true,
        config: policyConfig,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error(
        {
          agentToolId,
          organizationId,
          error: errorMessage,
          stack: errorStack,
        },
        "configurePoliciesForAgentTool: failed to auto-configure policies",
      );
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Configure a single agent-tool with timeout and loading state management
   * This is the unified method used by both manual button clicks and automatic tool assignment
   */
  async configurePoliciesForAgentToolWithTimeout(
    agentToolId: string,
    organizationId: string,
  ): Promise<AutoPolicyResult & { timedOut?: boolean }> {
    const db = (await import("@/database")).default;
    const schema = await import("@/database/schemas");
    const { eq } = await import("drizzle-orm");

    logger.info(
      { agentToolId, organizationId },
      "configurePoliciesForAgentToolWithTimeout: starting",
    );

    try {
      // Set loading timestamp to show loading state in UI
      await db
        .update(schema.agentToolsTable)
        .set({ policiesAutoConfiguringStartedAt: new Date() })
        .where(eq(schema.agentToolsTable.id, agentToolId));

      // Create a 10-second timeout promise
      const timeoutPromise = new Promise<{
        success: false;
        timedOut: true;
        error: string;
      }>((resolve) => {
        setTimeout(() => {
          resolve({
            success: false,
            timedOut: true,
            error: "Auto-configure timed out (>10s)",
          });
        }, 10000);
      });

      // Race between auto-configure and timeout
      const result = await Promise.race([
        this.configurePoliciesForAgentTool(agentToolId, organizationId).then(
          (res) => ({ ...res, timedOut: false }),
        ),
        timeoutPromise,
      ]);

      // Handle the result and clear loading timestamp
      if (result.timedOut) {
        // Just clear the loading timestamp, let background operation continue
        await db
          .update(schema.agentToolsTable)
          .set({ policiesAutoConfiguringStartedAt: null })
          .where(eq(schema.agentToolsTable.id, agentToolId));

        logger.warn(
          { agentToolId, organizationId },
          "configurePoliciesForAgentToolWithTimeout: timed out, continuing in background",
        );
      } else if (result.success) {
        // Success - clear loading timestamp (policiesAutoConfiguredAt already set by configurePoliciesForAgentTool)
        await db
          .update(schema.agentToolsTable)
          .set({ policiesAutoConfiguringStartedAt: null })
          .where(eq(schema.agentToolsTable.id, agentToolId));

        logger.info(
          { agentToolId, organizationId },
          "configurePoliciesForAgentToolWithTimeout: completed successfully",
        );
      } else {
        // Failed - clear both timestamps and reasoning
        await db
          .update(schema.agentToolsTable)
          .set({
            policiesAutoConfiguringStartedAt: null,
            policiesAutoConfiguredAt: null,
            policiesAutoConfiguredReasoning: null,
          })
          .where(eq(schema.agentToolsTable.id, agentToolId));

        logger.warn(
          {
            agentToolId,
            organizationId,
            error: result.error,
          },
          "configurePoliciesForAgentToolWithTimeout: failed",
        );
      }

      return result;
    } catch (error) {
      // On error, clear both timestamps and reasoning
      await db
        .update(schema.agentToolsTable)
        .set({
          policiesAutoConfiguringStartedAt: null,
          policiesAutoConfiguredAt: null,
          policiesAutoConfiguredReasoning: null,
        })
        .where(eq(schema.agentToolsTable.id, agentToolId))
        .catch(() => {
          /* ignore cleanup errors */
        });

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        { agentToolId, organizationId, error: errorMessage },
        "configurePoliciesForAgentToolWithTimeout: unexpected error",
      );

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Auto-configure policies for multiple agent-tool assignments in bulk
   * Uses the unified timeout logic for consistent behavior
   */
  async configurePoliciesForAgentTools(
    agentToolIds: string[],
    organizationId: string,
  ): Promise<BulkAutoPolicyResult> {
    logger.info(
      { organizationId, count: agentToolIds.length },
      "configurePoliciesForAgentTools: starting bulk auto-configure",
    );

    // Check if API key is available
    const available = await this.isAvailable(organizationId);
    if (!available) {
      logger.warn(
        { organizationId },
        "configurePoliciesForAgentTools: service not available",
      );
      return {
        success: false,
        results: agentToolIds.map((id) => ({
          agentToolId: id,
          success: false,
          error:
            "Default Anthropic chat API key not configured for this organization",
        })),
      };
    }

    // Process all tools in parallel using the unified timeout logic
    logger.info(
      { organizationId, count: agentToolIds.length },
      "configurePoliciesForAgentTools: processing tools in parallel",
    );
    const results = await Promise.all(
      agentToolIds.map(async (agentToolId) => {
        const result = await this.configurePoliciesForAgentToolWithTimeout(
          agentToolId,
          organizationId,
        );
        return {
          agentToolId,
          ...result,
        };
      }),
    );

    const allSuccess = results.every((r) => r.success);
    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    logger.info(
      {
        organizationId,
        total: results.length,
        successCount,
        failureCount,
        allSuccess,
      },
      "configurePoliciesForAgentTools: bulk auto-configure completed",
    );

    return {
      success: allSuccess,
      results,
    };
  }
}

// Singleton instance
export const agentToolAutoPolicyService = new AgentToolAutoPolicyService();
