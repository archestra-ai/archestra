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
import { orderToolResultsByCall } from "@/clients/tool-result-order";
import logger from "@/logging";
import {
  capToolResultOutputs,
  estimateModelMessageChars,
  trimMessagesToTokenLimit,
} from "@/routes/chat/context-trimming";
import { applyStepPromptCacheBreakpoint } from "@/routes/chat/normalization/apply-prompt-cache";
import { TOKEN_ESTIMATE } from "@/routes/chat/normalization/estimate-message-tokens";
import {
  CONTEXT_COMPACTION_INSTRUCTION_TOKENS,
  CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS,
  CONTEXT_COMPACTION_RECENT_KEEP_RATIO,
  type CompactionSummarizer,
  chooseRecentSuffixStart,
  compactionSummaryText,
  createCompactionSummarizer,
  summarizeTranscriptEntries,
  type TranscriptEntry,
} from "@/services/context-compaction";
import { MAX_TOOL_RESULT_CONTEXT_BYTES } from "@/utils/tool-result-cap";

/**
 * Summarizes a step's own messages in context: the same model, system prompt
 * and tools as the step, with the messages sent as they are so the provider
 * reads them from the prompt cache and the proxy governs their tool results.
 */
export type StepMessagesSummarizer = (params: {
  messages: ModelMessage[];
  hasPreviousSummary: boolean;
}) => Promise<string | null>;

/**
 * Create a `prepareStep` guard bound to one agent run. State (the memoized
 * summary and its boundary) lives for the run only.
 *
 * Summaries come from `summarizeMessages` when given, else from a transcript
 * summarizer (`summarizeTranscript`, or one bound to `model`). With none of
 * them, summarization is disabled and the guard degrades to cap + trim.
 */
export function createStepContextGuard(params: {
  model?: LLMModel;
  contextLength: number | null;
  systemPrompt?: string;
  /** Tokens the step spends on tool definitions, which a summary request repeats. */
  toolTokens?: number;
  /** The step's own reply cap; a summary request reserves its own instead. */
  replyTokens?: number;
  abortSignal?: AbortSignal;
  logContext?: Record<string, unknown>;
  summarizeMessages?: StepMessagesSummarizer;
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
  const summarizeTranscript =
    params.summarizeTranscript ??
    (model ? createCompactionSummarizer({ model, abortSignal }) : null);

  // Step messages are append-only across steps (initial prompt + accumulated
  // responses), so messages[0..throughIndex) stays covered by `summary` on
  // every later step.
  let state: { summary: string; throughIndex: number } | null = null;
  let summarizationDisabled =
    !params.summarizeMessages && summarizeTranscript === null;

  // For a view that the next step extends: mark its newest message, so the
  // next step reads this whole view from the cache.
  const withStepBreakpoint = (messages: ModelMessage[]) => ({
    messages: promptCache
      ? applyStepPromptCacheBreakpoint({ ...promptCache, messages })
      : messages,
  });

  // Summarize capped[minIndex..boundary) on top of the current summary.
  const summarize = async (input: {
    capped: ModelMessage[];
    view: ModelMessage[];
    minIndex: number;
    boundary: number;
    windowChars: number;
  }): Promise<string | null> => {
    if (params.summarizeMessages) {
      // The whole view extends the previous step's request, so it is read
      // from the cache; the prefix through the boundary is the fallback when
      // the view leaves no room for the instruction and the summary.
      const prefix = applySummary(input.capped.slice(0, input.boundary), state);
      const messages =
        charSize(input.view) <= input.windowChars ? input.view : prefix;
      return params.summarizeMessages({
        messages: withStepBreakpoint(messages).messages,
        hasPreviousSummary: state !== null,
      });
    }
    if (!summarizeTranscript) return null;
    return summarizeTranscriptEntries({
      summarize: summarizeTranscript,
      entries: input.capped
        .slice(input.minIndex, input.boundary)
        .flatMap(transcriptEntries),
      previousSummary: state?.summary ?? null,
      contextLength,
      abortSignal,
    });
  };

  return async ({ messages }) => {
    const capped = capToolResultOutputs(
      orderToolResultsByCall(messages),
      MAX_TOOL_RESULT_CONTEXT_BYTES,
    );
    if (!contextLength) return withStepBreakpoint(capped);

    const toolTokens = params.toolTokens ?? 0;
    const budgetTokens = Math.max(
      Math.floor(contextLength * CONTEXT_COMPACTION_AUTO_THRESHOLD) -
        toolTokens -
        (params.replyTokens ?? 0),
      0,
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

    if (!summarizationDisabled) {
      const minIndex = state?.throughIndex ?? 0;
      const boundary = chooseCompactionBoundary({
        messages: capped,
        minIndex,
        budgetChars,
      });
      if (boundary > minIndex) {
        try {
          const summary = await summarize({
            capped,
            view,
            minIndex,
            boundary,
            windowChars: Math.max(
              (contextLength -
                toolTokens -
                CONTEXT_COMPACTION_INSTRUCTION_TOKENS -
                CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS) *
                TOKEN_ESTIMATE.charsPerToken -
                (systemPrompt?.length ?? 0),
              0,
            ),
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
          // A cancelled run ends here, not with a trimmed step.
          if (abortSignal?.aborted) throw error;
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
    count: messages.length,
    sizeOf: (index) => charSize([messages[index]]),
    keepBudget: budgetChars * CONTEXT_COMPACTION_RECENT_KEEP_RATIO,
    minIndex,
  });

  // keep tool-call/tool-result pairs on the same side of the boundary: a cut
  // inside a tool round moves back to the assistant message that made the calls
  while (boundary > minIndex && messages[boundary]?.role === "tool") {
    boundary--;
  }
  return boundary;
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

function charSize(messages: ModelMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateModelMessageChars(m), 0);
}
