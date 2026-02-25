import crypto from "node:crypto";
import { PLAYWRIGHT_MCP_CATALOG_ID } from "@shared";
import type { UserContent } from "ai";
import { NoOutputGeneratedError, stepCountIs, streamText } from "ai";
import { MIN_IMAGE_ATTACHMENT_SIZE } from "@/agents/incoming-email/constants";
import { subagentExecutionTracker } from "@/agents/subagent-execution-tracker";
import { closeChatMcpClient, getChatMcpTools } from "@/clients/chat-mcp-client";
import { createLLMModelForAgent } from "@/clients/llm-client";
import mcpClient from "@/clients/mcp-client";
import config from "@/config";
import logger from "@/logging";
import {
  AgentModel,
  ApiKeyModelModel,
  ChatApiKeyModel,
  McpServerModel,
  TeamModel,
} from "@/models";
import { mapProviderError, ProviderError } from "@/routes/chat/errors";
import type { SupportedChatProvider } from "@/types";

/**
 * Source-agnostic attachment for A2A execution.
 * Callers (email, Slack, Teams, etc.) should transform their provider-specific
 * attachment types into this format before passing to executeA2AMessage.
 */
export interface A2AAttachment {
  /** MIME content type (e.g., 'image/png', 'application/pdf') */
  contentType: string;
  /** Base64-encoded content */
  contentBase64: string;
  /** Optional filename for context */
  name?: string;
}

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
  /**
   * Conversation ID for browser tab isolation.
   * When provided (e.g., from chat delegation), sub-agents get their own tab
   * keyed by (agentId, userId, conversationId).
   * When not provided (direct A2A call), a unique execution ID is generated
   * and cleaned up after execution.
   */
  conversationId?: string;
  /** Optional cancellation signal propagated from parent chat/tool execution */
  abortSignal?: AbortSignal;
  /** Optional attachments to include in the message (e.g., images from email, Slack, Teams) */
  attachments?: A2AAttachment[];
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
    abortSignal,
    attachments,
  } = params;

  // Generate isolation key for browser tab isolation.
  // When called from chat delegation, conversationId is provided.
  // When called directly (A2A route), generate a unique execution ID.
  const isDirectExecutionOutsideConversation = !params.conversationId;
  const isolationKey = params.conversationId ?? crypto.randomUUID();

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

  // Track subagent execution so the browser preview can skip screenshots
  // while subagents are active (prevents flickering from tab switching).
  // Only track delegated calls — direct A2A calls have no browser preview.
  if (!isDirectExecutionOutsideConversation) {
    subagentExecutionTracker.increment(isolationKey);
  }

  try {
    // Fetch MCP tools for the agent (including delegation tools)
    // Pass sessionId, delegationChain, and conversationId for browser tab isolation
    const mcpTools = await getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId,
      userIsAgentAdmin: true, // A2A agents have full access
      organizationId,
      sessionId,
      delegationChain,
      conversationId: isolationKey,
      abortSignal,
    });

    logger.info(
      {
        agentId: agent.id,
        userId,
        orgId: organizationId,
        toolCount: Object.keys(mcpTools).length,
        model: selectedModel,
        hasSystemPrompt: !!systemPrompt,
        isolationKey,
        isDirectExecutionOutsideConversation,
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
    // We stream internally but collect the full result.
    // Capture stream-level errors (e.g. API billing errors) via onError so we
    // can surface the real cause instead of a generic NoOutputGeneratedError.

    // Build multimodal user content when image attachments are present
    const { content: userContent, skippedNote } = buildUserContent(
      message,
      attachments,
    );

    let capturedStreamError: unknown;
    const onError = ({ error }: { error: unknown }) => {
      capturedStreamError = error;
    };

    // Use `messages` with content parts when we have images, otherwise `prompt` for plain text
    const stream = userContent
      ? streamText({
          model,
          system: systemPrompt,
          messages: [{ role: "user" as const, content: userContent }],
          tools: mcpTools,
          stopWhen: stepCountIs(500),
          abortSignal,
          onError,
        })
      : streamText({
          model,
          system: systemPrompt,
          prompt: message + skippedNote,
          tools: mcpTools,
          stopWhen: stepCountIs(500),
          abortSignal,
          onError,
        });

    // Wait for the stream to complete and get the final text.
    // When the underlying provider returns an error (e.g. 400 insufficient
    // credits), the stream produces zero steps and the AI SDK throws
    // NoOutputGeneratedError.  Re-throw with the real error message so callers
    // (and ultimately end-users) see what actually went wrong.
    let finalText: string;
    let usage: Awaited<typeof stream.usage>;
    let finishReason: Awaited<typeof stream.finishReason>;
    try {
      finalText = await stream.text;
      usage = await stream.usage;
      finishReason = await stream.finishReason;
    } catch (streamError) {
      if (
        NoOutputGeneratedError.isInstance(streamError) &&
        capturedStreamError
      ) {
        throw new ProviderError(
          mapProviderError(capturedStreamError, provider),
        );
      }
      throw new ProviderError(mapProviderError(streamError, provider));
    }

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
  } finally {
    // Clean up browser tab BEFORE decrementing the tracker.
    // This ensures screenshots remain paused while the subagent's tab is
    // being closed, preventing the preview from capturing the wrong tab.
    await cleanupBrowserTab({
      agentId,
      userId,
      organizationId,
      isolationKey,
      isDirectExecutionOutsideConversation,
    });

    if (!isDirectExecutionOutsideConversation) {
      subagentExecutionTracker.decrement(isolationKey);
    }
  }
}

