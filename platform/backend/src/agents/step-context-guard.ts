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
import { CONTEXT_COMPACTION_AUTO_THRESHOLD } from "@archestra/shared";
import type { ModelMessage } from "ai";
import type { LLMModel } from "@/clients/llm-client";
import logger from "@/logging";
import { trimMessagesToTokenLimit } from "@/routes/chat/context-trimming";
import { applyStepPromptCacheBreakpoint } from "@/routes/chat/normalization/apply-prompt-cache";
import { TOKEN_ESTIMATE } from "@/routes/chat/normalization/estimate-message-tokens";
import {
  CONTEXT_COMPACTION_RECENT_KEEP_RATIO,
  type CompactionSummarizer,
  chooseRecentSuffixStart,
  compactionSummaryText,
  createCompactionSummarizer,
  renderCompactionTranscript,
  type TranscriptEntry,
} from "@/services/context-compaction";
import { MAX_TOOL_RESULT_CONTEXT_CHARS } from "@/utils/tool-result-cap";

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
  summarizeTranscript?: CompactionSummarizer;
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
    (model ? createCompactionSummarizer({ model, abortSignal }) : null);

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
            transcript: renderCompactionTranscript(
              capped.slice(minIndex, boundary).flatMap(transcriptEntries),
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
 * roughly the keep ratio of the char budget (always including at least the
 * last message), and never split an assistant tool call from its tool results
 * (the suffix must not start with a tool message).
 */
function chooseCompactionBoundary(params: {
  messages: ModelMessage[];
  minIndex: number;
  budgetChars: number;
}): number {
  const { messages, minIndex, budgetChars } = params;
  let boundary = chooseRecentSuffixStart({
    sizes: messages.map((message) => charSize([message])),
    keepBudget: budgetChars * CONTEXT_COMPACTION_RECENT_KEEP_RATIO,
    minIndex,
  });

  // keep tool-call/tool-result pairs on the same side of the boundary
  while (
    boundary < messages.length - 1 &&
    messages[boundary]?.role === "tool"
  ) {
    boundary++;
  }
  return messages[boundary]?.role === "tool" ? minIndex : boundary;
}

function transcriptEntries(message: ModelMessage): TranscriptEntry[] {
  if (typeof message.content === "string") {
    return [{ kind: "text", role: message.role, text: message.content }];
  }
  return message.content.flatMap((part): TranscriptEntry[] => {
    switch (part.type) {
      case "text":
        return [{ kind: "text", role: message.role, text: part.text }];
      case "tool-call":
        return [
          { kind: "tool_call", toolName: part.toolName, input: part.input },
        ];
      case "tool-result":
        return [
          { kind: "tool_result", toolName: part.toolName, output: part.output },
        ];
      case "file":
      case "image":
        return [
          { kind: "attachment", role: message.role, attachment: part.type },
        ];
      default:
        return [];
    }
  });
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
      // Budget text by its own length: JSON escaping would push a result the
      // chat tools already capped back over the limit and cut its tail.
      const serialized =
        part.output.type === "text"
          ? part.output.value
          : JSON.stringify(part.output);
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

function charSize(messages: ModelMessage[]): number {
  return messages.reduce((sum, m) => sum + JSON.stringify(m.content).length, 0);
}
