import { stepCountIs, streamText } from "ai";
import { getChatMcpTools } from "@/clients/chat-mcp-client";
import {
  createLLMModelForAgent,
  detectProviderFromModel,
} from "@/clients/llm-client";
import config from "@/config";
import logger from "@/logging";
import {
  AgentModel,
  ApiKeyModelModel,
  ChatApiKeyModel,
  TeamModel,
} from "@/models";
import type { SupportedChatProvider } from "@/types";

export interface A2AExecuteParams {
  /**
   * Agent ID to execute. Must be an internal agent (agentType='agent').
   */
  agentId: string;
  message: string;
  organizationId: string;
  userId: string;
  /** Session ID to group related LLM requests together in logs */
  sessionId?: string;
  /**
   * Parent delegation chain (colon-separated agent IDs).
   * The current agentId will be appended to form the new chain.
   */
  parentDelegationChain?: string;
}

export interface A2AExecuteResult {
  messageId: string;
  text: string;
  finishReason: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Execute a message against an A2A agent (internal agent with prompts)
 * This is the shared execution logic used by both A2A routes and dynamic agent tools
 */
export async function executeA2AMessage(
  params: A2AExecuteParams,
): Promise<A2AExecuteResult> {
  const {
    agentId,
    message,
    organizationId,
    userId,
    sessionId,
    parentDelegationChain,
  } = params;

  // Build delegation chain: append current agentId to parent chain
  const delegationChain = parentDelegationChain
    ? `${parentDelegationChain}:${agentId}`
    : agentId;

  // Fetch the internal agent
  const agent = await AgentModel.findById(agentId);
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  // Verify agent is internal (has prompts)
  if (agent.agentType !== "agent") {
    throw new Error(
      `Agent ${agentId} is not an internal agent (A2A requires agents with agentType='agent')`,
    );
  }

  // Resolve model using priority chain: agent config > best model for API key > best available > defaults
  const { model: selectedModel, provider } = await resolveModelForAgent({
    agent,
    userId,
    organizationId,
  });

  // Build system prompt from agent's systemPrompt and userPrompt fields
  let systemPrompt: string | undefined;
  const systemPromptParts: string[] = [];
  const userPromptParts: string[] = [];

  if (agent.systemPrompt) {
    systemPromptParts.push(agent.systemPrompt);
  }
  if (agent.userPrompt) {
    userPromptParts.push(agent.userPrompt);
  }

  if (systemPromptParts.length > 0 || userPromptParts.length > 0) {
    const allParts = [...systemPromptParts, ...userPromptParts];
    systemPrompt = allParts.join("\n\n");
  }

  // Fetch MCP tools for the agent (including delegation tools)
  // Pass sessionId and delegationChain so nested agent calls are grouped together
  const mcpTools = await getChatMcpTools({
    agentName: agent.name,
    agentId: agent.id,
    userId,
    userIsProfileAdmin: true, // A2A agents have full access
    organizationId,
    sessionId,
    delegationChain,
  });

  logger.info(
    {
      agentId: agent.id,
      userId,
      orgId: organizationId,
      toolCount: Object.keys(mcpTools).length,
      model: selectedModel,
      hasSystemPrompt: !!systemPrompt,
    },
    "Starting A2A execution",
  );

  // Create LLM model using shared service
  // Pass sessionId to group A2A requests with the calling session
  // Pass delegationChain as externalAgentId so agent names appear in logs
  // Pass agent's llmApiKeyId so it can be used without user access check
  const { model } = await createLLMModelForAgent({
    organizationId,
    userId,
    agentId: agent.id,
    model: selectedModel,
    provider,
    sessionId,
    externalAgentId: delegationChain,
    agentLlmApiKeyId: agent.llmApiKeyId,
  });

  // Execute with AI SDK using streamText (required for long-running requests)
  // We stream internally but collect the full result
  const stream = streamText({
    model,
    system: systemPrompt,
    prompt: message,
    tools: mcpTools,
    stopWhen: stepCountIs(500),
  });

  // Wait for the stream to complete and get the final text
  const finalText = await stream.text;
  const usage = await stream.usage;
  const finishReason = await stream.finishReason;

  // Generate message ID
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  logger.info(
    {
      agentId: agent.id,
      provider,
      finishReason,
      usage,
      messageId,
    },
    "A2A execution finished",
  );

  return {
    messageId,
    text: finalText,
    finishReason: finishReason ?? "unknown",
    usage: usage
      ? {
          promptTokens: usage.inputTokens ?? 0,
          completionTokens: usage.outputTokens ?? 0,
          totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        }
      : undefined,
  };
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Resolve the model and provider to use for an agent.
 *
 * Priority chain:
 * 1. Agent has explicit llmModel → use it directly
 * 2. Agent has llmApiKeyId but no llmModel → use best model for that key
 * 3. Agent has neither → find best model across all available API keys (org_wide > team > personal)
 * 4. Fallback → use config defaults
 */
async function resolveModelForAgent(params: {
  agent: { llmModel: string | null; llmApiKeyId: string | null };
  userId: string;
  organizationId: string;
}): Promise<{ model: string; provider: SupportedChatProvider }> {
  const { agent, userId, organizationId } = params;

  // Priority 1: Agent has explicit llmModel
  if (agent.llmModel) {
    const provider = detectProviderFromModel(agent.llmModel);
    logger.debug(
      { model: agent.llmModel, provider, source: "agent.llmModel" },
      "Resolved model from agent config",
    );
    return { model: agent.llmModel, provider };
  }

  // Priority 2: Agent has llmApiKeyId — get best model for that key
  if (agent.llmApiKeyId) {
    const bestModel = await ApiKeyModelModel.getBestModel(agent.llmApiKeyId);
    if (bestModel) {
      const provider = detectProviderFromModel(bestModel.modelId);
      logger.debug(
        {
          model: bestModel.modelId,
          provider,
          apiKeyId: agent.llmApiKeyId,
          source: "agent.llmApiKeyId",
        },
        "Resolved model from agent API key",
      );
      return { model: bestModel.modelId, provider };
    }
  }

  // Priority 3: Find best model across all available API keys
  const userTeamIds = await TeamModel.getUserTeamIds(userId);
  const availableKeys = await ChatApiKeyModel.getAvailableKeysForUser(
    organizationId,
    userId,
    userTeamIds,
  );

  if (availableKeys.length > 0) {
    const scopePriority = { org_wide: 0, team: 1, personal: 2 } as const;

    const keyModels = await Promise.all(
      availableKeys.map(async (key) => ({
        apiKey: key,
        model: await ApiKeyModelModel.getBestModel(key.id),
      })),
    );

    const withBestModels = keyModels
      .filter(
        (
          km,
        ): km is {
          apiKey: (typeof km)["apiKey"];
          model: NonNullable<(typeof km)["model"]>;
        } => km.model !== null,
      )
      .sort(
        (a, b) =>
          (scopePriority[a.apiKey.scope as keyof typeof scopePriority] ?? 3) -
          (scopePriority[b.apiKey.scope as keyof typeof scopePriority] ?? 3),
      );

    if (withBestModels.length > 0) {
      const selected = withBestModels[0];
      const provider = detectProviderFromModel(selected.model.modelId);
      logger.debug(
        {
          model: selected.model.modelId,
          provider,
          apiKeyId: selected.apiKey.id,
          scope: selected.apiKey.scope,
          source: "available_keys",
        },
        "Resolved model from available API keys",
      );
      return { model: selected.model.modelId, provider };
    }
  }

  // Priority 4: Fallback to config defaults
  logger.debug(
    {
      model: config.chat.defaultModel,
      provider: config.chat.defaultProvider,
      source: "config_defaults",
    },
    "Resolved model from config defaults",
  );
  return {
    model: config.chat.defaultModel,
    provider: config.chat.defaultProvider,
  };
}
