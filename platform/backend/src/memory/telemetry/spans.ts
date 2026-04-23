import { type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { setSpanError } from "@/observability/tracing/attributes";
import type {
  MemoryRejectionReason,
  MemoryScopeType,
} from "@/types/memory-item";

export type MemoryOperation =
  | "extract"
  | "retrieve"
  | "inject"
  | "approve"
  | "reject"
  | "delete"
  | "archive"
  | "unarchive";

export type MemorySpanAttributes = {
  scopeType?: MemoryScopeType;
  scopeId?: string;
  candidatesProposed?: number;
  candidatesAcceptedByPolicyScreen?: number;
  injectedCount?: number;
  injectedTokensApprox?: number;
  rejectionReason?: MemoryRejectionReason;
};

// =============================================================================
// Exported items (public interface)
// =============================================================================

export async function withMemorySpan<T>(
  operation: MemoryOperation,
  fn: (span: Span) => Promise<T>,
  attrs?: MemorySpanAttributes,
): Promise<T> {
  const tracer = trace.getTracer("archestra");

  return tracer.startActiveSpan(
    `memory ${operation}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "archestra.memory.operation": operation,
      },
    },
    async (span) => {
      setMemorySpanAttributes(span, attrs);

      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        setSpanError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function setMemorySpanAttributes(
  span: Span,
  attrs: MemorySpanAttributes | undefined,
): void {
  if (!attrs) {
    return;
  }

  if (attrs.scopeType) {
    span.setAttribute("archestra.memory.scope_type", attrs.scopeType);
  }
  if (attrs.scopeId) {
    span.setAttribute("archestra.memory.scope_id", attrs.scopeId);
  }
  if (attrs.candidatesProposed != null) {
    span.setAttribute(
      "archestra.memory.candidates_proposed",
      attrs.candidatesProposed,
    );
  }
  if (attrs.candidatesAcceptedByPolicyScreen != null) {
    span.setAttribute(
      "archestra.memory.candidates_accepted_by_policy_screen",
      attrs.candidatesAcceptedByPolicyScreen,
    );
  }
  if (attrs.injectedCount != null) {
    span.setAttribute("archestra.memory.injected_count", attrs.injectedCount);
  }
  if (attrs.injectedTokensApprox != null) {
    span.setAttribute(
      "archestra.memory.injected_tokens_approx",
      attrs.injectedTokensApprox,
    );
  }
  if (attrs.rejectionReason) {
    span.setAttribute(
      "archestra.memory.rejection_reason",
      attrs.rejectionReason,
    );
  }
}
