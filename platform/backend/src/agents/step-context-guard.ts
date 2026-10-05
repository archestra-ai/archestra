/**
 * Per-step context guard for the agentic loop (wired via the AI SDK's
 * `prepareStep` hook, which lets each step override the messages sent to the
 * model without touching the loop's own accumulated state).
 *
 * Tool results enter the loop's history uncapped — a single oversized result
 * (e.g. a raw workflow-runs listing) can blow past the model's context window
 * mid-turn. Before each step, the guard caps oversized tool-result outputs
 * and, when the model's context window is known and the accumulated messages
 * exceed its budget, compacts the older prefix into an LLM-generated summary
 * (memoized across steps, updated incrementally as the run grows). When
 * summarization is unavailable or fails, it falls back to deterministic
 * trimming so the step still fits.
 *
 * When `promptCache` is set, the guard also moves the cache breakpoint to the
 * newest message of each step that it does not trim, so later steps read the
 * earlier tool calls and results from the cache.
 */
import {
  CONTEXT_COMPACTION_AUTO_THRESHOLD,
  PROXY_STAMPED_TOOL_ARGUMENTS,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
} from "@archestra/shared";
import type { ModelMessage } from "ai";
import type { LLMModel } from "@/clients/llm-client";
import logger from "@/logging";
import { trimMessagesToTokenLimit } from "@/routes/chat/context-trimming";
import { applyStepPromptCacheBreakpoint } from "@/routes/chat/normalization/apply-prompt-cache";
import { TOKEN_ESTIMATE } from "@/routes/chat/normalization/estimate-message-tokens";
import {
  CONTEXT_COMPACTION_TRANSCRIPT_MAX_CHARS,
  compactionSummaryText,
  composeCompactionPrompt,
  summarizeCompactionTranscript,
} from "@/services/context-compaction";

interface SummarizeParams {
  transcript: string;
  previousSummary: string | null;
}

/**
 * Create a `prepareStep` guard bound to one agent run. State (the memoized
 * summary and its boundary) lives for the run only.
 *
 * `summarizeTranscript` is the LLM boundary — injectable for tests. When
 * neither it nor `model` is provided, summarization is disabled and the guard
 * degrades to cap + trim.
 */
export function createStepContextGuard(params: {
  model?: LLMModel;
  contextLength: number | null;
  systemPrompt?: string;
  abortSignal?: AbortSignal;
  logContext?: Record<string, unknown>;
  summarizeTranscript?: (params: SummarizeParams) => Promise<string | null>;
  /** The provider and model whose cache breakpoint moves with each step. */
  promptCache?: {
    provider: string;
    model: string;
    anthropicNativeEndpoint: boolean;
  };
}): (options: { messages: ModelMessage[] }) => Promise<{
  messages: ModelMessage[];
}> {
  const { model, contextLength, systemPrompt, abortSignal, promptCache } =
    params;
  const logContext = params.logContext ?? {};
  const summarize =
    params.summarizeTranscript ??
    (model
      ? (p: SummarizeParams) => summarizeWithModel({ model, abortSignal, ...p })
      : null);

  // Step messages are append-only across steps (initial prompt + accumulated
  // responses), so messages[0..throughIndex) stays covered by `summary` on
  // every later step.
  let state: { summary: string; throughIndex: number } | null = null;
  let summarizationDisabled = summarize === null;

  // For a view that the next step extends: mark its newest message, so the
  // next step reads this whole view from the cache.
  const withStepBreakpoint = (messages: ModelMessage[]) => ({
    messages: promptCache
      ? applyStepPromptCacheBreakpoint({ ...promptCache, messages })
      : messages,
  });

  return async ({ messages }) => {
    const capped = capOversizedToolResults(messages);
    if (!contextLength) return withStepBreakpoint(capped);

    const budgetTokens = Math.floor(
      contextLength * CONTEXT_COMPACTION_AUTO_THRESHOLD,
    );
    // Rough char accounting on both sides: message sizes are JSON content
    // length while the system prompt is raw chars. The mismatch slightly
    // overweights the system prompt, which errs toward compacting earlier —
    // absorbed by the 20% headroom in the threshold.
    const budgetChars = Math.max(
      budgetTokens * TOKEN_ESTIMATE.charsPerToken - (systemPrompt?.length ?? 0),
      0,
    );

    let view = applySummary(capped, state);
    if (charSize(view) <= budgetChars) return withStepBreakpoint(view);

    if (!summarizationDisabled && summarize) {
      const minIndex = state?.throughIndex ?? 0;
      const boundary = chooseCompactionBoundary({
        messages: capped,
        minIndex,
        budgetChars,
      });
      if (boundary > minIndex) {
        try {
          const summary = await summarize({
            transcript: serializeForTranscript(
              capped.slice(minIndex, boundary),
            ),
            previousSummary: state?.summary ?? null,
          });
          if (summary) {
            state = { summary, throughIndex: boundary };
            logger.info(
              {
                ...logContext,
                compactedThroughIndex: boundary,
                summaryChars: summary.length,
              },
              "[StepContextGuard] compacted step context with summary",
            );
            view = applySummary(capped, state);
            if (charSize(view) <= budgetChars) return withStepBreakpoint(view);
          } else {
            summarizationDisabled = true;
            logger.warn(
              logContext,
              "[StepContextGuard] summarization produced no summary; falling back to trimming for the rest of the run",
            );
          }
        } catch (error) {
          summarizationDisabled = true;
          logger.warn(
            { ...logContext, error },
            "[StepContextGuard] summarization failed; falling back to trimming for the rest of the run",
          );
        }
      }
    }

    // No cache breakpoint: as the run grows, trimming usually drops more of the
    // oldest messages, which changes the start of the view. A cache write for
    // this view would rarely be read and would cost more than no marker.
    return {
      messages: trimMessagesToTokenLimit({
        messages: view,
        maxTokens: budgetTokens,
        systemPrompt,
      }),
    };
  };
}

