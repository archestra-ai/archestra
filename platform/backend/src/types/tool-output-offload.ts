import { z } from "zod";

export interface ToolOutputOffloadConfig {
  enabled: boolean;
  compactPreviewChars: number;
}

export const defaultToolOutputOffloadConfig: ToolOutputOffloadConfig = {
  enabled: true,
  compactPreviewChars: 1200,
};

export interface OffloadedToolAccessConfig {
  readEnabled: boolean;
  searchEnabled: boolean;
  defaultReadMaxChars: number;
  hardReadMaxChars: number;
  defaultSearchMaxResults: number;
  hardSearchMaxResults: number;
  defaultSearchSnippetChars: number;
  hardSearchSnippetChars: number;
}

export const defaultOffloadedToolAccessConfig: OffloadedToolAccessConfig = {
  readEnabled: true,
  searchEnabled: true,
  defaultReadMaxChars: 12000,
  hardReadMaxChars: 50000,
  defaultSearchMaxResults: 5,
  hardSearchMaxResults: 20,
  defaultSearchSnippetChars: 800,
  hardSearchSnippetChars: 3000,
};

export type ToolOutputStatus = "success" | "error" | "partial";

/** Semantic fields stored on the offloaded result block. */
export const ToolResultRefDataV1Schema = z
  .object({
    status: z.enum(["success", "error", "partial"]),
    summary: z.string().min(1).max(512),
    rawRef: z.string().min(1),
  })
  .strict();

export type ToolResultRefDataV1 = z.infer<typeof ToolResultRefDataV1Schema>;

export const ToolResultRefBlockV1Schema = ToolResultRefDataV1Schema.extend({
  type: z.literal("TOOL_RESULT_REF"),
  version: z.literal(1),
  toolResultId: z.string().min(1),
  toolCallId: z.string().min(1).optional(),
  toolName: z.string().min(1),
  rawSizeTokens: z.number().int().nonnegative().optional(),
  rawSizeBytes: z.number().int().nonnegative().optional(),
  compactSizeTokens: z.number().int().nonnegative().optional(),
  compactSizeBytes: z.number().int().nonnegative().optional(),
  offloaded: z.literal(true),
}).strict();

export type ToolResultRefBlockV1 = z.infer<typeof ToolResultRefBlockV1Schema>;

/** Prompt-facing payload — compact, model-readable summary plus short id. */
export const ToolResultSummaryPromptV1Schema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["success", "error", "partial"]),
    summary: z.string().min(1).max(512),
  })
  .strict();

export type ToolResultSummaryPromptV1 = z.infer<
  typeof ToolResultSummaryPromptV1Schema
>;

export interface ToolResultRefBlock extends ToolResultRefBlockV1 {
  /**
   * Persisted on messages in older drafts; not part of the prompt-facing v1
   * schema and stripped before validation/formatting.
   */
  messageId?: string;
  conversationId?: string;
}

export function isToolResultRefBlock(
  value: unknown,
): value is ToolResultRefBlockV1 {
  return ToolResultRefBlockV1Schema.safeParse(value).success;
}

export function isInlineToolResultBlock(
  value: unknown,
): value is InlineToolResultBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as InlineToolResultBlock).type === "TOOL_RESULT_INLINE" &&
    (value as InlineToolResultBlock).offloaded === false
  );
}

function parseWrappedToolResultJson(value: unknown): unknown | null {
  if (typeof value !== "string") return null;
  const match = value
    .trim()
    .match(/^<tool_result_summary>([\s\S]*)<\/tool_result_summary>$/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function parseWrappedToolResultRefPrompt(
  value: unknown,
): ToolResultSummaryPromptV1 | null {
  const parsed = parseWrappedToolResultJson(value);
  if (!parsed) return null;
  const summaryResult = ToolResultSummaryPromptV1Schema.safeParse(parsed);
  if (summaryResult.success) return summaryResult.data;
  return null;
}

export function isWrappedToolResultRef(value: unknown): boolean {
  return parseWrappedToolResultRefPrompt(value) !== null;
}

export function toToolResultSummaryPromptPayload(
  block: ToolResultRefBlockV1,
): ToolResultSummaryPromptV1 {
  return ToolResultSummaryPromptV1Schema.parse({
    id: block.toolResultId,
    status: block.status,
    summary: block.summary,
  });
}

export function validateToolResultRefBlockV1(
  value: unknown,
): ToolResultRefBlockV1 {
  return ToolResultRefBlockV1Schema.parse(value);
}

export function formatToolResultSummaryForPrompt(
  block: ToolResultRefBlockV1,
): string {
  const payload = toToolResultSummaryPromptPayload(
    validateToolResultRefBlockV1(block),
  );
  return `<tool_result_summary>${JSON.stringify(payload)}</tool_result_summary>`;
}

/** @deprecated Use formatToolResultSummaryForPrompt. */
export const formatToolResultRefForPrompt = formatToolResultSummaryForPrompt;

export interface ToolResultRefBlockLegacy {
  type: "TOOL_RESULT_REF";
  toolResultId: string;
  toolCallId?: string;
  messageId?: string;
  conversationId?: string;
  toolName: string;
  status: ToolOutputStatus;
  summary: string;
  rawRef: string;
  rawSizeTokens?: number;
  rawSizeBytes?: number;
  compactSizeTokens?: number;
  compactSizeBytes?: number;
  offloaded: true;
}

export interface InlineToolResultBlock {
  type: "TOOL_RESULT_INLINE";
  toolResultId: string;
  toolCallId?: string;
  messageId?: string;
  conversationId?: string;
  toolName: string;
  status: ToolOutputStatus;
  content: unknown;
  rawSizeTokens?: number;
  rawSizeBytes?: number;
  offloaded: false;
}

export interface ToolArtifactAccessScope {
  orgId?: string;
  userId?: string;
  conversationId: string;
  sessionId?: string;
}

export interface SaveRawToolResultInput {
  conversationId: string;
  messageId?: string;
  toolCallId?: string;
  toolResultId: string;
  toolName: string;
  status: ToolOutputStatus;
  rawInput?: unknown;
  rawOutput: unknown;
  sizeBytes: number;
  estimatedTokens?: number;
}

export interface RawToolResult {
  rawRef: string;
  toolName: string;
  status: ToolOutputStatus;
  rawInput?: unknown;
  rawOutput: unknown;
  sizeBytes: number;
  estimatedTokens?: number;
}

export interface ToolArtifactRef {
  rawRef: string;
  artifactId?: string;
}

export interface ToolArtifactStore {
  saveRawToolResult(input: SaveRawToolResultInput): Promise<ToolArtifactRef>;
  getRawToolResult(
    rawRef: string,
    scope: ToolArtifactAccessScope,
  ): Promise<RawToolResult | null>;
}

export interface ReadOffloadedToolResultInput {
  id?: string;
  /** @deprecated Use id. Accepted for legacy tool calls only. */
  rawRef?: string;
  maxChars?: number;
}

export interface ReadOffloadedToolResultOutput {
  content: string;
  truncated?: boolean;
}

export interface SearchOffloadedToolResultInput {
  id?: string;
  /** @deprecated Use id. Accepted for legacy tool calls only. */
  rawRef?: string;
  query: string;
  maxResults?: number;
  snippetChars?: number;
}

export interface SearchOffloadedToolResultOutput {
  id: string;
  query: string;
  matches: Array<{
    snippet: string;
    offset?: number;
    score?: number;
  }>;
  totalMatches?: number;
}
