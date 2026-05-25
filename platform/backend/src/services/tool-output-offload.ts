import { createHash } from "node:crypto";
import { parseFullToolName, type SupportedProvider } from "@shared";
import { jsonSchema, type Tool } from "ai";
import { eq } from "drizzle-orm";
import { createDirectLLMModel } from "@/clients/llm-client";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import type {
  InlineToolResultBlock,
  OffloadedToolAccessConfig,
  RawToolResult,
  ReadOffloadedToolResultInput,
  ReadOffloadedToolResultOutput,
  SaveRawToolResultInput,
  SearchOffloadedToolResultInput,
  SearchOffloadedToolResultOutput,
  ToolArtifactAccessScope,
  ToolArtifactRef,
  ToolArtifactStore,
  ToolOutputOffloadConfig,
  ToolOutputStatus,
  ToolResultRefBlock,
} from "@/types/tool-output-offload";
import {
  formatToolResultRefForPrompt,
  isInlineToolResultBlock,
  isToolResultRefBlock,
  parseWrappedToolResultRefPrompt,
  validateToolResultRefBlockV1,
} from "@/types/tool-output-offload";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import {
  createToolOutputLlmSummarizer,
  type ToolOutputLlmSummarizer,
} from "./tool-output-llm-summarizer";

export {
  formatToolResultRefForPrompt,
  formatToolResultSummaryForPrompt,
} from "@/types/tool-output-offload";

/**
 * Text shape used for context-window estimates — mirrors what the model sees
 * from tool parts (ref wrapper, inline JSON, or plain execute output).
 */
export function getToolPartTextForContextEstimate(output: unknown): string {
  if (output === undefined) return "";

  if (typeof output === "string") {
    return output;
  }

  const embeddedBlock = extractEmbeddedToolResultBlock(output);
  if (embeddedBlock) {
    return embeddedBlock.type === "TOOL_RESULT_REF"
      ? formatToolResultRefForPrompt(embeddedBlock)
      : stringifyToolInlineContent(embeddedBlock.content);
  }

  if (isRecord(output)) {
    if (typeof output.content === "string") {
      return output.content;
    }
  }

  return serializeReadable(output);
}

function stringifyToolInlineContent(content: unknown): string {
  return typeof content === "string" ? content : serializeReadable(content);
}

export interface ToolOutputSummarizerContext {
  organizationId: string;
  userId?: string;
  provider: SupportedProvider;
  modelName: string;
  agentLlmApiKeyId?: string | null;
}

const RAW_REF_PREFIX = "tool-output://conversation/";
const INLINE_MAX_TOKENS = 1000;
const INLINE_MAX_BYTES = 8000;
const LARGE_MIN_TOKENS = 4000;
const LARGE_MIN_BYTES = 32000;
export const OFFLOADED_TOOL_ACCESS_TOOL_NAMES = [
  "read_tool_result",
  "search_tool_result",
  "read_offloaded_tool_result",
  "search_offloaded_tool_result",
] as const;

const OFFLOADED_TOOL_ACCESS_TOOL_NAME_SET = new Set<string>(
  OFFLOADED_TOOL_ACCESS_TOOL_NAMES,
);

export function isOffloadedToolAccessToolName(toolName: string): boolean {
  if (OFFLOADED_TOOL_ACCESS_TOOL_NAME_SET.has(toolName)) return true;
  const { toolName: parsedName } = parseFullToolName(toolName);
  return OFFLOADED_TOOL_ACCESS_TOOL_NAME_SET.has(parsedName);
}

function buildInlineToolResultBlock(input: {
  conversationId: string;
  messageId?: string;
  toolCallId?: string;
  toolResultId: string;
  toolName: string;
  status: ToolOutputStatus;
  content: unknown;
}): InlineToolResultBlock {
  const size = estimateToolResultSize(input.content);
  return {
    type: "TOOL_RESULT_INLINE",
    toolResultId: input.toolResultId,
    toolCallId: input.toolCallId,
    messageId: input.messageId,
    conversationId: input.conversationId,
    toolName: input.toolName,
    status: input.status,
    content: input.content,
    rawSizeTokens: size.tokens,
    rawSizeBytes: size.bytes,
    offloaded: false,
  };
}

