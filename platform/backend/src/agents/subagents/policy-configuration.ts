import {
  BUILT_IN_AGENT_IDS,
  buildPolicyConfigSystemPromptContext,
  isSupportedProvider,
  type SupportedProvider,
} from "@shared";
import { generateObject } from "ai";
import { createLLMModel, detectProviderFromModel } from "@/clients/llm-client";
import logger from "@/logging";
import {
  AgentModel,
  InternalMcpCatalogModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ToolInvocationPolicyModel,
  ToolModel,
  TrustedDataPolicyModel,
} from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { renderSystemPrompt } from "@/templating";
import type { Tool } from "@/types";
import {
  mapToolInvocationAction,
  mapTrustedDataAction,
  type PolicyConfig,
  PolicyConfigSchema,
} from "@/types";
import { resolveSmartDefaultLlm } from "@/utils/llm-resolution";

interface ResolvedLlm {
  provider: SupportedProvider;
  apiKey: string | undefined;
  modelName: string;
  baseUrl: string | null;
}

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
   * Resolve the LLM provider/key using the built-in agent's configured
   * llmApiKeyId/llmModel, falling back to the org-wide smart default.
   */
  async resolveLlm(params: {
    organizationId: string;
    userId?: string;
  }): Promise<ResolvedLlm | null> {
    const { organizationId } = params;

    // Check the built-in agent's own LLM configuration first
    const builtInAgent = await AgentModel.getBuiltInAgent(
      BUILT_IN_AGENT_IDS.POLICY_CONFIG,
      organizationId,
    );

    if (builtInAgent) {
      const agentLlm = await resolveAgentLlm(builtInAgent);
      if (agentLlm) return agentLlm;
    }

    return resolveSmartDefaultLlm(params);
  }

  /**
   * Auto-configure policies for a specific tool.
   * Pass `resolvedLlm` to skip redundant LLM resolution in bulk flows.
   */
  async configurePoliciesForTool(params: {
    toolId: string;
    organizationId: string;
    userId?: string;
    resolvedLlm?: ResolvedLlm;
  }): Promise<AutoPolicyResult> {
    const { toolId, organizationId, userId, resolvedLlm } = params;

    logger.info(
      { toolId, organizationId, userId },
      "configurePoliciesForTool: starting",
    );

    // Use pre-resolved LLM or resolve now
    const resolved =
      resolvedLlm ?? (await resolveSmartDefaultLlm({ organizationId, userId }));
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
      let tool: Tool | null;
      try {
        tool = await ToolModel.findById(toolId, undefined, true);
      } catch {
        tool = null;
      }

      if (!tool) {
        logger.warn({ toolId }, "configurePoliciesForTool: tool not found");
        return {
          success: false,
          error: "Tool not found",
        };
      }

      // Look up catalog name for the MCP server context
      let mcpServerName: string | null = null;
      if (tool.catalogId) {
        const catalog = await InternalMcpCatalogModel.findById(tool.catalogId, {
          expandSecrets: false,
        });
        mcpServerName = catalog?.name ?? null;
      }

      logger.debug(
        { toolId, toolName: tool.name, mcpServerName },
        "configurePoliciesForTool: fetched tool details",
      );

      // Analyze tool and get policy configuration
      const policyConfig = await this.analyzeTool({
        tool,
        mcpServerName,
        provider: resolved.provider,
        apiKey: resolved.apiKey,
        modelName: resolved.modelName,
        baseUrl: resolved.baseUrl,
        organizationId,
      });

      // Map LLM-facing enum values to database-stored values
      const dbInvocationAction = mapToolInvocationAction(
        policyConfig.toolInvocationAction,
      );
      const dbTrustedDataAction = mapTrustedDataAction(
        policyConfig.trustedDataAction,
      );

      // Create/upsert call policy (tool invocation policy)
      await ToolInvocationPolicyModel.bulkUpsertDefaultPolicy(
        [toolId],
        dbInvocationAction,
      );

      // Create/upsert result policy (trusted data policy)
      await TrustedDataPolicyModel.bulkUpsertDefaultPolicy(
        [toolId],
        dbTrustedDataAction,
      );

      // Update tool with timestamps, reasoning, and model for tracking
      await ToolModel.update(toolId, {
        policiesAutoConfiguredAt: new Date(),
        policiesAutoConfiguredReasoning: policyConfig.reasoning,
        policiesAutoConfiguredModel: resolved.modelName,
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
   * Configure a single tool with timeout and loading state management.
   * This is the unified method used by both manual button clicks and automatic tool assignment.
   * Pass `resolvedLlm` to skip redundant LLM resolution in bulk flows.
   */
  async configurePoliciesForToolWithTimeout(params: {
    toolId: string;
    organizationId: string;
    userId?: string;
    resolvedLlm?: ResolvedLlm;
  }): Promise<AutoPolicyResult & { timedOut?: boolean }> {
    const { toolId, organizationId } = params;

    logger.info(
      { toolId, organizationId },
      "configurePoliciesForToolWithTimeout: starting",
    );

    try {
      // Set loading timestamp to show loading state in UI
      await ToolModel.setAutoConfiguringState(toolId);

      // Create a 20-second timeout promise
      const timeoutPromise = new Promise<{
        success: false;
        timedOut: true;
        error: string;
      }>((resolve) => {
        setTimeout(() => {
          resolve({
            success: false,
            timedOut: true,
            error: "Auto-configure timed out (>20s)",
          });
        }, 20000);
      });

      // Race between auto-configure and timeout
      const result = await Promise.race([
        this.configurePoliciesForTool(params).then((res) => ({
          ...res,
          timedOut: false,
        })),
        timeoutPromise,
      ]);

      // Handle the result and clear loading timestamp
      if (result.timedOut) {
        // Just clear the loading timestamp, let background operation continue
        await ToolModel.clearAutoConfiguringState(toolId);

        logger.warn(
          { toolId, organizationId },
          "configurePoliciesForToolWithTimeout: timed out, continuing in background",
        );
      } else if (result.success) {
        // Success - clear loading timestamp (policiesAutoConfiguredAt already set by configurePoliciesForTool)
        await ToolModel.clearAutoConfiguringState(toolId);

        logger.info(
          { toolId, organizationId },
          "configurePoliciesForToolWithTimeout: completed successfully",
        );
      } else {
        // Failed - clear both timestamps, reasoning, and model
        await ToolModel.clearAutoConfiguringState(toolId, { resetAll: true });

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
      // On error, clear both timestamps, reasoning, and model
      await ToolModel.clearAutoConfiguringState(toolId, {
        resetAll: true,
      }).catch((cleanupError) => {
        logger.warn(
          {
            toolId,
            error:
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError),
          },
          "configurePoliciesForToolWithTimeout: failed to clear auto-configuring state during error cleanup",
        );
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
   * Auto-configure policies for multiple tools in bulk.
   * Resolves the LLM once and threads it through to avoid redundant DB queries.
   */
  async configurePoliciesForTools(params: {
    toolIds: string[];
    organizationId: string;
    userId?: string;
  }): Promise<BulkAutoPolicyResult> {
    const { toolIds, organizationId, userId } = params;

    logger.info(
      { organizationId, count: toolIds.length },
      "configurePoliciesForTools: starting bulk auto-configure",
    );

    // Resolve LLM once for all tools (respects built-in agent's configured key/model)
    const resolvedLlm = await this.resolveLlm({
      organizationId,
      userId,
    });
    if (!resolvedLlm) {
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

    // Process all tools in parallel, threading the resolved LLM
    logger.info(
      { organizationId, count: toolIds.length },
      "configurePoliciesForTools: processing tools in parallel",
    );
    const results = await Promise.all(
      toolIds.map(async (toolId) => {
        const result = await this.configurePoliciesForToolWithTimeout({
          toolId,
          organizationId,
          userId,
          resolvedLlm,
        });
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
  private async analyzeTool(params: {
    tool: Pick<Tool, "id" | "name" | "description" | "parameters" | "meta">;
    mcpServerName: string | null;
    provider: SupportedProvider;
    apiKey: string | undefined;
    modelName: string;
    baseUrl: string | null;
    organizationId: string;
  }): Promise<PolicyConfig> {
    const {
      tool,
      mcpServerName,
      provider,
      apiKey,
      modelName,
      baseUrl,
      organizationId,
    } = params;
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
      organizationId,
    );
    if (!builtInAgent?.systemPrompt) {
      throw new Error(
        "Policy configuration built-in agent not found or has no system prompt",
      );
    }

    const model = createLLMModel({
      provider,
      apiKey,
      agentId: builtInAgent.id,
      modelName,
      baseUrl,
    });
    const annotations = tool.meta?.annotations as
      | Record<string, unknown>
      | undefined;
    const prompt =
      renderSystemPrompt(
        builtInAgent.systemPrompt,
        null,
        buildPolicyConfigSystemPromptContext({
          toolName: tool.name,
          toolDescription: tool.description || "No description provided",
          toolParameters: tool.parameters
            ? JSON.stringify(tool.parameters, null, 2)
            : "No parameters",
          toolAnnotations: annotations
            ? JSON.stringify(annotations, null, 2)
            : "Not provided",
          mcpServerName: mcpServerName || "Unknown",
        }),
      ) ?? "";

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
}

export const policyConfigurationService = new PolicyConfigurationService();

/**
 * Resolve LLM from the agent's own llmApiKeyId/llmModel configuration.
 * Mirrors the agent-level resolution in conversation-llm-selection.ts.
 */
async function resolveAgentLlm(agent: {
  llmApiKeyId: string | null;
  llmModel: string | null;
}): Promise<ResolvedLlm | null> {
  if (agent.llmApiKeyId) {
    const apiKeyRecord = await LlmProviderApiKeyModel.findById(
      agent.llmApiKeyId,
    );
    if (!apiKeyRecord) return null;

    const provider = isSupportedProvider(apiKeyRecord.provider)
      ? apiKeyRecord.provider
      : detectProviderFromModel(agent.llmModel ?? "");

    // Resolve the actual API key secret
    let apiKey: string | undefined;
    if (apiKeyRecord.secretId) {
      const secret = await getSecretValueForLlmProviderApiKey(
        apiKeyRecord.secretId,
      );
      apiKey = (secret as string) ?? undefined;
    }

    const modelName =
      agent.llmModel ??
      (await LlmProviderApiKeyModelLinkModel.getBestModel(apiKeyRecord.id))
        ?.modelId;
    if (!modelName) return null;

    return {
      provider,
      apiKey,
      modelName,
      baseUrl: apiKeyRecord.baseUrl,
    };
  }

  if (agent.llmModel) {
    return {
      provider: detectProviderFromModel(agent.llmModel),
      apiKey: undefined,
      modelName: agent.llmModel,
      baseUrl: null,
    };
  }

  return null;
}
