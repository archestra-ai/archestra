import { policyConfigSubagent } from "@/agents/subagents";
import { resolveProviderApiKey } from "@/clients/llm-client";
import logger from "@/logging";
import { ApiKeyModelModel } from "@/models";
import {
  type SupportedChatProvider,
  SupportedChatProviderSchema,
} from "@/types";
import ToolModel from "./tool";
import ToolInvocationPolicyModel from "./tool-invocation-policy";
import TrustedDataPolicyModel from "./trusted-data-policy";

type PolicyConfig = {
  toolInvocationAction:
    | "allow_when_context_is_untrusted"
    | "block_when_context_is_untrusted"
    | "block_always";
  trustedDataAction:
    | "mark_as_trusted"
    | "mark_as_untrusted"
    | "sanitize_with_dual_llm"
    | "block_always";
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
      toolId: string;
    } & AutoPolicyResult
  >;
}

/**
 * Auto-configure security policies tools using LLM analysis
 */
export class ToolAutoPolicyService {
  /**
   * Check if auto-policy service is available for an organization.
   * Requires at least one LLM API key to be configured via the UI.
   */
  async isAvailable(organizationId: string, userId?: string): Promise<boolean> {
    logger.debug(
      { organizationId, userId },
      "isAvailable: checking auto-policy availability",
    );

    const result = await this.resolveProviderAndKey(organizationId, userId);
    const available = result !== null;

    logger.debug({ organizationId, available }, "isAvailable: result");
    return available;
  }