export function buildToolOutputRawRef(params: {
  conversationId: string;
  toolResultId: string;
  messageId?: string;
  toolCallId?: string;
}): string {
  return `${RAW_REF_PREFIX}${params.conversationId}/tool-result/${params.toolResultId}`;
}

export function parseToolOutputRawRef(
  rawRef: string,
): { conversationId: string; toolResultId: string } | null {
  if (!rawRef.startsWith(RAW_REF_PREFIX)) return null;
  const rest = rawRef.slice(RAW_REF_PREFIX.length);
  const match = rest.match(/^([^/]+)\/tool-result\/([^/]+)$/);
  if (!match) return null;
  return {
    conversationId: decodeURIComponent(match[1]),
    toolResultId: decodeURIComponent(match[2]),
  };
}

export function estimateToolResultSize(raw: unknown): {
  text: string;
  bytes: number;
  tokens: number;
} {
  const text = serializeReadable(raw);
  return {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    tokens: Math.ceil(text.length / 4),
  };
}

export function shouldOffloadToolOutput(input: {
  toolName?: string;
  rawSizeTokens: number;
  rawSizeBytes: number;
}): boolean {
  if (input.toolName && isOffloadedToolAccessToolName(input.toolName)) {
    return false;
  }
  if (input.rawSizeTokens > LARGE_MIN_TOKENS) return true;
  if (input.rawSizeBytes > LARGE_MIN_BYTES) return true;
  return (
    input.rawSizeTokens >= INLINE_MAX_TOKENS ||
    input.rawSizeBytes >= INLINE_MAX_BYTES
  );
}

export async function createDefaultToolOutputSummarizer(
  context: ToolOutputSummarizerContext,
  conversationId?: string,
): Promise<ToolOutputLlmSummarizer> {
  const { apiKey, baseUrl } = await resolveProviderApiKey({
    organizationId: context.organizationId,
    userId: context.userId,
    provider: context.provider,
    conversationId,
    agentLlmApiKeyId: context.agentLlmApiKeyId,
  });

  return createToolOutputLlmSummarizer({
    model: createDirectLLMModel({
      provider: context.provider,
      apiKey,
      modelName: context.modelName,
      baseUrl,
    }),
    modelName: `${context.provider}:${context.modelName}`,
  });
}

async function resolveToolOutputSummarizer(input: {
  conversationId: string;
  summarizer?: ToolOutputLlmSummarizer;
  summarizerContext?: ToolOutputSummarizerContext;
}): Promise<ToolOutputLlmSummarizer> {
  if (input.summarizer) return input.summarizer;
  if (input.summarizerContext) {
    return createDefaultToolOutputSummarizer(
      input.summarizerContext,
      input.conversationId,
    );
  }
  return createToolOutputLlmSummarizer();
}

