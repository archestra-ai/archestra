import { createHash, randomBytes } from "node:crypto";
import { type Context, context, trace } from "@opentelemetry/api";
import type { IdGenerator } from "@opentelemetry/sdk-trace-base";
import { SESSION_ID_KEY } from "@/observability/request-context";

/** Stable 128-bit OTEL identity for a conversation; arbitrary client IDs are not valid trace IDs. */
export function sessionTraceId(sessionId: string): string {
  return createHash("sha256")
    .update("archestra.session\0")
    .update(sessionId)
    .digest("hex")
    .slice(0, 32);
}

/** Resume a session across turns/processes, retaining parents only inside that session's trace. */
export function sessionContext(
  base: Context,
  sessionId?: string | null,
): Context {
  if (!sessionId) return base;
  const ctx = base.setValue(SESSION_ID_KEY, sessionId);
  return base.getValue(SESSION_ID_KEY) === sessionId ||
    trace.getSpanContext(ctx)?.traceId === sessionTraceId(sessionId)
    ? ctx
    : trace.deleteSpan(ctx);
}

export class SessionIdGenerator implements IdGenerator {
  generateTraceId(): string {
    const id = context.active().getValue(SESSION_ID_KEY);
    return typeof id === "string" && id
      ? sessionTraceId(id)
      : randomBytes(16).toString("hex");
  }
  generateSpanId(): string {
    return randomBytes(8).toString("hex");
  }
}
