import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { secretManager } from "@/secretsmanager";
import type { Tool } from "@/types";
import AgentToolModel from "./agent-tool";
import ChatSettingsModel from "./chat-settings";
import McpServerModel from "./mcp-server";

const PolicyConfigSchema = z.object({
  allowUsageWhenUntrustedDataIsPresent: z
    .boolean()
    .describe(
      "Should this tool be allowed when untrusted data is present in the context? " +
        "Set to true for tools that handle sensitive operations safely (e.g., read-only operations, search tools, informational tools). " +
        "Set to false for tools that could leak sensitive data or modify state based on untrusted input.",
    ),
  toolResultTreatment: z
    .enum(["trusted", "sanitize_with_dual_llm", "untrusted"])
    .describe(
      "How should the tool's results be treated? " +
        "'trusted' - Results can be used directly in subsequent operations without restrictions (internal data sources). " +
        "'untrusted' - Results are marked as untrusted and will restrict what other tools can be used (external sources, user-controlled data). " +
        "'sanitize_with_dual_llm' - Results are processed through dual LLM security pattern before being used (mixed content).",
    ),
  reasoning: z
    .string()
    .describe(
      "Brief explanation of why these settings were chosen for this tool.",
    ),
});

type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

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
   * Requires Anthropic API key to be configured in chat settings
   */
  async isAvailable(organizationId: string): Promise<boolean> {
    logger.debug(
      { organizationId },
      "isAvailable: checking auto-policy availability",
    );
    const chatSettings =
      await ChatSettingsModel.findByOrganizationId(organizationId);
    if (!chatSettings?.anthropicApiKeySecretId) {
      logger.debug({ organizationId }, "isAvailable: no API key configured");
      return false;
    }

    const secret = await secretManager.getSecret(
      chatSettings.anthropicApiKeySecretId,
    );
    const available = !!secret?.secret?.anthropicApiKey;
    logger.debug({ organizationId, available }, "isAvailable: result");
    return available;
  }

  /**
   * Get Anthropic API key for an organization
   */
  private async getAnthropicApiKey(
    organizationId: string,
  ): Promise<string | null> {
    logger.debug({ organizationId }, "getAnthropicApiKey: fetching API key");
    const chatSettings =
      await ChatSettingsModel.findByOrganizationId(organizationId);
    if (!chatSettings?.anthropicApiKeySecretId) {
      logger.debug(
        { organizationId },
        "getAnthropicApiKey: no secret ID configured",
      );
      return null;
    }

    const secret = await secretManager.getSecret(
      chatSettings.anthropicApiKeySecretId,
    );
    if (!secret?.secret?.anthropicApiKey) {
      logger.debug({ organizationId }, "getAnthropicApiKey: secret not found");
      return null;
    }

    logger.debug({ organizationId }, "getAnthropicApiKey: API key retrieved");
    return secret.secret.anthropicApiKey as string;
  }

  /**
   * Analyze a tool and determine appropriate security policies using LLM
   */
  private async analyzeTool(
    tool: Tool,
    mcpServerName: string | null,
    anthropicApiKey: string,
  ): Promise<PolicyConfig> {
    logger.info(
      {
        toolName: tool.name,
        mcpServerName,
        model: config.chat.defaultModel,
        baseURL: config.chat.anthropic.baseUrl,
        hasApiKey: !!anthropicApiKey,
      },
      "analyzeTool: starting LLM analysis",
    );
    const anthropic = createAnthropic({
      apiKey: anthropicApiKey,
      baseURL: config.chat.anthropic.baseUrl,
    });

    const prompt = `You are a security expert analyzing MCP (Model Context Protocol) tools to determine appropriate security policies.

Tool Information:
- Name: ${tool.name}
- Description: ${tool.description || "No description provided"}
- MCP Server: ${mcpServerName || "Unknown"}
- Parameters: ${JSON.stringify(tool.parameters, null, 2)}

Your task is to determine two security settings:

1. "allowUsageWhenUntrustedDataIsPresent" - Should this tool be usable when untrusted data is in the context?
   - Set TRUE for: Read-only operations, search/query tools, informational tools, tools that don't expose or leak sensitive data
   - Set FALSE for: Tools that write/modify data, tools that could leak sensitive information, tools that execute code, tools that send data externally

2. "toolResultTreatment" - How should this tool's output be treated?
   - "trusted": Safe, verified data that can be used without restrictions (e.g., internal database queries, system information)
   - "untrusted": Data from external sources or user-controlled inputs that needs careful handling
   - "sanitize_with_dual_llm": Data that should be verified through dual LLM pattern before use (e.g., external API responses with mixed content)

General guidelines:
- Filesystem read operations: allowUsageWhenUntrustedDataIsPresent=true, toolResultTreatment="untrusted" (file content could be malicious)
- Filesystem write operations: allowUsageWhenUntrustedDataIsPresent=false, toolResultTreatment="trusted" (operation itself is sensitive)
- Database queries: allowUsageWhenUntrustedDataIsPresent=true, toolResultTreatment="trusted" (internal trusted data)
- External API calls: allowUsageWhenUntrustedDataIsPresent=false, toolResultTreatment="untrusted" (external data not verified)
- Code execution: allowUsageWhenUntrustedDataIsPresent=false, toolResultTreatment="untrusted"
- Search/informational: allowUsageWhenUntrustedDataIsPresent=true, toolResultTreatment="untrusted"

Analyze the tool and provide your security assessment.`;

    try {
      const result = await generateObject({
        model: anthropic(config.chat.defaultModel),
        schema: PolicyConfigSchema,
        prompt,
      });

      logger.info(
        {
          toolName: tool.name,
          mcpServerName,
          config: result.object,
        },
        "analyzeTool: LLM analysis completed",
      );

      return result.object;
    } catch (error) {
      logger.error(
        {
          toolName: tool.name,
          mcpServerName,
          model: config.chat.defaultModel,
          baseURL: config.chat.anthropic.baseUrl,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "analyzeTool: LLM API call failed",
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
          "Anthropic API key not configured in chat settings for this organization",
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

      // Analyze tool and get policy configuration
      const policyConfig = await this.analyzeTool(
        {
          id: assignment.tool.id,
          name: assignment.tool.name,
          description: assignment.tool.description,
          parameters: assignment.tool.parameters,
          catalogId: assignment.tool.catalogId,
          mcpServerId: assignment.tool.mcpServerId,
          agentId: null,
          createdAt: assignment.tool.createdAt,
          updatedAt: assignment.tool.updatedAt,
        },
        mcpServerName,
        anthropicApiKey,
      );

      // Update agent-tool with new configuration
      await AgentToolModel.update(agentToolId, {
        allowUsageWhenUntrustedDataIsPresent:
          policyConfig.allowUsageWhenUntrustedDataIsPresent,
        toolResultTreatment: policyConfig.toolResultTreatment,
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
   * Auto-configure policies for multiple agent-tool assignments in bulk
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
            "Anthropic API key not configured in chat settings for this organization",
        })),
      };
    }

    // Process all tools in parallel
    logger.info(
      { organizationId, count: agentToolIds.length },
      "configurePoliciesForAgentTools: processing tools in parallel",
    );
    const results = await Promise.all(
      agentToolIds.map(async (agentToolId) => {
        const result = await this.configurePoliciesForAgentTool(
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