export async function compactToolResultForPrompt(input: {
  conversationId: string;
  messageId?: string;
  toolCallId?: string;
  toolResultId: string;
  toolName: string;
  status: ToolOutputStatus;
  rawInput?: unknown;
  rawOutput: unknown;
  config: ToolOutputOffloadConfig;
  store: ToolArtifactStore;
  summarizer?: ToolOutputLlmSummarizer;
  summarizerContext?: ToolOutputSummarizerContext;
}): Promise<ToolResultRefBlock | InlineToolResultBlock> {
  const embeddedBlock = extractEmbeddedToolResultBlock(input.rawOutput);
  if (embeddedBlock) {
    return embeddedBlock;
  }
  const wrappedPrompt = parseWrappedToolResultRefPrompt(input.rawOutput);
  if (wrappedPrompt) {
    return validateToolResultRefBlockV1({
      type: "TOOL_RESULT_REF",
      version: 1,
      toolResultId: wrappedPrompt.id,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      status: wrappedPrompt.status,
      summary: wrappedPrompt.summary,
      rawRef: buildToolOutputRawRef({
        conversationId: input.conversationId,
        toolResultId: wrappedPrompt.id,
      }),
      offloaded: true,
    });
  }

  const size = estimateToolResultSize(input.rawOutput);
  const rawText = size.text;
  const preview = buildToolOutputPreview({
    rawText,
    maxChars: input.config.compactPreviewChars,
  });
  const summarySourceText = preview.truncated
    ? `${preview.text}\n\n[TOOL_OUTPUT_PREVIEW_TRUNCATED at ${preview.maxChars} chars of ${rawText.length}]`
    : preview.text;

  if (isOffloadedToolAccessToolName(input.toolName)) {
    return buildInlineToolResultBlock({
      conversationId: input.conversationId,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      toolResultId: input.toolResultId,
      toolName: input.toolName,
      status: input.status,
      content: input.rawOutput,
    });
  }

  const shouldOffload = shouldOffloadToolOutput({
    toolName: input.toolName,
    rawSizeTokens: size.tokens,
    rawSizeBytes: size.bytes,
  });

  if (!input.config.enabled || !shouldOffload) {
    return {
      type: "TOOL_RESULT_INLINE",
      toolResultId: input.toolResultId,
      toolCallId: input.toolCallId,
      messageId: input.messageId,
      conversationId: input.conversationId,
      toolName: input.toolName,
      status: input.status,
      content: input.rawOutput,
      rawSizeTokens: size.tokens,
      rawSizeBytes: size.bytes,
      offloaded: false,
    };
  }

  const rawRef = buildToolOutputRawRef(input);
  await input.store.saveRawToolResult({
    conversationId: input.conversationId,
    messageId: input.messageId,
    toolCallId: input.toolCallId,
    toolResultId: input.toolResultId,
    toolName: input.toolName,
    status: input.status,
    rawInput: input.rawInput,
    rawOutput: input.rawOutput,
    sizeBytes: size.bytes,
    estimatedTokens: size.tokens,
  });

  const immutableFields = {
    type: "TOOL_RESULT_REF" as const,
    version: 1 as const,
    toolResultId: input.toolResultId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    status: input.status,
    rawRef,
    rawSizeTokens: size.tokens,
    rawSizeBytes: size.bytes,
    offloaded: true as const,
  };
  const summarizer = await resolveToolOutputSummarizer({
    conversationId: input.conversationId,
    summarizer: input.summarizer,
    summarizerContext: input.summarizerContext,
  });
  const summaryResult = await summarizer.summarize({
    rawOutputText: summarySourceText,
    toolMetadata: {
      toolName: input.toolName,
      status: input.status,
      rawInput: input.rawInput,
    },
    immutableFields,
  });
  const compactSize = estimateToolResultSize(
    JSON.stringify(summaryResult.block),
  );
  const block = validateToolResultRefBlockV1({
    ...summaryResult.block,
    ...immutableFields,
    compactSizeTokens: compactSize.tokens,
    compactSizeBytes: compactSize.bytes,
  });

  logger.info(
    {
      conversationId: input.conversationId,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      toolResultId: input.toolResultId,
      toolName: input.toolName,
      offloaded: true,
      rawSizeTokens: size.tokens,
      rawSizeBytes: size.bytes,
      compactSizeTokens: compactSize.tokens,
      compactSizeBytes: compactSize.bytes,
      tokensSaved: size.tokens - compactSize.tokens,
      rawRef,
      previewChars: input.config.compactPreviewChars,
      summaryMethod: summaryResult.summaryMethod,
      summaryPromptVersion: "v1",
    },
    "[ToolOutputOffload] compacted tool result for model context",
  );

  return block;
}