  /**
   * Analyze a tool and determine appropriate security policies using the PolicyConfigSubagent
   */
  private async analyzeTool(
    tool: Parameters<typeof policyConfigSubagent.analyze>[0]["tool"],
    mcpServerName: string | null,
    provider: SupportedChatProvider,
    apiKey: string,
    modelName: string,
    organizationId: string,
  ): Promise<PolicyConfig> {
    logger.info(
      {
        toolName: tool.name,
        mcpServerName,
        provider,
        subagent: "PolicyConfigSubagent",
      },
      "analyzeTool: delegating to PolicyConfigSubagent",
    );

    try {
      // Delegate to the PolicyConfigSubagent
      const result = await policyConfigSubagent.analyze({
        tool,
        mcpServerName,
        provider,
        apiKey,
        modelName,
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
   * Auto-configure policies for a specific tool
   */
  async configurePoliciesForTool(
    toolId: string,
    organizationId: string,
    userId?: string,
  ): Promise<AutoPolicyResult> {
    logger.info(
      { toolId, organizationId, userId },
      "configurePoliciesForTool: starting",
    );

    // Resolve provider and API key
    const resolved = await this.resolveProviderAndKey(organizationId, userId);
    if (!resolved) {
      logger.warn(
        { toolId, organizationId },
        "configurePoliciesForTool: no API key",
      );
      return {
        success: false,
        error: "LLM API key not configured in LLM API Keys settings",
      };
    }

    try {
      // Get all tools as admin to bypass access control
      const tools = await ToolModel.findAll(undefined, true);
      const tool = tools.find((t) => t.id === toolId);

      if (!tool) {
        logger.warn({ toolId }, "configurePoliciesForTool: tool not found");
        return {
          success: false,
          error: "Tool not found",
        };
      }

      // Get MCP server name from joined data
      const mcpServerName = tool.mcpServer?.name || null;

      logger.debug(
        { toolId, toolName: tool.name, mcpServerName },
        "configurePoliciesForTool: fetched tool details",
      );

      // Analyze tool and get policy configuration using PolicyConfigSubagent
      const policyConfig = await this.analyzeTool(
        tool,
        mcpServerName,
        resolved.provider,
        resolved.apiKey,
        resolved.modelName,
        organizationId,
      );

      // Create/upsert call policy (tool invocation policy)
      await ToolInvocationPolicyModel.bulkUpsertDefaultPolicy(
        [toolId],
        policyConfig.toolInvocationAction,
      );

      // Create/upsert result policy (trusted data policy)
      await TrustedDataPolicyModel.bulkUpsertDefaultPolicy(
        [toolId],
        policyConfig.trustedDataAction,
      );

      // Update tool with timestamps and reasoning for tracking
      await ToolModel.update(toolId, {
        policiesAutoConfiguredAt: new Date(),
        policiesAutoConfiguredReasoning: policyConfig.reasoning,
      });

      logger.info(
        { toolId, policyConfig },
        "configurePoliciesForTool: policies created successfully",
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
          toolId,
          organizationId,
          error: errorMessage,
          stack: errorStack,
        },
        "configurePoliciesForTool: failed to auto-configure policies",
      );
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Configure a single tool with timeout and loading state management
   * This is the unified method used by both manual button clicks and automatic tool assignment
   */
  async configurePoliciesForToolWithTimeout(
    toolId: string,
    organizationId: string,
    userId?: string,
  ): Promise<AutoPolicyResult & { timedOut?: boolean }> {
    const db = (await import("@/database")).default;
    const schema = await import("@/database/schemas");
    const { eq } = await import("drizzle-orm");

    logger.info(
      { toolId, organizationId },
      "configurePoliciesForToolWithTimeout: starting",
    );

    try {
      // Set loading timestamp to show loading state in UI
      await db
        .update(schema.toolsTable)
        .set({ policiesAutoConfiguringStartedAt: new Date() })
        .where(eq(schema.toolsTable.id, toolId));

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
        this.configurePoliciesForTool(toolId, organizationId, userId).then(
          (res) => ({
            ...res,
            timedOut: false,
          }),
        ),
        timeoutPromise,
      ]);

      // Handle the result and clear loading timestamp
      if (result.timedOut) {
        // Just clear the loading timestamp, let background operation continue
        await db
          .update(schema.toolsTable)
          .set({ policiesAutoConfiguringStartedAt: null })
          .where(eq(schema.toolsTable.id, toolId));

        logger.warn(
          { toolId, organizationId },
          "configurePoliciesForToolWithTimeout: timed out, continuing in background",
        );
      } else if (result.success) {
        // Success - clear loading timestamp (policiesAutoConfiguredAt already set by configurePoliciesForTool)
        await db
          .update(schema.toolsTable)
          .set({ policiesAutoConfiguringStartedAt: null })
          .where(eq(schema.toolsTable.id, toolId));

        logger.info(
          { toolId, organizationId },
          "configurePoliciesForToolWithTimeout: completed successfully",
        );
      } else {
        // Failed - clear both timestamps and reasoning
        await db
          .update(schema.toolsTable)
          .set({
            policiesAutoConfiguringStartedAt: null,
            policiesAutoConfiguredAt: null,
            policiesAutoConfiguredReasoning: null,
          })
          .where(eq(schema.toolsTable.id, toolId));

        logger.warn(
          {
            toolId,
            organizationId,
            error: result.error,
          },
          "configurePoliciesForToolWithTimeout: failed",
        );
      }

      return result;
    } catch (error) {
      // On error, clear both timestamps and reasoning
      await db
        .update(schema.toolsTable)
        .set({
          policiesAutoConfiguringStartedAt: null,
          policiesAutoConfiguredAt: null,
          policiesAutoConfiguredReasoning: null,
        })
        .where(eq(schema.toolsTable.id, toolId))
        .catch(() => {
          /* ignore cleanup errors */
        });

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        { toolId, organizationId, error: errorMessage },
        "configurePoliciesForToolWithTimeout: unexpected error",
      );

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Auto-configure policies for multiple tools in bulk
   * Uses the unified timeout logic for consistent behavior
   */
  async configurePoliciesForTools(
    toolIds: string[],
    organizationId: string,
    userId?: string,
  ): Promise<BulkAutoPolicyResult> {
    logger.info(
      { organizationId, count: toolIds.length },
      "configurePoliciesForTools: starting bulk auto-configure",
    );

    // Check if API key is available
    const available = await this.isAvailable(organizationId, userId);
    if (!available) {
      logger.warn(
        { organizationId },
        "configurePoliciesForTools: service not available",
      );
      return {
        success: false,
        results: toolIds.map((id) => ({
          toolId: id,
          success: false,
          error: "LLM API key not configured in LLM API Keys settings",
        })),
      };
    }

    // Process all tools in parallel using the unified timeout logic
    logger.info(
      { organizationId, count: toolIds.length },
      "configurePoliciesForTools: processing tools in parallel",
    );
    const results = await Promise.all(
      toolIds.map(async (toolId) => {
        const result = await this.configurePoliciesForToolWithTimeout(
          toolId,
          organizationId,
          userId,
        );
        return {
          toolId,
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
      "configurePoliciesForTools: bulk auto-configure completed",
    );

    return {
      success: allSuccess,
      results,
    };
  }

  /**
   * Resolve provider, API key, and best model for auto-policy operations.
   * Uses resolveSmartDefaultProvider to find a DB-configured key,
   * then ApiKeyModelModel.getBestModel to determine the model.
   */
  private async resolveProviderAndKey(
    organizationId: string,
    userId?: string,
  ): Promise<{
    provider: SupportedChatProvider;
    apiKey: string;
    modelName: string;
  } | null> {
    const providers = SupportedChatProviderSchema.options;

    for (const provider of providers) {
      const { apiKey, chatApiKeyId } = await resolveProviderApiKey({
        organizationId,
        userId,
        provider,
      });

      if (!apiKey || !chatApiKeyId) continue;

      const bestModel = await ApiKeyModelModel.getBestModel(chatApiKeyId);
      if (!bestModel) continue;

      return { provider, apiKey, modelName: bestModel.modelId };
    }

    return null;
  }
}

// Singleton instance
export const toolAutoPolicyService = new ToolAutoPolicyService();
