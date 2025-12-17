import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import config from "@/config";
import { getObservableFetch } from "@/llm-metrics";
import logger from "@/logging";
import AgentModel from "@/models/agent";
import InteractionModel from "@/models/interaction";
import type { Agent, Tool } from "@/types";

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

/**
 * PolicyConfigSubagent is a specialized system agent that analyzes tools
 * and determines appropriate security policies using LLM analysis.
 *
 * This is a simple subagent (single LLM call) but structured to enable
 * future expansion into multi-step analysis, tool usage, or iterative refinement.
 */
export class PolicyConfigSubagent {
  // System subagent identifier
  static readonly SUBAGENT_ID = "policy-configuration-subagent";
  static readonly SUBAGENT_NAME = "Policy Configuration Subagent";

  // Analysis prompt template (exposed for UI display)
  static readonly ANALYSIS_PROMPT_TEMPLATE =
    `Analyze this MCP tool and determine security policies:

Tool: {tool.name}
Description: {tool.description}
MCP Server: {mcpServerName}
Parameters: {tool.parameters}

Determine:

1. allowUsageWhenUntrustedDataIsPresent (boolean)
   - TRUE: Read-only, doesn't leak sensitive data
   - FALSE: Writes data, executes code, sends data externally

2. toolResultTreatment (enum)
   - "trusted": Internal systems (databases, APIs, dev tools like list-endpoints/get-config)
   - "untrusted": External/filesystem data where exact values are safe to use directly
   - "sanitize_with_dual_llm": Untrusted data that needs summarization without exposing exact values

Examples:
- Internal dev tools: allowUsage=true, treatment="trusted"
- Database queries: allowUsage=true, treatment="trusted"
- File reads (code/config): allowUsage=true, treatment="untrusted"
- Web search/scraping: allowUsage=true, treatment="sanitize_with_dual_llm"
- File writes: allowUsage=false, treatment="trusted"
- External APIs (raw data): allowUsage=false, treatment="untrusted"
- Code execution: allowUsage=false, treatment="untrusted"`;

  // Virtual agent representing the subagent for observability
  private static readonly VIRTUAL_AGENT: Agent = {
    id: PolicyConfigSubagent.SUBAGENT_ID,
    name: PolicyConfigSubagent.SUBAGENT_NAME,
    isDemo: false,
    isDefault: false,
    considerContextUntrusted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    tools: [],
    teams: [],
    labels: [],
  };

  /**
   * Analyze a tool and determine appropriate security policies
   *
   * This method:
   * 1. Constructs analysis prompt from tool metadata
   * 2. Calls LLM with observable fetch (traces/metrics)
   * 3. Records interaction in database
   * 4. Returns structured policy configuration
   */
  async analyze(params: {
    tool: Pick<
      Tool,
      | "id"
      | "name"
      | "description"
      | "parameters"
      | "catalogId"
      | "mcpServerId"
      | "agentId"
      | "createdAt"
      | "updatedAt"
    >;
    mcpServerName: string | null;
    anthropicApiKey: string;
    organizationId: string;
  }): Promise<PolicyConfig> {
    const { tool, mcpServerName, anthropicApiKey, organizationId } = params;

    logger.info(
      {
        toolName: tool.name,
        mcpServerName,
        subagentId: PolicyConfigSubagent.SUBAGENT_ID,
        model: config.chat.defaultModel,
      },
      "[PolicyConfigSubagent] Starting policy analysis",
    );

    // Create Anthropic client with observable fetch for tracing/metrics
    const anthropic = createAnthropic({
      apiKey: anthropicApiKey,
      baseURL: `${config.chat.anthropic.baseUrl}/v1`,
      fetch: getObservableFetch(
        "anthropic",
        PolicyConfigSubagent.VIRTUAL_AGENT,
        PolicyConfigSubagent.SUBAGENT_ID, // Use subagent ID as external agent ID
      ),
    });

    const prompt = this.buildPrompt(tool, mcpServerName);

    const startTime = Date.now();

    try {
      // Make LLM call with structured output
      const result = await generateObject({
        model: anthropic(config.chat.defaultModel),
        schema: PolicyConfigSchema,
        prompt,
      });

      const duration = Date.now() - startTime;

      logger.info(
        {
          toolName: tool.name,
          mcpServerName,
          config: result.object,
          duration,
          subagentId: PolicyConfigSubagent.SUBAGENT_ID,
        },
        "[PolicyConfigSubagent] Analysis completed",
      );

      // Record interaction for observability
      // Run in background to not block response
      this.recordInteraction({
        tool,
        mcpServerName,
        prompt,
        result: result.object,
        organizationId,
        duration,
      }).catch((error) => {
        logger.error(
          {
            toolName: tool.name,
            error: error instanceof Error ? error.message : String(error),
          },
          "[PolicyConfigSubagent] Failed to record interaction",
        );
      });

      return result.object;
    } catch (error) {
      logger.error(
        {
          toolName: tool.name,
          mcpServerName,
          model: config.chat.defaultModel,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          subagentId: PolicyConfigSubagent.SUBAGENT_ID,
        },
        "[PolicyConfigSubagent] Analysis failed",
      );
      throw error;
    }
  }