export async function compactToolOutputsForPrompt(input: {
  conversationId: string;
  messagesOrEvents: unknown[];
  config: ToolOutputOffloadConfig;
  store: ToolArtifactStore;
  summarizer?: ToolOutputLlmSummarizer;
  summarizerContext?: ToolOutputSummarizerContext;
}): Promise<unknown[]> {
  const summarizer =
    input.summarizer ??
    (input.summarizerContext
      ? await createDefaultToolOutputSummarizer(
          input.summarizerContext,
          input.conversationId,
        )
      : undefined);

  return await Promise.all(
    input.messagesOrEvents.map(async (message, messageIndex) => {
      if (!isRecord(message) || !Array.isArray(message.parts)) {
        return message;
      }

      const nextParts = await Promise.all(
        message.parts.map(async (part: unknown, partIndex: number) => {
          if (!isToolOutputPart(part)) return part;
          const existingOutput = part.output ?? part.result;
          if (
            isToolResultRefBlock(existingOutput) ||
            parseWrappedToolResultRefPrompt(existingOutput) ||
            isInlineToolResultBlock(existingOutput)
          ) {
            return part;
          }

          const toolName = getToolName(part);
          if (isOffloadedToolAccessToolName(toolName)) {
            return part;
          }
          const toolCallId = getString(part.toolCallId);
          const messageId = getString(message.id);
          const toolResultId = buildToolResultId({
            conversationId: input.conversationId,
            messageId,
            toolCallId,
            toolName,
            messageIndex,
            partIndex,
          });
          const block = await compactToolResultForPrompt({
            conversationId: input.conversationId,
            messageId,
            toolCallId,
            toolResultId,
            toolName,
            status: part.state === "output-error" ? "error" : "success",
            rawInput: part.input,
            rawOutput: existingOutput,
            config: input.config,
            store: input.store,
            summarizer,
            summarizerContext: input.summarizerContext,
          });

          return {
            ...part,
            output: block,
            result: block,
          };
        }),
      );

      return {
        ...message,
        parts: nextParts,
      };
    }),
  );
}

export class DbToolArtifactStore implements ToolArtifactStore {
  async saveRawToolResult(
    input: SaveRawToolResultInput,
  ): Promise<ToolArtifactRef> {
    const rawRef = buildToolOutputRawRef(input);
    const serialized = serializeReadable(input.rawOutput);
    await db
      .insert(schema.toolOutputArtifactsTable)
      .values({
        id: input.toolResultId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        toolCallId: input.toolCallId,
        toolResultId: input.toolResultId,
        toolName: input.toolName,
        status: input.status,
        rawInputJson: toJsonbValue(input.rawInput),
        rawOutputJson: toJsonbValue(input.rawOutput),
        rawOutputText:
          typeof input.rawOutput === "string" ? input.rawOutput : serialized,
        sizeBytes: input.sizeBytes,
        estimatedTokens: input.estimatedTokens,
      })
      .onConflictDoUpdate({
        target: schema.toolOutputArtifactsTable.id,
        set: {
          messageId: input.messageId,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          status: input.status,
          rawInputJson: toJsonbValue(input.rawInput),
          rawOutputJson: toJsonbValue(input.rawOutput),
          rawOutputText:
            typeof input.rawOutput === "string" ? input.rawOutput : serialized,
          sizeBytes: input.sizeBytes,
          estimatedTokens: input.estimatedTokens,
        },
      });

    return { rawRef, artifactId: input.toolResultId };
  }

