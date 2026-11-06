// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import logger from "@/logging";
import { sessionContext } from "./session";

/** The OTel registry has no logical embedded-hook attribute; archestra.guardrails.* describes that host boundary.
 * Trace the host's logical hook, including native policy checks, consults and retries. No policy content. */
export async function traceOpenappaDispatch<T extends { decision: string }>(
  sessionId: string,
  hook: unknown,
  dispatch: () => Promise<T>,
): Promise<T> {
  const name = typeof hook === "string" ? hook : "unknown";
  const ctx = sessionContext(context.active(), sessionId);
  return context.with(ctx, () =>
    trace.getTracer("archestra").startActiveSpan(
      `guardrails ${name}`,
      {
        attributes: {
          "route.category": "guardrails",
          "gen_ai.conversation.id": sessionId,
          "archestra.guardrails.hook": name,
        },
      },
      ctx,
      async (span) => {
        const started = performance.now();
        let decision = "error";
        try {
          const result = await dispatch();
          decision = result.decision;
          span.setAttribute("archestra.guardrails.decision", decision);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          // Native/provider errors may contain policy or message content.
          span.setAttribute("error.type", "guardrails_dispatch_error");
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          logger.info(
            {
              event_name: "archestra.guardrails.dispatch",
              hook: name,
              decision,
              duration_ms: performance.now() - started,
            },
            "Guardrails hook completed",
          );
          span.end();
        }
      },
    ),
  );
}
