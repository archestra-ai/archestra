import { stepCountIs, streamText } from "ai";
import { getChatMcpTools } from "@/clients/chat-mcp-client";
import config from "@/config";
import logger from "@/logging";
import { AgentModel, PromptModel } from "@/models";
import { createLLMModelForAgent } from "@/services/llm-client";

export interface A2AExecuteParams {
  promptId: string;
  message: string;
  organizationId: string;
  userId: string;
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
 * Execute a message against an A2A agent (prompt)
 * This is the shared execution logic used by both A2A routes and dynamic agent tools
 */
export async function executeA2AMessage(
  params: A2AExecuteParams,
): Promise<A2AExecuteResult> {
  const { promptId, message, organizationId, userId } = params;

  // Fetch prompt
  const prompt = await PromptModel.findById(promptId);
  if (!prompt) {
    throw new Error(`Prompt ${promptId} not found`);
  }

  // Fetch the agent (profile) associated with this prompt
  const agent = await AgentModel.findById(prompt.agentId);
  if (!agent) {
    throw new Error(`Agent not found for prompt ${promptId}`);
  }

  // Use default model and provider from config
  const selectedModel = config.chat.defaultModel;
  const provider = config.chat.defaultProvider;

  // Build system prompt from prompt's systemPrompt and userPrompt fields
  let systemPrompt: string | undefined;
  const systemPromptParts: string[] = [];
  const userPromptParts: string[] = [];

  if (prompt.systemPrompt) {
    systemPromptParts.push(prompt.systemPrompt);
  }
  if (prompt.userPrompt) {
    userPromptParts.push(prompt.userPrompt);
  }

  if (systemPromptParts.length > 0 || userPromptParts.length > 0) {
    const allParts = [...systemPromptParts, ...userPromptParts];
    systemPrompt = allParts.join("\n\n");
  }

  // Fetch MCP tools for the agent (including agent tools for the prompt)
  const mcpTools = await getChatMcpTools({
    agentName: agent.name,
    agentId: agent.id,
    userId,
    userIsProfileAdmin: true, // A2A agents have full access
    promptId,
    organizationId,
  });

  logger.info(
    {
      promptId,
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
  const { model } = await createLLMModelForAgent({
    organizationId,
    userId,
    agentId: agent.id,
    model: selectedModel,
    provider,
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
      promptId,
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
