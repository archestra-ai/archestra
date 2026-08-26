import {
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { SESSION_ID_KEY } from "@/observability/request-context";
import { ATTR_GENAI_AGENT_ID, ATTR_GENAI_AGENT_NAME } from "./attributes";

/**
 * Wraps one eval case execution in an active span so the case's LLM and MCP
 * child spans (correlated via the case's sessionId) group under a single
 * trace. Span name: `eval_case {caseName}`.
 */
export async function startActiveEvalCaseSpan<T>(params: {
  runId: string;
  suiteId: string;
  caseName: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  callback: (span: Span) => Promise<T>;
}): Promise<T> {
  const tracer = trace.getTracer("archestra");

  // Session ID in context correlates pino logs with the trace.
  const ctx = context.active().setValue(SESSION_ID_KEY, params.sessionId);

  return tracer.startActiveSpan(
    `eval_case ${params.caseName}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "archestra.eval.run_id": params.runId,
        "archestra.eval.suite_id": params.suiteId,
        "archestra.eval.case_name": params.caseName,
        "archestra.session.id": params.sessionId,
        [ATTR_GENAI_AGENT_ID]: params.agentId,
        [ATTR_GENAI_AGENT_NAME]: params.agentName,
      },
    },
    ctx,
    async (span) => {
      try {
        return await params.callback(span);
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
