/**
 * Strip base64 image data and large browser tool results from messages before storing.
 *
 * After the LLM has processed images (e.g., screenshots from browser tools),
 * we don't need to keep the full base64 data in conversation history.
 * This prevents context limit issues on subsequent turns.
 *
 * Similarly, browser tool results like browser_snapshot return massive YAML
 * accessibility trees that don't need to be preserved in full.
 *
 * The LLM has already analyzed the content - keeping it in history provides
 * no value and only burns tokens on future requests.
 */

import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import logger from "@/logging";
import {
  estimateToolResultContentLength,
  previewToolResultContent,
} from "@/utils/tool-result-preview";

const IMAGE_STRIPPED_PLACEHOLDER = "[Image data stripped to save context]";

// Browser tools that produce large outputs to be stripped
// These tools return massive page snapshots (YAML accessibility trees)
const BROWSER_TOOLS_TO_STRIP = [
  "browser_snapshot",
  "browser_navigate",
  "browser_take_screenshot",
  "browser_tabs", // Returns page snapshot for current tab
  "browser_click",
  "browser_type",
  "browser_select_option",
  "browser_hover",
  "browser_drag",
  "browser_scroll",
  "browser_wait_for",
  "browser_press_key",
  "browser_evaluate",
];

// Size threshold - results larger than this will be stripped
const BROWSER_RESULT_SIZE_THRESHOLD = 2000;

export type UiMessagePart = {
  type: string;
  output?: unknown;
  result?: unknown;
  toolName?: string;
  text?: string;
  toolCallId?: string;
  source?: unknown;
  [key: string]: unknown;
};

export type UiMessage = {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  parts?: UiMessagePart[];
};

/**
 * Check if a tool name is a browser tool that should have large results stripped
 */
function isBrowserToolToStrip(toolName: string): boolean {
  const normalizedName = toolName.toLowerCase();
  return BROWSER_TOOLS_TO_STRIP.some(
    (pattern) =>
      normalizedName === pattern ||
      normalizedName.endsWith(`__${pattern}`) ||
      normalizedName.includes(`__${pattern}`),
  );
}

/**
 * Extract page URL from browser tool result content for placeholder
 */
function extractPageUrl(content: unknown): string {
  const contentStr = previewToolResultContent(content, 4000);

  // Try to find URL patterns in the content
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

/**
 * Create a placeholder for stripped browser tool result
 */
function createBrowserToolPlaceholder(
  toolName: string,
  content: unknown,
): string {
  const shortName =
    toolName.split(MCP_SERVER_TOOL_NAME_SEPARATOR).pop() || toolName;
  const url = extractPageUrl(content);
  return `[Page ${url} ${shortName} was here]`;
}

function getBrowserResultSize(content: unknown): {
  length: number;
  isEstimated: boolean;
  isLarge: boolean;
} {
  const length = estimateToolResultContentLength(content);
  if (length.length > BROWSER_RESULT_SIZE_THRESHOLD) {
    return { ...length, isLarge: true };
  }

  const preview = previewToolResultContent(
    content,
    BROWSER_RESULT_SIZE_THRESHOLD + 1,
  );
  return {
    ...length,
    isLarge: preview.length > BROWSER_RESULT_SIZE_THRESHOLD,
  };
}

/**
 * Check if a value looks like base64 image data
 * Base64 images are typically long strings (>1000 chars for any real image)
 */
function isBase64ImageData(value: unknown): boolean {
  if (typeof value !== "string") return false;
  // Base64 data URLs or raw base64 that's reasonably long
  if (value.startsWith("data:image/")) return true;
  // Raw base64 - check if it's long enough to be an image and looks like base64
  if (value.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 100))) {
    return true;
  }
  return false;
}

/**
 * Recursively strip base64 image data from an object
 */
function stripImagesFromObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    return isBase64ImageData(obj) ? IMAGE_STRIPPED_PLACEHOLDER : obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => stripImagesFromObject(item));
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Known image data keys
      if (
        (key === "data" || key === "image_data") &&
        isBase64ImageData(value)
      ) {
        result[key] = IMAGE_STRIPPED_PLACEHOLDER;
      } else {
        result[key] = stripImagesFromObject(value);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Convert image content blocks to text placeholders
 * This handles arrays that contain image blocks (e.g., in tool results)
 */
function convertImageBlocksToText(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return stripImagesFromObject(content);
  }

  return content
    .map((item) => {
      if (typeof item !== "object" || item === null) return item;

      // Convert image blocks to text blocks
      if ("type" in item && item.type === "image") {
        return {
          type: "text",
          text: IMAGE_STRIPPED_PLACEHOLDER,
        };
      }

      // Recursively handle nested structures
      return stripImagesFromObject(item);
    })
    .filter((item) => item !== null);
}

/**
 * Strip base64 image data and large browser tool results from a message's parts
 *
 * Handles:
 * - tool-result parts with nested image data (converts image blocks to text)
 * - tool-result parts from browser tools with large results (replaces with placeholder)
 * - image parts (converts to text parts)
 * - Any deeply nested base64 data in results
 */
function stripImagesFromParts(parts: UiMessagePart[]): UiMessagePart[] {
  return parts.map((part) => {
    const partType = part.type;

    // Handle Vercel AI SDK tool parts: type is "tool-{toolName}"
    if (partType?.startsWith("tool-") && part.output !== undefined) {
      // Extract tool name from type (e.g., "tool-microsoft__playwright-mcp__browser_navigate" -> "microsoft__playwright-mcp__browser_navigate")
      const toolName = partType.slice(5); // Remove "tool-" prefix

      // Check if it's a browser tool with large output - strip it
      if (isBrowserToolToStrip(toolName)) {
        const outputSize = getBrowserResultSize(part.output);
        if (outputSize.isLarge) {
          logger.info(
            {
              toolName,
              outputLength: outputSize.length,
              outputLengthEstimated: outputSize.isEstimated,
            },
            "[stripImagesFromParts] Stripping large browser tool output",
          );
          return {
            ...part,
            output: createBrowserToolPlaceholder(toolName, part.output),
          };
        }
      }

      // Strip images from tool output
      return {
        ...part,
        output: convertImageBlocksToText(part.output),
      };
    }

    // Handle legacy tool-result parts (for backwards compatibility)
    if (partType === "tool-result" && part.result !== undefined) {
      const toolName = part.toolName || "";

      if (isBrowserToolToStrip(toolName)) {
        const resultSize = getBrowserResultSize(part.result);
        if (resultSize.isLarge) {
          return {
            ...part,
            result: createBrowserToolPlaceholder(toolName, part.result),
          };
        }
      }

      return {
        ...part,
        result: convertImageBlocksToText(part.result),
      };
    }

    // Handle direct image parts - convert to text part entirely
    if (partType === "image") {
      return {
        type: "text",
        text: IMAGE_STRIPPED_PLACEHOLDER,
      };
    }

    return part;
  });
}

/**
 * Strip base64 image data from messages before storing
 *
 * @param messages - Array of UIMessage objects from AI SDK
 * @returns Messages with base64 image data replaced by placeholders
 */
export function stripImagesFromMessages(messages: UiMessage[]): UiMessage[] {
  logger.info(
    { messageCount: messages.length },
    "[stripImagesFromMessages] Processing messages",
  );

  return messages.map((msg) => {
    if (!msg.parts || !Array.isArray(msg.parts)) {
      return msg;
    }

    logger.debug(
      { msgId: msg.id, partsCount: msg.parts.length },
      "[stripImagesFromMessages] Processing message with parts",
    );

    return {
      ...msg,
      parts: stripImagesFromParts(msg.parts),
    };
  });
}

export const __test = {
  isBase64ImageData,
  stripImagesFromObject,
  IMAGE_STRIPPED_PLACEHOLDER,
};