// ============================================================================
// Exported helper functions
// ============================================================================

/**
 * Build AI SDK UserContent from a text message and optional attachments.
 * Returns `content: null` when there are no image attachments (caller should use plain `prompt` instead).
 * Returns `skippedNote` with a human-readable note about non-image attachments that were dropped,
 * so the caller can append it to the prompt for the LLM to mention.
 *
 * Only image attachments are currently supported as inline content parts.
 * Non-image attachments are noted so the LLM can inform the user.
 */
export function buildUserContent(
  message: string,
  attachments?: A2AAttachment[],
): { content: UserContent | null; skippedNote: string } {
  const allAttachments = attachments ?? [];

  // Split into image and non-image attachments
  const imageAttachments = allAttachments.filter((a) =>
    a.contentType.startsWith("image/"),
  );
  const nonImageAttachments = allAttachments.filter(
    (a) => !a.contentType.startsWith("image/"),
  );

  // Filter out tiny images (broken inline references from email replies).
  // Estimate actual byte size from base64 length: every 4 base64 chars = 3 bytes.
  const validImageAttachments = imageAttachments.filter((a) => {
    const estimatedBytes = Math.ceil((a.contentBase64.length * 3) / 4);
    return estimatedBytes >= MIN_IMAGE_ATTACHMENT_SIZE;
  });
  const tinyImageAttachments = imageAttachments.filter((a) => {
    const estimatedBytes = Math.ceil((a.contentBase64.length * 3) / 4);
    return estimatedBytes < MIN_IMAGE_ATTACHMENT_SIZE;
  });

  if (tinyImageAttachments.length > 0) {
    logger.debug(
      {
        count: tinyImageAttachments.length,
        images: tinyImageAttachments.map((a) => ({
          name: a.name ?? "unnamed",
          contentType: a.contentType,
          estimatedBytes: Math.ceil((a.contentBase64.length * 3) / 4),
        })),
      },
      "Filtering out tiny image attachments (likely broken inline references from email replies)",
    );
  }

  if (nonImageAttachments.length > 0) {
    logger.debug(
      {
        skippedCount: nonImageAttachments.length,
        skippedTypes: nonImageAttachments.map(
          (a) => `${a.name ?? "unnamed"} (${a.contentType})`,
        ),
      },
      "Skipping non-image attachments in buildUserContent (only image/* is currently supported)",
    );
  }

  // Build a note about all skipped attachments so the LLM can mention them
  const allSkipped = [...nonImageAttachments, ...tinyImageAttachments];
  const skippedNote =
    allSkipped.length > 0
      ? `\n\n[Note: This message also included ${allSkipped.length} attachment(s) that could not be processed: ${allSkipped.map((a) => `${a.name ?? "unnamed"} (${a.contentType})`).join(", ")}]`
      : "";

  if (validImageAttachments.length === 0) {
    return { content: null, skippedNote };
  }

  return {
    content: [
      { type: "text" as const, text: message + skippedNote },
      ...validImageAttachments.map((a) => ({
        type: "image" as const,
        image: `data:${a.contentType};base64,${a.contentBase64}`,
      })),
    ],
    skippedNote,
  };
}

