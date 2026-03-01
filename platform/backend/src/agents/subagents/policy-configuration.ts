import { BUILT_IN_AGENT_IDS } from "@shared";
import {
  type SupportedProvider,
  SupportedProvidersSchema,
} from "@shared/model-constants";
import { generateObject } from "ai";
import {
  createDirectLLMModel,
  resolveProviderApiKey,
} from "@/clients/llm-client";
import logger from "@/logging";
import {
  AgentModel,
  ApiKeyModelModel,
  ToolInvocationPolicyModel,
  ToolModel,
  TrustedDataPolicyModel,
} from "@/models";
import type { Tool } from "@/types";
import { type PolicyConfig, PolicyConfigSchema } from "@/types";

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
export class PolicyConfigurationService {
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
      const mcpServerName = tool.catalog?.name || null;

      logger.debug(
        { toolId, toolName: tool.name, mcpServerName },
        "configurePoliciesForTool: fetched tool details",
      );

      // Analyze tool and get policy configuration
      const policyConfig = await this.analyzeTool(
        tool,
        mcpServerName,
        resolved.provider,
        resolved.apiKey,
        resolved.modelName,
        resolved.baseUrl,
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
   * Analyze a tool and determine appropriate security policies using LLM
   */
  private async analyzeTool(
    tool: Pick<Tool, "id" | "name" | "description" | "parameters">,
    mcpServerName: string | null,
    provider: SupportedProvider,
    apiKey: string,
    modelName: string,
    baseUrl: string | null,
  ): Promise<PolicyConfig> {
    logger.info(
      {
        toolName: tool.name,
        mcpServerName,
        provider,
        model: modelName,
      },
      "analyzeTool: starting policy analysis",
    );

    // Fetch the built-in agent's system prompt for the analysis template
    const builtInAgent = await AgentModel.getBuiltInAgent(
      BUILT_IN_AGENT_IDS.POLICY_CONFIG,
    );
    if (!builtInAgent?.systemPrompt) {
      throw new Error(
        "Policy configuration built-in agent not found or has no system prompt",
      );
    }

    const model = createDirectLLMModel({
      provider,
      apiKey,
      modelName,
      baseUrl,
    });
    const prompt = buildPrompt(builtInAgent.systemPrompt, tool, mcpServerName);

    try {
      const result = await generateObject({
        model,
        schema: PolicyConfigSchema,
        prompt,
      });

      logger.info(
        {
          toolName: tool.name,
          mcpServerName,
          config: result.object,
        },
        "analyzeTool: analysis completed",
      );

      return result.object;
    } catch (error) {
      logger.error(
        {
          toolName: tool.name,
          mcpServerName,
          provider,
          model: modelName,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "analyzeTool: analysis failed",
      );
      throw error;
    }
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
    provider: SupportedProvider;
    apiKey: string;
    modelName: string;
    baseUrl: string | null;
  } | null> {
    const providers = SupportedProvidersSchema.options;

    for (const provider of providers) {
      const { apiKey, chatApiKeyId, baseUrl } = await resolveProviderApiKey({
        organizationId,
        userId,
        provider,
      });

      if (!apiKey || !chatApiKeyId) continue;

      const bestModel = await ApiKeyModelModel.getBestModel(chatApiKeyId);
      if (!bestModel) continue;

      return { provider, apiKey, modelName: bestModel.modelId, baseUrl };
    }

    return null;
  }
}

/**
 * Build the analysis prompt by substituting tool metadata into the template.
 * The template comes from the built-in agent's systemPrompt.
 */
function buildPrompt(
  template: string,
  tool: Pick<Tool, "name" | "description" | "parameters">,
  mcpServerName: string | null,
): string {
  return template
    .replace("{tool.name}", tool.name)
    .replace(
      "{tool.description}",
      tool.description || "No description provided",
    )
    .replace("{mcpServerName}", mcpServerName || "Unknown")
    .replace("{tool.parameters}", JSON.stringify(tool.parameters, null, 2));
}

export const policyConfigurationService = new PolicyConfigurationService();