  /**
   * Build the analysis prompt for the LLM using actual tool values
   */
  private buildPrompt(
    tool: Pick<Tool, "name" | "description" | "parameters">,
    mcpServerName: string | null,
  ): string {
    return PolicyConfigSubagent.ANALYSIS_PROMPT_TEMPLATE.replace(
      "{tool.name}",
      tool.name,
    )
      .replace(
        "{tool.description}",
        tool.description || "No description provided",
      )
      .replace("{mcpServerName}", mcpServerName || "Unknown")
      .replace("{tool.parameters}", JSON.stringify(tool.parameters, null, 2));
  }

  /**
   * Record interaction for observability and audit trail
   */
  private async recordInteraction(params: {
    tool: Pick<Tool, "name">;
    mcpServerName: string | null;
    prompt: string;
    result: PolicyConfig;
    organizationId: string;
    duration: number;
  }): Promise<void> {
    const { tool, prompt, result } = params;

    logger.debug(
      {
        toolName: tool.name,
        subagentId: PolicyConfigSubagent.SUBAGENT_ID,
      },
      "[PolicyConfigSubagent] Recording interaction",
    );

    try {
      // Get or create a dedicated system agent for subagent interactions
      // This agent will show as empty/system in the UI
      const systemAgent = await AgentModel.getAgentOrCreateDefault(
        PolicyConfigSubagent.SUBAGENT_NAME,
      );

      await InteractionModel.create({
        profileId: systemAgent.id,
        externalAgentId: PolicyConfigSubagent.SUBAGENT_ID,
        type: "anthropic:messages",
        model: config.chat.defaultModel,
        request: {
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          model: config.chat.defaultModel,
          max_tokens: 1024,
        },
        response: {
          id: `policy-config-${Date.now()}`,
          type: "message",
          role: "assistant",
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          model: config.chat.defaultModel,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 0, // Will be populated by metrics
            output_tokens: 0, // Will be populated by metrics
          },
        },
      });

      logger.debug(
        {
          toolName: tool.name,
          subagentId: PolicyConfigSubagent.SUBAGENT_ID,
        },
        "[PolicyConfigSubagent] Interaction recorded",
      );
    } catch (error) {
      // Don't throw - interaction recording is best-effort for observability
      logger.warn(
        {
          toolName: tool.name,
          error: error instanceof Error ? error.message : String(error),
        },
        "[PolicyConfigSubagent] Failed to record interaction (non-fatal)",
      );
    }
  }
}

// Singleton instance
export const policyConfigSubagent = new PolicyConfigSubagent();