// =============================================================================
// INTERNAL
// =============================================================================

function summarizeWithModel(params: {
  model: LLMModel;
  transcript: string;
  previousSummary: string | null;
  abortSignal?: AbortSignal;
}): Promise<string | null> {
  return summarizeCompactionTranscript({
    model: params.model,
    prompt: composeCompactionPrompt({
      previousSummary: params.previousSummary,
      transcript: params.transcript,
    }),
    abortSignal: params.abortSignal,
  });
}

function applySummary(
  messages: ModelMessage[],
  state: { summary: string; throughIndex: number } | null,
): ModelMessage[] {
  // throughIndex beyond the array means the append-only assumption broke
  // (e.g. the SDK rebuilt a shorter list) — ignore the summary rather than
  // slice into nothing.
  if (!state || state.throughIndex <= 0 || state.throughIndex > messages.length)
    return messages;
  return [
    buildSummaryMessage(state.summary),
    ...messages.slice(state.throughIndex),
  ];
}

function buildSummaryMessage(summary: string): ModelMessage {
  return { role: "user", content: compactionSummaryText(summary) };
}

/**
 * Pick the index up to which messages get summarized: keep a recent suffix of
 * roughly RECENT_KEEP_RATIO of the char budget (always including at least the
 * last message), and never split an assistant tool call from its tool results
 * (the suffix must not start with a tool message).
 */
function chooseCompactionBoundary(params: {
  messages: ModelMessage[];
  minIndex: number;
  budgetChars: number;
}): number {
  const { messages, minIndex, budgetChars } = params;
  const keepChars = budgetChars * RECENT_KEEP_RATIO;

  let boundary = messages.length - 1;
  let kept = charSize([messages[messages.length - 1]]);
  while (boundary > minIndex) {
    const next = charSize([messages[boundary - 1]]);
    if (kept + next > keepChars) break;
    kept += next;
    boundary--;
  }

  // keep tool-call/tool-result pairs on the same side of the boundary
  while (
    boundary < messages.length - 1 &&
    messages[boundary]?.role === "tool"
  ) {
    boundary++;
  }
  if (messages[boundary]?.role === "tool") return minIndex;

  return boundary > minIndex ? boundary : minIndex;
}

