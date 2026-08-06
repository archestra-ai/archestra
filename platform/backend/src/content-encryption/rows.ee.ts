// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  type ContentEncryptionContext,
  decryptContentValue,
  encryptContentValue,
} from "./index.ee";

/**
 * Row-level helpers binding each encrypted column to its AAD context. They
 * mutate in place and accept BOTH drizzle camelCase rows and raw-SQL
 * snake_case rows, so every read path — model selects, RETURNING rows, and
 * the delta manager's recursive CTE — funnels through one implementation.
 * Plaintext values pass through untouched (see decryptContentValue).
 */

export function decryptInteractionRow<T extends object>(row: T): T {
  const target = row as Record<string, unknown>;
  for (const [key, context] of INTERACTION_COLUMN_CONTEXTS) {
    if (key in target) {
      target[key] = decryptContentValue(target[key], context);
    }
  }
  return row;
}

/** Encrypt the content-bearing fields of an interaction insert, in place. */
export function encryptInteractionInsert<T extends object>(values: T): T {
  const target = values as Record<string, unknown>;
  for (const [key, context] of INTERACTION_COLUMN_CONTEXTS) {
    if (key in target && target[key] !== null && target[key] !== undefined) {
      target[key] = encryptContentValue(target[key], context);
    }
  }
  return values;
}

export function decryptMcpToolCallRow<T extends object>(row: T): T {
  const target = row as Record<string, unknown>;
  for (const [key, context] of MCP_TOOL_CALL_COLUMN_CONTEXTS) {
    if (key in target) {
      target[key] = decryptContentValue(target[key], context);
    }
  }
  return row;
}

/** Encrypt the content-bearing fields of a tool-call insert, in place. */
export function encryptMcpToolCallInsert<T extends object>(values: T): T {
  const target = values as Record<string, unknown>;
  for (const [key, context] of MCP_TOOL_CALL_COLUMN_CONTEXTS) {
    if (key in target && target[key] !== null && target[key] !== undefined) {
      target[key] = encryptContentValue(target[key], context);
    }
  }
  return values;
}

export function decryptMessageRow<T extends object>(row: T): T {
  const target = row as Record<string, unknown>;
  if ("content" in target) {
    target.content = decryptContentValue(target.content, "messages.content");
  }
  return row;
}

export function encryptMessageContent<T>(content: T): unknown {
  return encryptContentValue(content, "messages.content");
}

// === Internal ===

/**
 * camelCase (drizzle) and snake_case (raw SQL) spellings of each encrypted
 * tool-call column, mapped to its AAD context.
 */
const MCP_TOOL_CALL_COLUMN_CONTEXTS: Array<[string, ContentEncryptionContext]> =
  [
    ["toolCall", "mcp_tool_calls.tool_call"],
    ["tool_call", "mcp_tool_calls.tool_call"],
    ["toolResult", "mcp_tool_calls.tool_result"],
    ["tool_result", "mcp_tool_calls.tool_result"],
  ];

/**
 * camelCase (drizzle) and snake_case (raw SQL) spellings of each encrypted
 * interaction column, mapped to its AAD context.
 */
const INTERACTION_COLUMN_CONTEXTS: Array<[string, ContentEncryptionContext]> = [
  ["request", "interactions.request"],
  ["processedRequest", "interactions.processed_request"],
  ["processed_request", "interactions.processed_request"],
  ["response", "interactions.response"],
  ["dualLlmAnalyses", "interactions.dual_llm_analyses"],
  ["dual_llm_analyses", "interactions.dual_llm_analyses"],
  ["unsafeContextBoundary", "interactions.unsafe_context_boundary"],
  ["unsafe_context_boundary", "interactions.unsafe_context_boundary"],
];
