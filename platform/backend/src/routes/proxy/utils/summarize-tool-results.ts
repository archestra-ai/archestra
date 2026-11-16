/**
 * Summarize browser tool results to reduce token usage.
 *
 * Browser tools like browser_snapshot return massive YAML accessibility trees
 * that can be 10-50KB+ per call. When these accumulate in conversation history,
 * they quickly exceed token limits.
 *
 * This module replaces old large browser tool results with summaries while keeping
 * the most recent ones intact so the LLM can work with current state.
 *
 * Rewriting an earlier result changes the prompt prefix, so every prompt-cache
 * entry written after it stops matching. Older results are therefore stripped
 * in whole batches of {@link STRIP_BATCH_SIZE} browser tool calls: the prefix
 * changes once per batch instead of on every browser call.
 */

import {
  isLargeResultBrowserMcpTool,
  parseFullToolName,
} from "@archestra/shared";
import logger from "@/logging";
import {
  estimateToolResultContentLength,
  previewToolResultContent,
} from "@/utils/tool-result-preview";

// Size threshold in characters - results larger than this will be stripped
const SIZE_THRESHOLD = 2000;

// Browser tool calls (an assistant message's parallel calls count as one) kept
// raw, at most, before the older ones are stripped together.
const STRIP_BATCH_SIZE = 3;

// Generic message type
interface Message {
  role: string;
  content?: string | unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function?: { name: string; arguments?: string };
  }>;
  [key: string]: unknown;
}

/**
 * Check if a tool name matches one of the browser tools
 */
function isBrowserTool(toolName: string): boolean {
  return isLargeResultBrowserMcpTool(toolName);
}

/**
 * Extract tool name from messages by finding the assistant message
 * that contains the tool_call_id
 */
function extractToolNameFromMessages(
  messages: Message[],
  toolCallId: string,
): string | null {
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls) continue;

    for (const toolCall of message.tool_calls) {
      if (toolCall.id === toolCallId && toolCall.function?.name) {
        return toolCall.function.name;
      }
    }
  }
  return null;
}

/**
 * Index of the assistant message that issued a tool_call_id, or -1
 */
function findAssistantIndexForToolCall(
  messages: Message[],
  toolCallId: string,
): number {
  return messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.tool_calls?.some((toolCall) => toolCall.id === toolCallId),
  );
}

/**
 * Resolve a tool name for a tool message
 */
function resolveToolName(messages: Message[], message: Message): string {
  if (typeof message.name === "string") {
    return message.name;
  }

  if (message.tool_call_id) {
    return extractToolNameFromMessages(messages, message.tool_call_id) || "";
  }

  return "";
}

/**
 * Indexes of the browser tool messages to strip. Calls are numbered in order,
 * one number per issuing assistant message; once the newest number reaches
 * the next multiple of {@link STRIP_BATCH_SIZE}, every call below that
 * multiple is stripped. Numbers depend only on earlier messages, so an
 * append-only conversation keeps its rewritten prefix until the next multiple.
 */
function getStrippableBrowserToolIndexes(messages: Message[]): Set<number> {
  const callNumbers = new Map<string, number>();
  const browserMessages: Array<{ index: number; callNumber: number }> = [];

  messages.forEach((message, index) => {
    if (message.role !== "tool") return;
    if (!isBrowserTool(resolveToolName(messages, message))) return;
    const assistantIndex = message.tool_call_id
      ? findAssistantIndexForToolCall(messages, message.tool_call_id)
      : -1;
    const callKey =
      assistantIndex >= 0 ? `assistant:${assistantIndex}` : `tool:${index}`;
    const callNumber = callNumbers.get(callKey) ?? callNumbers.size;
    callNumbers.set(callKey, callNumber);
    browserMessages.push({ index, callNumber });
  });

  const keepFrom =
    Math.floor(Math.max(callNumbers.size - 1, 0) / STRIP_BATCH_SIZE) *
    STRIP_BATCH_SIZE;
  return new Set(
    browserMessages
      .filter(({ callNumber }) => callNumber < keepFrom)
      .map(({ index }) => index),
  );
}

/**
 * Extract page URL from browser tool result content
 */
function extractPageUrl(content: string | unknown): string {
  const contentStr = previewToolResultContent(content, 4000);

  // Try to find URL patterns in the content
  // Common patterns: "Page URL: https://..." or "url: https://..."
  const urlMatch = contentStr.match(
    /(?:Page URL|url):\s*(https?:\/\/[^\s\n"']+)/i,
  );
  if (urlMatch) {
    return urlMatch[1];
  }

  // Try to find any URL in parentheses like (https://www.example.com/)
  const parenUrlMatch = contentStr.match(/\((https?:\/\/[^)\s]+)\)/);
  if (parenUrlMatch) {
    return parenUrlMatch[1];
  }

  return "unknown";
}

type ContentSize = {
  length: number;
  isEstimated: boolean;
  isLarge: boolean;
};

function getContentSize(content: string | unknown): ContentSize {
  const estimate = estimateToolResultContentLength(content);
  if (estimate.length > SIZE_THRESHOLD) {
    return { ...estimate, isLarge: true };
  }

  const preview = previewToolResultContent(content, SIZE_THRESHOLD + 1);
  return {
    ...estimate,
    isLarge: preview.length > SIZE_THRESHOLD,
  };
}

/**
 * Create a placeholder for a stripped browser tool result
 */
function createPlaceholder(
  toolName: string,
  content: string | unknown,
): string {
  const shortName = parseFullToolName(toolName).toolName || toolName;
  const url = extractPageUrl(content);
  return `[Page ${url} ${shortName} was here]`;
}

/**
 * Summarize browser tool results in messages to reduce token usage.
 *
 * Keeps the most recent browser tool results intact while summarizing older ones
 * in batches (see {@link getStrippableBrowserToolIndexes}). This allows the LLM
 * to work with current state while not being overwhelmed by accumulated
 * historical snapshots.
 *
 * @param messages - OpenAI format messages
 * @returns Messages with old browser tool results summarized
 */
export function stripBrowserToolsResults<T extends Message>(
  messages: T[],
): T[] {
  logger.debug(
    { messageCount: messages.length },
    "[stripBrowserToolsResults] Starting",
  );

  const strippable = getStrippableBrowserToolIndexes(messages);

  let strippedCount = 0;
  let toolMessagesCount = 0;

  const result = messages.map((msg, index): T => {
    if (msg.role !== "tool") return msg;

    toolMessagesCount++;

    // Get tool name - first try direct name field, then look up from tool_call_id
    const toolName = resolveToolName(messages, msg);

    const contentSize = getContentSize(msg.content);

    logger.debug(
      {
        toolName,
        toolCallId: msg.tool_call_id,
        contentLength: contentSize.length,
        contentLengthEstimated: contentSize.isEstimated,
        isBrowser: isBrowserTool(toolName),
      },
      "[stripBrowserToolsResults] Processing tool message",
    );

    // Check if it's a browser tool
    if (!isBrowserTool(toolName)) return msg;

    if (!strippable.has(index)) return msg;

    // Strip if larger than threshold
    if (contentSize.isLarge) {
      strippedCount++;
      logger.info(
        { toolName, contentLength: contentSize.length },
        "[stripBrowserToolsResults] Stripping large result",
      );
      return {
        ...msg,
        content: createPlaceholder(toolName, msg.content),
      } as T;
    }

    return msg;
  });

  logger.debug(
    { strippedCount, toolMessagesCount, totalMessages: messages.length },
    "[stripBrowserToolsResults] Completed",
  );

  return result;
}
