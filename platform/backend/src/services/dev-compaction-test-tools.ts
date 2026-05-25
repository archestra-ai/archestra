import { createHash, randomUUID } from "node:crypto";
import { jsonSchema, type Tool } from "ai";
import config from "@/config";
import type { ToolOutputLlmSummarizer } from "@/services/tool-output-llm-summarizer";
import {
  buildToolResultId,
  compactToolResultForPrompt,
  DbToolArtifactStore,
} from "@/services/tool-output-offload";

const DEV_TOOL_PREFIX = "dev_compaction_";
const DEFAULT_PADDING_CHARS = 50_000;
const FILLER_LINE =
  "compaction-padding-line: lorem ipsum dolor sit amet consectetur adipiscing elit ";

export interface DevCompactionTestToolsConfig {
  enabled: boolean;
  defaultPaddingChars: number;
}

export interface CompactionTestFacts {
  seed: string;
  compaction_fact: string;
  compaction_issue: string;
  compaction_url: string;
  compaction_commit: string;
}

// =============================================================================
// Exported API
// =============================================================================

export function createDevCompactionTestTools(params: {
  conversationId?: string;
  toolConfig?: DevCompactionTestToolsConfig;
  summarizer?: ToolOutputLlmSummarizer;
}): Record<string, Tool> {
  const toolConfig = params.toolConfig ?? config.chat.devCompactionTestTools;
  if (!toolConfig.enabled) {
    return {};
  }

  const wrapResult = (input: {
    toolCallId: string;
    toolName: string;
    status: "success" | "error";
    rawInput?: unknown;
    rawOutput: unknown;
    content: string;
  }) =>
    wrapDevToolResultForModel({
      conversationId: params.conversationId,
      summarizer: params.summarizer,
      ...input,
    });

  return {
    [`${DEV_TOOL_PREFIX}ping`]: {
      description:
        "Dev-only: verify tool calling works. Returns a short deterministic acknowledgement.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Optional message echoed in the response",
          },
        },
        additionalProperties: false,
      }),
      execute: async (args: unknown) => {
        const message = coerceOptionalString(args, "message") ?? "pong";
        const rawOutput = {
          ok: true,
          tool: `${DEV_TOOL_PREFIX}ping`,
          message,
          serverTime: new Date().toISOString(),
        };
        return wrapResult({
          toolCallId: randomUUID(),
          toolName: `${DEV_TOOL_PREFIX}ping`,
          status: "success",
          rawInput: args,
          rawOutput,
          content: JSON.stringify(rawOutput, null, 2),
        });
      },
    },
    [`${DEV_TOOL_PREFIX}large_output`]: {
      description:
        "Dev-only: return a deterministic large tool result with embedded compaction-test facts (issue keys, URLs, commits). Use to exercise tool output offload and summarization before /compact.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          seed: {
            type: "string",
            description:
              "Deterministic seed for embedded facts (e.g. run-1, scenario-a)",
          },
          paddingChars: {
            type: "number",
            description: `Approximate padding size in characters (default ${toolConfig.defaultPaddingChars})`,
          },
          itemCount: {
            type: "number",
            description:
              "Number of filler rows in the results array (default 120)",
          },
        },
        required: ["seed"],
        additionalProperties: false,
      }),
      execute: async (args: unknown) => {
        const seed = requireString(args, "seed");
        const paddingChars = clampPaddingChars(
          coerceOptionalNumber(args, "paddingChars"),
          toolConfig.defaultPaddingChars,
        );
        const itemCount = clampItemCount(
          coerceOptionalNumber(args, "itemCount"),
        );
        const facts = buildCompactionTestFacts(seed);
        const rawOutput = buildLargeOutputPayload({
          facts,
          paddingChars,
          itemCount,
        });
        const content = serializeLargeToolContent(rawOutput);
        return wrapResult({
          toolCallId: randomUUID(),
          toolName: `${DEV_TOOL_PREFIX}large_output`,
          status: "success",
          rawInput: args,
          rawOutput,
          content,
        });
      },
    },
    [`${DEV_TOOL_PREFIX}recall_facts`]: {
      description:
        "Dev-only: recompute the deterministic compaction-test facts for a seed. After /compact, call this to verify whether earlier tool summaries preserved the same fact identifiers.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          seed: {
            type: "string",
            description: "Seed used when generating large tool output",
          },
        },
        required: ["seed"],
        additionalProperties: false,
      }),
      execute: async (args: unknown) => {
        const seed = requireString(args, "seed");
        const facts = buildCompactionTestFacts(seed);
        const rawOutput = {
          tool: `${DEV_TOOL_PREFIX}recall_facts`,
          facts,
          verificationHint:
            "Compare these values to facts quoted before context compaction.",
        };
        return wrapResult({
          toolCallId: randomUUID(),
          toolName: `${DEV_TOOL_PREFIX}recall_facts`,
          status: "success",
          rawInput: args,
          rawOutput,
          content: JSON.stringify(rawOutput, null, 2),
        });
      },
    },
  };
}

