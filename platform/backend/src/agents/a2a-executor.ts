import { stepCountIs, streamText } from "ai";
import { getChatMcpTools } from "@/clients/chat-mcp-client";
import { createLLMModelForAgent } from "@/clients/llm-client";
import config from "@/config";
import logger from "@/logging";
import { AgentModel } from "@/models";

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

  // Use default model and provider from config
  const selectedModel = config.chat.defaultModel;
  const provider = config.chat.defaultProvider;

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
  const { model } = await createLLMModelForAgent({
    organizationId,
    userId,
    agentId: agent.id,
    model: selectedModel,
    provider,
    sessionId,
    externalAgentId: delegationChain,
  });

  // Execute with AI SDK using streamText (required for long-running requests)
  // We stream internally but collect the full result
  const stream = streamText({
    model,
    system: systemPrompt,
    prompt: message,
    tools: mcpTools,
    stopWhen: stepCountIs(20),
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