/** Render messages as a plain-text transcript for the summarization prompt. */
function serializeForTranscript(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      lines.push(`[${message.role}]: ${message.content}`);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      switch (part.type) {
        case "text":
          lines.push(`[${message.role}]: ${part.text as string}`);
          break;
        case "tool-call":
          lines.push(
            `[assistant → tool ${part.toolName as string}]: ${truncate(
              safeJson(modelWrittenInput(part.toolName as string, part.input)),
              TRANSCRIPT_TOOL_INPUT_MAX_CHARS,
            )}`,
          );
          break;
        case "tool-result":
          lines.push(
            `[tool ${part.toolName as string} result]: ${truncate(
              safeJson(part.output),
              TRANSCRIPT_TOOL_RESULT_MAX_CHARS,
            )}`,
          );
          break;
        case "file":
        case "image":
          lines.push(`[${message.role} attached a ${part.type}]`);
          break;
        default:
          break;
      }
    }
  }
  const transcript = lines.join("\n");
  // keep the tail — recent context matters most for continuing the task
  return transcript.length <= CONTEXT_COMPACTION_TRANSCRIPT_MAX_CHARS
    ? transcript
    : transcript.slice(
        transcript.length - CONTEXT_COMPACTION_TRANSCRIPT_MAX_CHARS,
      );
}

/**
 * Replace tool-result outputs whose serialized size exceeds the cap with a
 * truncated text rendering plus a notice. The replacement happens in place on
 * the tool message (same toolCallId), so tool-call/tool-result pairing stays
 * intact for provider validation.
 */
function capOversizedToolResults(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      return message;
    }
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const serialized = JSON.stringify(part.output);
      if (serialized.length <= MAX_TOOL_RESULT_CONTEXT_CHARS) return part;
      messageChanged = true;
      return {
        ...part,
        output: {
          type: "text" as const,
          value: `${serialized.slice(0, MAX_TOOL_RESULT_CONTEXT_CHARS)}\n[tool result truncated: ${serialized.length} chars exceeded the ${MAX_TOOL_RESULT_CONTEXT_CHARS}-char limit for model context]`,
        },
      };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content } as ModelMessage;
  });
  return changed ? result : messages;
}

function charSize(messages: Array<ModelMessage | undefined>): number {
  return messages.reduce(
    (sum, m) => sum + (m ? JSON.stringify(m.content).length : 0),
    0,
  );
}

/**
 * A tool call's input without what only the OpenAPPA proxy writes: a notice's
 * record and signed offers, a remedy call's receipt and JWS, ask_user's
 * offers. The summary goes to a provider as plain text, where the proxy can no
 * longer take them out. A tool matches by its short name under any label.
 */
function modelWrittenInput(toolName: string, input: unknown): unknown {
  const hidden = PROXY_WRITTEN_MEMBERS.find(
    ([shortName]) =>
      toolName === shortName || toolName.endsWith(`__${shortName}`),
  )?.[1];
  if (
    !hidden ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    return input;
  }
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !hidden.includes(key)),
  );
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ~25k tokens at typical densities — generous enough for legitimate large
// outputs (file reads, API listings) while keeping a single result from
// consuming a meaningful fraction of the context window.
const MAX_TOOL_RESULT_CONTEXT_CHARS = 100_000;

// Share of the char budget preserved verbatim as the recent suffix when
// compacting — the rest of the prefix goes into the summary.
const RECENT_KEEP_RATIO = 0.3;

// Per-entry caps for the ModelMessage transcript serializer above (the
// whole-transcript ceiling is the shared CONTEXT_COMPACTION_TRANSCRIPT_MAX_CHARS).
const TRANSCRIPT_TOOL_INPUT_MAX_CHARS = 2_000;
const TRANSCRIPT_TOOL_RESULT_MAX_CHARS = 8_000;

const PROXY_WRITTEN_MEMBERS: ReadonlyArray<
  readonly [shortName: string, members: readonly string[]]
> = [
  [TOOL_GET_REMEDY_PLANS_SHORT_NAME, ["notice", "offers"]],
  [
    TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
    PROXY_STAMPED_TOOL_ARGUMENTS[TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME],
  ],
  [
    TOOL_ASK_USER_SHORT_NAME,
    PROXY_STAMPED_TOOL_ARGUMENTS[TOOL_ASK_USER_SHORT_NAME],
  ],
];