  async getRawToolResult(
    rawRef: string,
    scope: ToolArtifactAccessScope,
  ): Promise<RawToolResult | null> {
    const parsed = parseToolOutputRawRef(rawRef);
    if (!parsed || parsed.conversationId !== scope.conversationId) {
      return null;
    }

    const [row] = await db
      .select()
      .from(schema.toolOutputArtifactsTable)
      .where(eq(schema.toolOutputArtifactsTable.id, parsed.toolResultId));

    if (!row || row.conversationId !== scope.conversationId) {
      return null;
    }

    return {
      rawRef,
      toolName: row.toolName,
      status: row.status,
      rawInput: row.rawInputJson,
      rawOutput: row.rawOutputJson ?? row.rawOutputText,
      sizeBytes: row.sizeBytes,
      estimatedTokens: row.estimatedTokens ?? undefined,
    };
  }
}

export function createOffloadedToolAccessTools(params: {
  conversationId?: string;
  config?: OffloadedToolAccessConfig;
  store?: ToolArtifactStore;
}): Record<string, Tool> {
  const accessConfig = params.config ?? config.chat.offloadedToolAccess;
  const store = params.store ?? new DbToolArtifactStore();
  const tools: Record<string, Tool> = {};

  if (accessConfig.readEnabled) {
    tools.read_tool_result = {
      description:
        "Read bounded raw content for a summarized tool result by id. Use only for <tool_result_summary> blocks from the current conversation.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          id: { type: "string" },
          rawRef: {
            type: "string",
            description: "Deprecated legacy identifier. Use id instead.",
          },
          maxChars: { type: "number" },
        },
        additionalProperties: false,
      }),
      execute: async (args: unknown) =>
        readOffloadedToolResult({
          input: coerceReadInput(args),
          conversationId: params.conversationId,
          config: accessConfig,
          store,
        }),
    };
  }

  if (accessConfig.searchEnabled) {
    tools.search_tool_result = {
      description:
        "Search inside one summarized tool result's raw content by id and return bounded snippets. Prefer this before reading raw content.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          id: { type: "string" },
          rawRef: {
            type: "string",
            description: "Deprecated legacy identifier. Use id instead.",
          },
          query: { type: "string" },
          maxResults: { type: "number" },
          snippetChars: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      }),
      execute: async (args: unknown) =>
        searchOffloadedToolResult({
          input: coerceSearchInput(args),
          conversationId: params.conversationId,
          config: accessConfig,
          store,
        }),
    };
  }

  return tools;
}

export async function readOffloadedToolResult(params: {
  input: ReadOffloadedToolResultInput;
  conversationId?: string;
  config: OffloadedToolAccessConfig;
  store: ToolArtifactStore;
}): Promise<ReadOffloadedToolResultOutput> {
  const conversationId = params.conversationId;
  if (!conversationId) {
    throw new Error(
      "Offloaded tool result access is unavailable without conversation scope",
    );
  }

  const maxChars = clampPositiveInt(
    params.input.maxChars,
    params.config.defaultReadMaxChars,
    params.config.hardReadMaxChars,
  );
  const resultRef = resolveToolResultAccessRef(params.input, conversationId);
  const raw = await params.store.getRawToolResult(resultRef.rawRef, {
    conversationId,
  });
  if (!raw) {
    logger.info(
      {
        conversationId,
        id: resultRef.id,
        rawRef: resultRef.rawRef,
        toolName: "read_tool_result",
        accessGranted: false,
        returnedChars: 0,
        truncated: false,
        queryPresent: false,
        matchesReturned: 0,
      },
      "[ToolOutputOffload] denied offloaded result read",
    );
    throw new Error(
      "Offloaded tool result is not available in this conversation",
    );
  }

  const content = serializeRawToolResult(raw);
  const bounded = content.slice(0, maxChars);
  const truncated = bounded.length < content.length;
  logger.info(
    {
      conversationId,
      id: resultRef.id,
      rawRef: resultRef.rawRef,
      toolName: "read_tool_result",
      accessGranted: true,
      returnedChars: bounded.length,
      truncated,
      queryPresent: false,
      matchesReturned: 0,
    },
    "[ToolOutputOffload] read offloaded result",
  );

  return {
    content: bounded,
    ...(truncated ? { truncated: true } : {}),
  };
}

