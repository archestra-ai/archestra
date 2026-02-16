import type { SupportedProviderDiscriminator } from "@shared/model-constants";
import { generateObject } from "ai";
import { z } from "zod";
import { createDirectLLMModel } from "@/clients/llm-client";
import logger from "@/logging";
import AgentModel from "@/models/agent";
import InteractionModel from "@/models/interaction";
import type { SupportedChatProvider, Tool } from "@/types";

const PolicyConfigSchema = z.object({
  toolInvocationAction: z
    .enum([
      "allow_when_context_is_untrusted",
      "block_when_context_is_untrusted",
      "block_always",
    ])
    .describe(
      "When should this tool be allowed to be invoked? " +
        "'allow_when_context_is_untrusted' - Allow invocation even when untrusted data is present (safe read-only tools). " +
        "'block_when_context_is_untrusted' - Allow only when context is trusted, block when untrusted data is present (tools that could leak data). " +
        "'block_always' - Never allow automatic invocation (dangerous tools that execute code, write data, or send data externally).",
    ),
  trustedDataAction: z
    .enum([
      "mark_as_trusted",
      "mark_as_untrusted",
      "sanitize_with_dual_llm",
      "block_always",
    ])
    .describe(
      "How should the tool's results be treated? " +
        "'mark_as_trusted' - Results are trusted and can be used directly (internal systems, databases, dev tools). " +
        "'mark_as_untrusted' - Results are untrusted and will restrict subsequent tool usage (external/filesystem data where exact values are safe). " +
        "'sanitize_with_dual_llm' - Results are processed through dual LLM security pattern (untrusted data that needs summarization). " +
        "'block_always' - Results are blocked entirely (highly sensitive or dangerous output).",
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

1. toolInvocationAction (enum) - When should this tool be allowed?
   - "allow_when_context_is_untrusted": Safe to invoke even with untrusted data (read-only, doesn't leak sensitive data)
   - "block_when_context_is_untrusted": Only invoke when context is trusted (could leak data if untrusted input is present)
   - "block_always": Never invoke automatically (writes data, executes code, sends data externally)

2. trustedDataAction (enum) - How should the tool's results be treated?
   - "mark_as_trusted": Internal systems (databases, APIs, dev tools like list-endpoints/get-config)
   - "mark_as_untrusted": External/filesystem data where exact values are safe to use directly
   - "sanitize_with_dual_llm": Untrusted data that needs summarization without exposing exact values
   - "block_always": Highly sensitive or dangerous output that should be blocked entirely

Examples:
- Internal dev tools: invocation="allow_when_context_is_untrusted", result="mark_as_trusted"
- Database queries: invocation="allow_when_context_is_untrusted", result="mark_as_trusted"
- File reads (code/config): invocation="allow_when_context_is_untrusted", result="mark_as_untrusted"
- Web search/scraping: invocation="allow_when_context_is_untrusted", result="sanitize_with_dual_llm"
- File writes: invocation="block_always", result="mark_as_trusted"
- External APIs (raw data): invocation="block_when_context_is_untrusted", result="mark_as_untrusted"
- Code execution: invocation="block_always", result="mark_as_untrusted"`;

  /**
   * Analyze a tool and determine appropriate security policies
   *
   * This method:
   * 1. Constructs analysis prompt from tool metadata
   * 2. Calls LLM via createDirectLLMModel (multi-provider)
   * 3. Records interaction in database
   * 4. Returns structured policy configuration
   */
  async analyze(params: {
    tool: Pick<Tool, "id" | "name" | "description" | "parameters">;
    mcpServerName: string | null;
    provider: SupportedChatProvider;
    apiKey: string;
    modelName: string;
    organizationId: string;
  }): Promise<PolicyConfig> {
    const { tool, mcpServerName, provider, apiKey, modelName, organizationId } =
      params;

    logger.info(
      {
        toolName: tool.name,
        mcpServerName,
        subagentId: PolicyConfigSubagent.SUBAGENT_ID,
        provider,
        model: modelName,
      },
      "[PolicyConfigSubagent] Starting policy analysis",
    );

    const model = createDirectLLMModel({ provider, apiKey, modelName });
    const prompt = this.buildPrompt(tool, mcpServerName);
    const startTime = Date.now();

    try {
      // Make LLM call with structured output
      const result = await generateObject({
        model,
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
        provider,
        modelName,
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
          provider,
          model: modelName,
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
    provider: SupportedChatProvider;
    modelName: string;
  }): Promise<void> {
    const { tool, prompt, result, provider, modelName } = params;

    logger.debug(
      {
        toolName: tool.name,
        subagentId: PolicyConfigSubagent.SUBAGENT_ID,
      },
      "[PolicyConfigSubagent] Recording interaction",
    );

    try {
      // Get or create default LLM proxy agent for recording subagent interactions
      const systemAgent = await AgentModel.getLLMProxyOrCreateDefault();
      const interactionType = PROVIDER_TO_DISCRIMINATOR[provider];

      await InteractionModel.create({
        profileId: systemAgent.id,
        externalAgentId: PolicyConfigSubagent.SUBAGENT_ID,
        type: interactionType,
        model: modelName,
        request: {
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          model: modelName,
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
          model: modelName,
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

// =============================================================================
// Internal helpers
// =============================================================================

const PROVIDER_TO_DISCRIMINATOR: Record<
  SupportedChatProvider,
  SupportedProviderDiscriminator
> = {
  anthropic: "anthropic:messages",
  openai: "openai:chatCompletions",
  gemini: "gemini:generateContent",
  bedrock: "bedrock:converse",
  cohere: "cohere:chat",
  cerebras: "cerebras:chatCompletions",
  mistral: "mistral:chatCompletions",
  vllm: "vllm:chatCompletions",
  ollama: "ollama:chatCompletions",
  zhipuai: "zhipuai:chatCompletions",
};
