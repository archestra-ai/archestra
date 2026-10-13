import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import logger from "@/logging";
import { getActiveChatRouteCategory } from "@/observability/request-context";
import {
  ATTR_GENAI_CONVERSATION_ID,
  ATTR_GENAI_OPERATION_NAME,
  ATTR_GENAI_PROVIDER_NAME,
  ATTR_GENAI_REQUEST_MODEL,
  ATTR_ROUTE_CATEGORY,
  RouteCategory,
} from "@/observability/tracing";
import type { ChatMessage } from "@/types";
import type { ConversationCompactionTrigger } from "@/types/conversation-compaction";
import type { ContextCompactionResult } from "./compact-messages";

type TracedAttempt = {
  conversationId: string;
  provider: string;
  selectedModel: string;
  trigger: ConversationCompactionTrigger;
  messages: ChatMessage[];
};

/**
 * Run one compaction attempt inside its span, recording the outcome (or the
 * crash) on the span and in the logs.
 */
export async function traceContextCompaction(
  attempt: TracedAttempt,
  run: () => Promise<ContextCompactionResult>,
): Promise<ContextCompactionResult> {
  const userTurnCount = attempt.messages.filter(
    (message) => message.role === "user",
  ).length;
  return await trace.getTracer("archestra").startActiveSpan(
    `${TRACE_OPERATION} ${attempt.trigger}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        [ATTR_ROUTE_CATEGORY]:
          getActiveChatRouteCategory() ?? RouteCategory.CHAT,
        [ATTR_GENAI_OPERATION_NAME]: TRACE_OPERATION,
        [ATTR_GENAI_PROVIDER_NAME]: attempt.provider,
        [ATTR_GENAI_REQUEST_MODEL]: attempt.selectedModel,
        [ATTR_GENAI_CONVERSATION_ID]: attempt.conversationId,
        [ATTR_TRIGGER]: attempt.trigger,
        [ATTR_INPUT_MESSAGE_COUNT]: attempt.messages.length,
        [ATTR_INPUT_USER_TURN_COUNT]: userTurnCount,
      },
    },
    async (span) => {
      const logFields = {
        conversationId: attempt.conversationId,
        trigger: attempt.trigger,
        provider: attempt.provider,
        selectedModel: attempt.selectedModel,
        messageCount: attempt.messages.length,
        userTurnCount,
      };
      try {
        const result = await run();
        recordOutcome(span, result);
        logOutcome(attempt.trigger, result, logFields);
        return result;
      } catch (error) {
        if (error instanceof Error) {
          span.recordException(error);
        }
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message:
            error instanceof Error ? error.message : "context compaction error",
        });
        logger.error(
          { error, ...logFields },
          "[ContextCompaction] compaction attempt crashed",
        );
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

// =============================================================================
// Internal Helpers
// =============================================================================

const TRACE_OPERATION = "context_compaction";
const ATTR_TRIGGER = "archestra.context_compaction.trigger";
const ATTR_STATUS = "archestra.context_compaction.status";
const ATTR_REASON = "archestra.context_compaction.reason";
const ATTR_INPUT_MESSAGE_COUNT =
  "archestra.context_compaction.input_message_count";
const ATTR_INPUT_USER_TURN_COUNT =
  "archestra.context_compaction.input_user_turn_count";
const ATTR_COMPACTION_ID = "archestra.context_compaction.compaction_id";
const ATTR_ORIGINAL_TOKEN_ESTIMATE =
  "archestra.context_compaction.original_token_estimate";
const ATTR_COMPACTED_TOKEN_ESTIMATE =
  "archestra.context_compaction.compacted_token_estimate";

function recordOutcome(span: Span, result: ContextCompactionResult): void {
  span.setAttribute(ATTR_STATUS, result.status);
  if (result.reason) {
    span.setAttribute(ATTR_REASON, result.reason);
  }
  if (result.compaction) {
    span.setAttribute(ATTR_COMPACTION_ID, result.compaction.id);
    span.setAttribute(
      ATTR_ORIGINAL_TOKEN_ESTIMATE,
      result.compaction.originalTokenEstimate,
    );
    span.setAttribute(
      ATTR_COMPACTED_TOKEN_ESTIMATE,
      result.compaction.compactedTokenEstimate,
    );
  }
  span.setStatus(
    result.status === "failed"
      ? {
          code: SpanStatusCode.ERROR,
          message: result.reason ?? "context compaction failed",
        }
      : { code: SpanStatusCode.OK },
  );
}

function logOutcome(
  trigger: ConversationCompactionTrigger,
  result: ContextCompactionResult,
  baseFields: Record<string, unknown>,
): void {
  const fields = {
    ...baseFields,
    status: result.status,
    reason: result.reason,
    compactionId: result.compaction?.id,
    originalTokenEstimate: result.compaction?.originalTokenEstimate,
    compactedTokenEstimate: result.compaction?.compactedTokenEstimate,
  };
  const message = "[ContextCompaction] compaction attempt finished";

  if (result.status === "failed") {
    logger.warn(fields, message);
  } else if (
    trigger === "auto" &&
    (result.reason === "below_threshold" ||
      result.reason === "using_existing_summary")
  ) {
    logger.debug(fields, message);
  } else {
    logger.info(fields, message);
  }
}
