import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

/** One structured, correlated operation log per completed application span. No span content/events. */
export class SessionOperationLogProcessor implements SpanProcessor {
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    const sessionId = span.attributes["gen_ai.conversation.id"];
    if (typeof sessionId !== "string" || !span.attributes["route.category"])
      return;
    const fields: Record<string, string | number | boolean> = {};
    // Identity is metadata, never a credential value; content capture remains independent.
    for (const key of [
      "gen_ai.agent.id",
      "gen_ai.agent.name",
      "gen_ai.provider.name",
      "gen_ai.request.model",
      "gen_ai.operation.name",
      "gen_ai.tool.name",
      "mcp.server.name",
      "archestra.auth.method",
      "archestra.virtual_key.id",
      "archestra.passthrough_virtual_key.id",
      "archestra.billing.mode",
      "archestra.cost",
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
      "archestra.guardrails.hook",
      "archestra.guardrails.decision",
      "error.type",
    ]) {
      const value = span.attributes[key];
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      )
        fields[key] = value;
    }
    try {
      logs.getLogger("archestra-session-events").emit({
        context: trace.setSpanContext(ROOT_CONTEXT, span.spanContext()),
        timestamp: span.endTime,
        eventName: "archestra.session.operation",
        severityNumber:
          span.status.code === 2 ? SeverityNumber.ERROR : SeverityNumber.INFO,
        body: JSON.stringify({
          operation: span.name,
          duration_ms: span.duration[0] * 1000 + span.duration[1] / 1e6,
          status: span.status.code === 2 ? "error" : "ok",
          ...fields,
        }),
        attributes: {
          event_name: "archestra.session.operation",
          session_id: sessionId,
        },
      });
    } catch {
      /* Telemetry cannot fail the operation. */
    }
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
