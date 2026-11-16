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
 * in whole batches of up to {@link STRIP_BATCH_SIZE} browser tool calls: the
 * prefix changes once per batch instead of on every browser call.
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

// Raw size of the older kept calls above which they are stripped before the
// batch fills, so a few huge snapshots cannot outgrow the context window.
const MAX_RETAINED_RAW_CHARS = 100_000;

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

type ToolCallOrigin = { assistantIndex: number; toolName: string | null };

/**
 * Where each tool_call_id was issued, built once per request
 */
function indexToolCalls(messages: Message[]): Map<string, ToolCallOrigin> {
  const origins = new Map<string, ToolCallOrigin>();
  messages.forEach((message, assistantIndex) => {
    if (message.role !== "assistant") return;
    for (const toolCall of message.tool_calls ?? []) {
      if (origins.has(toolCall.id)) continue;
      origins.set(toolCall.id, {
        assistantIndex,
        toolName: toolCall.function?.name ?? null,
      });
    }
  });
  return origins;
}

/**
 * Resolve a tool name for a tool message
 */
function resolveToolName(
  message: Message,
  origins: Map<string, ToolCallOrigin>,
): string {
  if (typeof message.name === "string") {
    return message.name;
  }
  return (
    (message.tool_call_id && origins.get(message.tool_call_id)?.toolName) || ""
  );
}

/**
 * Indexes of the browser tool messages to strip. Calls are walked in order,
 * one call per issuing assistant message, and a cutoff advances to the current
 * call once {@link STRIP_BATCH_SIZE} calls are kept raw or the older raw ones
 * exceed {@link MAX_RETAINED_RAW_CHARS}; every call before the cutoff is
 * stripped. The cutoff depends only on earlier calls, so an append-only
 * conversation keeps its rewritten prefix until the cutoff moves.
 */
function getStrippableBrowserToolIndexes(
  messages: Message[],
  origins: Map<string, ToolCallOrigin>,
): Set<number> {
  const calls: Array<{ indexes: number[]; size: number }> = [];
  const callByKey = new Map<string, number>();

  messages.forEach((message, index) => {
    if (message.role !== "tool") return;
    if (!isBrowserTool(resolveToolName(message, origins))) return;
    const assistantIndex = message.tool_call_id
      ? origins.get(message.tool_call_id)?.assistantIndex
      : undefined;
    const key =
      assistantIndex === undefined
        ? `tool:${index}`
        : `assistant:${assistantIndex}`;
    let call = callByKey.get(key);
    if (call === undefined) {
      call = calls.length;
      callByKey.set(key, call);
      calls.push({ indexes: [], size: 0 });
    }
    calls[call].indexes.push(index);
    calls[call].size += getContentSize(message.content).length;
  });

  let cutoff = 0;
  let retainedSize = 0;
  calls.forEach((call, position) => {
    if (
      position - cutoff >= STRIP_BATCH_SIZE ||
      retainedSize > MAX_RETAINED_RAW_CHARS
    ) {
      cutoff = position;
      retainedSize = 0;
    }
    retainedSize += call.size;
  });

  return new Set(calls.slice(0, cutoff).flatMap((call) => call.indexes));
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

  const origins = indexToolCalls(messages);
  const strippable = getStrippableBrowserToolIndexes(messages, origins);

  let strippedCount = 0;
  let toolMessagesCount = 0;

  const result = messages.map((msg, index): T => {
    if (msg.role !== "tool") return msg;

    toolMessagesCount++;

    // Get tool name - first try direct name field, then look up from tool_call_id
    const toolName = resolveToolName(msg, origins);

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