export function buildCompactionTestFacts(seed: string): CompactionTestFacts {
  const normalizedSeed = seed.trim();
  const hash = createHash("sha256").update(normalizedSeed).digest("hex");
  return {
    seed: normalizedSeed,
    compaction_fact: `COMPACTION-TEST-FACT-${hash.slice(0, 8).toUpperCase()}`,
    compaction_issue: `PROJ-${hash.slice(8, 14).toUpperCase()}`,
    compaction_url: `https://compaction-test.example.com/runs/${encodeURIComponent(normalizedSeed)}`,
    compaction_commit: hash.slice(0, 12),
  };
}

export function buildLargeOutputPayload(input: {
  facts: CompactionTestFacts;
  paddingChars: number;
  itemCount: number;
}): Record<string, unknown> {
  const items = Array.from({ length: input.itemCount }, (_, index) => ({
    path: `src/generated/compaction-${index}.ts`,
    status: index % 7 === 0 ? "modified" : "unchanged",
  }));
  return {
    tool: `${DEV_TOOL_PREFIX}large_output`,
    facts: input.facts,
    results: items,
    result_count: items.length,
    http_status: 200,
    importantMarkers: [
      input.facts.compaction_fact,
      input.facts.compaction_issue,
      input.facts.compaction_url,
      `commit ${input.facts.compaction_commit}`,
      "table compaction_test_artifacts",
    ],
    padding: buildDeterministicPadding(input.paddingChars, input.facts.seed),
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

async function wrapDevToolResultForModel(params: {
  conversationId?: string;
  summarizer?: ToolOutputLlmSummarizer;
  toolCallId: string;
  toolName: string;
  status: "success" | "error";
  rawInput?: unknown;
  rawOutput: unknown;
  content: string;
}): Promise<{ content: string; _meta?: Record<string, unknown> }> {
  if (!params.conversationId) {
    return { content: params.content };
  }

  const block = await compactToolResultForPrompt({
    conversationId: params.conversationId,
    toolCallId: params.toolCallId,
    toolResultId: buildToolResultId({
      conversationId: params.conversationId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
    }),
    toolName: params.toolName,
    status: params.status,
    rawInput: params.rawInput,
    rawOutput: params.rawOutput,
    config: config.chat.toolOutputOffload,
    store: new DbToolArtifactStore(),
    summarizer: params.summarizer,
  });

  if (!block.offloaded) {
    return { content: params.content };
  }

  return {
    content: params.content,
    _meta: { toolResultRefBlock: block },
  };
}

function buildDeterministicPadding(targetChars: number, seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex");
  let padding = "";
  let round = 0;
  while (padding.length < targetChars) {
    padding += `${FILLER_LINE} round=${round} seed-hash=${hash.slice(round % hash.length, (round % hash.length) + 8)}\n`;
    round += 1;
  }
  return padding.slice(0, targetChars);
}

function serializeLargeToolContent(rawOutput: Record<string, unknown>): string {
  const facts = rawOutput.facts as CompactionTestFacts;
  const header = [
    `COMPACTION_FACT=${facts.compaction_fact}`,
    `COMPACTION_ISSUE=${facts.compaction_issue}`,
    `COMPACTION_URL=${facts.compaction_url}`,
    `COMPACTION_COMMIT=${facts.compaction_commit}`,
    `RESULT_COUNT=${String(rawOutput.result_count ?? "")}`,
    "",
  ].join("\n");
  return `${header}${JSON.stringify(rawOutput, null, 2)}`;
}

function clampPaddingChars(
  value: number | undefined,
  defaultValue: number,
): number {
  if (!value || !Number.isFinite(value) || value <= 0) return defaultValue;
  return Math.min(Math.floor(value), 500_000);
}

function clampItemCount(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return 120;
  return Math.min(Math.floor(value), 5_000);
}

function requireString(args: unknown, key: string): string {
  if (!isRecord(args) || typeof args[key] !== "string" || !args[key].trim()) {
    throw new Error(`${key} is required`);
  }
  return args[key].trim();
}

function coerceOptionalString(args: unknown, key: string): string | undefined {
  if (!isRecord(args) || typeof args[key] !== "string") return undefined;
  const value = args[key].trim();
  return value.length > 0 ? value : undefined;
}

function coerceOptionalNumber(args: unknown, key: string): number | undefined {
  if (!isRecord(args) || typeof args[key] !== "number") return undefined;
  return Number.isFinite(args[key]) ? args[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