// ============================================================================
// Internal helper functions
// ============================================================================

/**
 * Clean up browser tab state after A2A execution.
 * Closes the browser tab and optionally the MCP client.
 */
async function cleanupBrowserTab(params: {
  agentId: string;
  userId: string;
  organizationId: string;
  isolationKey: string;
  isDirectExecutionOutsideConversation: boolean;
}): Promise<void> {
  const {
    agentId,
    userId,
    organizationId,
    isolationKey,
    isDirectExecutionOutsideConversation,
  } = params;

  try {
    // Close the browser tab via the feature service
    const { browserStreamFeature } = await import(
      "@/features/browser-stream/services/browser-stream.feature"
    );

    if (browserStreamFeature.isEnabled()) {
      await browserStreamFeature.closeTab(agentId, isolationKey, {
        userId,
        organizationId,
        userIsAgentAdmin: true,
      });
    }
  } catch (error) {
    logger.warn(
      { agentId, userId, isolationKey, error },
      "Failed to close browser tab during A2A cleanup (non-fatal)",
    );
  }

  // Close the subagent's cached MCP session so the Playwright pod cleans up
  // the browser context. This is needed for both direct and delegated calls
  // since each (agentId, conversationId) gets its own session.
  try {
    const userServer = await McpServerModel.getUserPersonalServerForCatalog(
      userId,
      PLAYWRIGHT_MCP_CATALOG_ID,
    );
    if (userServer) {
      mcpClient.closeSession(
        PLAYWRIGHT_MCP_CATALOG_ID,
        userServer.id,
        agentId,
        isolationKey,
      );
    }
  } catch (error) {
    logger.warn(
      { agentId, userId, isolationKey, error },
      "Failed to close MCP session during A2A cleanup (non-fatal)",
    );
  }

  // For direct A2A calls (not delegated from chat), also close MCP client
  // to free the cache slot. For delegated calls, keep client alive for reuse.
  if (isDirectExecutionOutsideConversation) {
    try {
      closeChatMcpClient(agentId, userId, isolationKey);
    } catch (error) {
      logger.warn(
        { agentId, userId, isolationKey, error },
        "Failed to close MCP client during A2A cleanup (non-fatal)",
      );
    }
  }
}

/**
 * Resolve the model and provider to use for an agent.
 *
 * Priority chain:
 * 1. Agent has llmApiKeyId with llmModel → use the model with provider from the key
 * 2. Agent has llmApiKeyId but no llmModel → use best model for that key
 * 3. Find best model across all available API keys (org_wide > team > personal)
 * 4. Fallback → use config defaults
 */
async function resolveModelForAgent(params: {
  agent: { llmModel: string | null; llmApiKeyId: string | null };
  userId: string;
  organizationId: string;
}): Promise<{ model: string; provider: SupportedChatProvider }> {
  const { agent, userId, organizationId } = params;

  // Priority 1 & 2: Agent has a configured API key
  if (agent.llmApiKeyId) {
    const agentApiKey = await ChatApiKeyModel.findById(agent.llmApiKeyId);
    if (agentApiKey) {
      const provider = agentApiKey.provider as SupportedChatProvider;

      // Priority 1: Key + explicit model
      if (agent.llmModel) {
        logger.debug(
          {
            model: agent.llmModel,
            provider,
            apiKeyId: agent.llmApiKeyId,
            source: "agent.llmApiKeyId+llmModel",
          },
          "Resolved model from agent config with provider from API key",
        );
        return { model: agent.llmModel, provider };
      }

      // Priority 2: Key without model — use best model for that key
      const bestModel = await ApiKeyModelModel.getBestModel(agent.llmApiKeyId);
      if (bestModel) {
        logger.debug(
          {
            model: bestModel.modelId,
            provider,
            apiKeyId: agent.llmApiKeyId,
            source: "agent.llmApiKeyId.bestModel",
          },
          "Resolved best model from agent API key",
        );
        return { model: bestModel.modelId, provider };
      }
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
      const provider = selected.apiKey.provider as SupportedChatProvider;
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
