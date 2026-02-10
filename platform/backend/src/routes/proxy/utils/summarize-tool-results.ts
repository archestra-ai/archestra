/**
 * Summarize browser tool results to reduce token usage.
 *
 * Browser tools like browser_snapshot return massive YAML accessibility trees
 * that can be 10-50KB+ per call. When these accumulate in conversation history,
 * they quickly exceed token limits.
 *
 * This module replaces old large browser tool results with summaries while keeping
 * the most recent ones intact so the LLM can work with current state.
 */

import { parseFullToolName } from "@shared";
import logger from "@/logging";
import {
  estimateToolResultContentLength,
  previewToolResultContent,
} from "@/utils/tool-result-preview";

// Tool names that produce large outputs that should be summarized
const BROWSER_TOOLS = [
  "browser_snapshot",
  "browser_navigate",
  "browser_tabs",
  // Match with prefixes (e.g., microsoft__playwright-mcp__browser_snapshot)
];

// Size threshold in characters - results larger than this will be stripped
const SIZE_THRESHOLD = 2000;

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

type ToolCall = NonNullable<Message["tool_calls"]>[number];

/**
 * Check if a tool name matches one of the browser tools
 */
function isBrowserTool(toolName: string): boolean {
  const normalizedName = toolName.toLowerCase();
  return BROWSER_TOOLS.some(
    (pattern) =>
      normalizedName === pattern ||
      normalizedName.endsWith(`__${pattern}`) ||
      normalizedName.includes(`__${pattern}`),
  );
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
 * Find the assistant tool_calls that match a tool_call_id
 */
function findAssistantToolCallsForId(
  messages: Message[],
  toolCallId: string,
): ToolCall[] | null {
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls) continue;
    if (message.tool_calls.some((toolCall) => toolCall.id === toolCallId)) {
      return message.tool_calls;
    }
  }
  return null;
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

type BrowserToolTargets = {
  toolCallIds: Set<string>;
  messageIndexes: Set<number>;
};

/**
 * Find the most recent browser tool results to preserve
 */
function getMostRecentBrowserToolTargets(
  messages: Message[],
): BrowserToolTargets {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "tool") continue;

    const toolName = resolveToolName(messages, message);
    if (!toolName || !isBrowserTool(toolName)) continue;

    if (!message.tool_call_id) {
      return { toolCallIds: new Set(), messageIndexes: new Set([i]) };
    }

    const toolCalls = findAssistantToolCallsForId(
      messages,
      message.tool_call_id,
    );
    if (!toolCalls) {
      return {
        toolCallIds: new Set([message.tool_call_id]),
        messageIndexes: new Set(),
      };
    }

    const browserToolCallIds = toolCalls
      .map((toolCall) => {
        const name = toolCall.function?.name;
        if (!name || !isBrowserTool(name)) return null;
        return toolCall.id;
      })
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    return {
      toolCallIds:
        browserToolCallIds.length > 0
          ? new Set(browserToolCallIds)
          : new Set([message.tool_call_id]),
      messageIndexes: new Set(),
    };
  }

  return { toolCallIds: new Set(), messageIndexes: new Set() };
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
 * Keeps the most recent browser tool results intact while summarizing older ones.
 * This allows the LLM to work with current state while not being overwhelmed
 * by accumulated historical snapshots.
 *
 * @param messages - OpenAI format messages
 * @returns Messages with old browser tool results summarized
 */
export function stripBrowserToolsResults<T extends Message>(
  messages: T[],
): T[] {
  logger.info(
    { messageCount: messages.length },
    "[stripBrowserToolsResults] Starting",
  );

  const preserveTargets = getMostRecentBrowserToolTargets(messages);

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

    const shouldPreserve =
      (msg.tool_call_id && preserveTargets.toolCallIds.has(msg.tool_call_id)) ||
      preserveTargets.messageIndexes.has(index);
    if (shouldPreserve) return msg;

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

  logger.info(
    { strippedCount, toolMessagesCount, totalMessages: messages.length },
    "[stripBrowserToolsResults] Completed",
  );

  return result;
}