export async function searchOffloadedToolResult(params: {
  input: SearchOffloadedToolResultInput;
  conversationId?: string;
  config: OffloadedToolAccessConfig;
  store: ToolArtifactStore;
}): Promise<SearchOffloadedToolResultOutput> {
  const conversationId = params.conversationId;
  if (!conversationId) {
    throw new Error(
      "Offloaded tool result access is unavailable without conversation scope",
    );
  }

  const query = params.input.query.trim();
  const resultRef = resolveToolResultAccessRef(params.input, conversationId);
  if (!query) {
    return { id: resultRef.id, query, matches: [], totalMatches: 0 };
  }

  const maxResults = clampPositiveInt(
    params.input.maxResults,
    params.config.defaultSearchMaxResults,
    params.config.hardSearchMaxResults,
  );
  const snippetChars = clampPositiveInt(
    params.input.snippetChars,
    params.config.defaultSearchSnippetChars,
    params.config.hardSearchSnippetChars,
  );
  const raw = await params.store.getRawToolResult(resultRef.rawRef, {
    conversationId,
  });
  if (!raw) {
    logger.info(
      {
        conversationId,
        id: resultRef.id,
        rawRef: resultRef.rawRef,
        toolName: "search_tool_result",
        accessGranted: false,
        returnedChars: 0,
        truncated: false,
        queryPresent: true,
        matchesReturned: 0,
      },
      "[ToolOutputOffload] denied offloaded result search",
    );
    throw new Error(
      "Offloaded tool result is not available in this conversation",
    );
  }

  const content = serializeRawToolResult(raw);
  const lower = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matches: SearchOffloadedToolResultOutput["matches"] = [];
  let totalMatches = 0;
  let offset = lower.indexOf(lowerQuery);

  while (offset >= 0) {
    totalMatches += 1;
    if (matches.length < maxResults) {
      const start = Math.max(0, offset - Math.floor(snippetChars / 2));
      const end = Math.min(content.length, start + snippetChars);
      matches.push({
        snippet: content.slice(start, end),
        offset,
        score: 1,
      });
    }
    offset = lower.indexOf(lowerQuery, offset + lowerQuery.length);
  }

  logger.info(
    {
      conversationId,
      id: resultRef.id,
      rawRef: resultRef.rawRef,
      toolName: "search_tool_result",
      accessGranted: true,
      returnedChars: matches.reduce(
        (sum, match) => sum + match.snippet.length,
        0,
      ),
      truncated: totalMatches > matches.length,
      queryPresent: true,
      matchesReturned: matches.length,
    },
    "[ToolOutputOffload] searched offloaded result",
  );

  return {
    id: resultRef.id,
    query,
    matches,
    totalMatches,
  };
}

export function buildToolResultId(params: {
  conversationId: string;
  messageId?: string;
  toolCallId?: string;
  toolName: string;
  messageIndex?: number;
  partIndex?: number;
}): string {
  if (params.toolCallId) return `tool_result_${params.toolCallId}`;
  const hash = createHash("sha256")
    .update(
      [
        params.conversationId,
        params.messageId ?? "",
        params.toolName,
        String(params.messageIndex ?? 0),
        String(params.partIndex ?? 0),
      ].join(":"),
    )
    .digest("hex")
    .slice(0, 24);
  return `tool_result_${hash}`;
}

export function serializeReadable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);

  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (_key, nested) => {
        if (typeof nested === "bigint") return nested.toString();
        if (typeof nested === "object" && nested !== null) {
          if (seen.has(nested)) return "[Circular]";
          seen.add(nested);
        }
        return nested;
      },
      2,
    );
  } catch {
    return String(value);
  }
}

function serializeRawToolResult(raw: RawToolResult): string {
  if (typeof raw.rawOutput === "string") {
    return raw.rawOutput;
  }
  return serializeReadable(raw.rawOutput);
}

function toJsonbValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(serializeReadable(value));
  } catch {
    return serializeReadable(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractEmbeddedToolResultBlock(
  value: unknown,
): ToolResultRefBlock | InlineToolResultBlock | null {
  if (isToolResultRefBlock(value) || isInlineToolResultBlock(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return null;
  }
  const meta = value._meta;
  if (!isRecord(meta)) {
    return null;
  }
  if (isToolResultRefBlock(meta.toolResultRefBlock)) {
    return meta.toolResultRefBlock;
  }
  if (isInlineToolResultBlock(meta.toolResultInlineBlock)) {
    return meta.toolResultInlineBlock;
  }
  return null;
}

function isToolOutputPart(part: unknown): part is Record<string, unknown> {
  return (
    isRecord(part) &&
    typeof part.type === "string" &&
    part.type.startsWith("tool-") &&
    ("output" in part || "result" in part) &&
    (part.state === undefined ||
      part.state === "output-available" ||
      part.state === "output-error")
  );
}

function getToolName(part: Record<string, unknown>): string {
  return getString(part.toolName) ?? String(part.type).replace(/^tool-/, "");
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clampPositiveInt(
  value: number | undefined,
  defaultValue: number,
  hardLimit: number,
): number {
  if (!value || !Number.isFinite(value) || value <= 0) return defaultValue;
  return Math.min(Math.floor(value), hardLimit);
}

function buildToolOutputPreview(params: {
  rawText: string;
  maxChars: number;
}): { text: string; truncated: boolean; maxChars: number } {
  if (!Number.isFinite(params.maxChars) || params.maxChars <= 0) {
    return {
      text: params.rawText,
      truncated: false,
      maxChars: params.rawText.length,
    };
  }
  if (params.rawText.length <= params.maxChars) {
    return {
      text: params.rawText,
      truncated: false,
      maxChars: params.maxChars,
    };
  }
  return {
    text: params.rawText.slice(0, params.maxChars).trimEnd(),
    truncated: true,
    maxChars: params.maxChars,
  };
}

function resolveToolResultAccessRef(
  input: { id?: string; rawRef?: string },
  conversationId: string,
): { id: string; rawRef: string } {
  if (typeof input.id === "string" && input.id.length > 0) {
    return {
      id: input.id,
      rawRef: buildToolOutputRawRef({
        conversationId,
        toolResultId: input.id,
      }),
    };
  }
  if (typeof input.rawRef === "string" && input.rawRef.length > 0) {
    const parsed = parseToolOutputRawRef(input.rawRef);
    return {
      id: parsed?.toolResultId ?? input.rawRef,
      rawRef: input.rawRef,
    };
  }
  throw new Error("id is required");
}

function coerceReadInput(args: unknown): ReadOffloadedToolResultInput {
  if (
    !isRecord(args) ||
    (typeof args.id !== "string" && typeof args.rawRef !== "string")
  ) {
    throw new Error("id is required");
  }
  return {
    id: typeof args.id === "string" ? args.id : undefined,
    rawRef: typeof args.rawRef === "string" ? args.rawRef : undefined,
    maxChars: typeof args.maxChars === "number" ? args.maxChars : undefined,
  };
}

function coerceSearchInput(args: unknown): SearchOffloadedToolResultInput {
  if (
    !isRecord(args) ||
    (typeof args.id !== "string" && typeof args.rawRef !== "string") ||
    typeof args.query !== "string"
  ) {
    throw new Error("id and query are required");
  }
  return {
    id: typeof args.id === "string" ? args.id : undefined,
    rawRef: typeof args.rawRef === "string" ? args.rawRef : undefined,
    query: args.query,
    maxResults:
      typeof args.maxResults === "number" ? args.maxResults : undefined,
    snippetChars:
      typeof args.snippetChars === "number" ? args.snippetChars : undefined,
  };
}
