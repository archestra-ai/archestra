import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import { policyConfigSubagent } from "@/subagents";
import ChatApiKeyModel from "./chat-api-key";
import ToolModel from "./tool";
import ToolInvocationPolicyModel from "./tool-invocation-policy";
import TrustedDataPolicyModel from "./trusted-data-policy";

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
      toolId: string;
    } & AutoPolicyResult
  >;
}

/**
 * Auto-configure security policies tools using LLM analysis
 */
export class ToolAutoPolicyService {
  /**
   * Check if auto-policy service is available for an organization
   * Requires Anthropic API key to be configured (org-wide scope)
   */
  async isAvailable(organizationId: string): Promise<boolean> {
    logger.debug(
      { organizationId },
      "isAvailable: checking auto-policy availability",
    );

    const chatApiKey = await ChatApiKeyModel.findByScope(
      organizationId,
      "anthropic",
      "org_wide",
    );

    if (!chatApiKey?.secretId) {
      logger.debug(
        { organizationId },
        "isAvailable: no org-wide Anthropic API key configured",
      );
      return false;
    }

    const secret = await secretManager().getSecret(chatApiKey.secretId);
    const available = !!secret?.secret?.apiKey;
    logger.debug({ organizationId, available }, "isAvailable: result");
    return available;
  }

  /**
   * Get Anthropic API key for an organization from org-wide chat API key
   */
  private async getAnthropicApiKey(
    organizationId: string,
  ): Promise<string | null> {
    logger.debug({ organizationId }, "getAnthropicApiKey: fetching API key");

    const chatApiKey = await ChatApiKeyModel.findByScope(
      organizationId,
      "anthropic",
      "org_wide",
    );

    if (!chatApiKey?.secretId) {
      logger.debug(
        { organizationId },
        "getAnthropicApiKey: no org-wide Anthropic chat API key configured",
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
   * Auto-configure policies for a specific tool
   */
  async configurePoliciesForTool(
    toolId: string,
    organizationId: string,
  ): Promise<AutoPolicyResult> {
    logger.info(
      { toolId, organizationId },
      "configurePoliciesForTool: starting",
    );

    // Check if API key is available
    const anthropicApiKey = await this.getAnthropicApiKey(organizationId);
    if (!anthropicApiKey) {
      logger.warn(
        { toolId, organizationId },
        "configurePoliciesForTool: no API key",
      );
      return {
        success: false,
        error:
          "Organization-wide Anthropic API key not configured in LLM API Keys settings",
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
        anthropicApiKey,
        organizationId,
      );

      // Create/upsert call policy (tool invocation policy)
      const callPolicyAction = policyConfig.allowUsageWhenUntrustedDataIsPresent
        ? "allow_when_context_is_untrusted"
        : "block_always";
      await ToolInvocationPolicyModel.bulkUpsertDefaultPolicy(
        [toolId],
        callPolicyAction,
      );

      // Create/upsert result policy (trusted data policy)
      const resultPolicyActionMap = {
        trusted: "mark_as_trusted",
        untrusted: "block_always",
        sanitize_with_dual_llm: "sanitize_with_dual_llm",
      } as const;
      const resultPolicyAction =
        resultPolicyActionMap[policyConfig.toolResultTreatment];
      await TrustedDataPolicyModel.bulkUpsertDefaultPolicy(
        [toolId],
        resultPolicyAction,
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
        this.configurePoliciesForTool(toolId, organizationId).then((res) => ({
          ...res,
          timedOut: false,
        })),
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
  ): Promise<BulkAutoPolicyResult> {
    logger.info(
      { organizationId, count: toolIds.length },
      "configurePoliciesForTools: starting bulk auto-configure",
    );

    // Check if API key is available
    const available = await this.isAvailable(organizationId);
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
          error:
            "Organization-wide Anthropic API key not configured in LLM API Keys settings",
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
}

// Singleton instance
export const toolAutoPolicyService = new ToolAutoPolicyService();
