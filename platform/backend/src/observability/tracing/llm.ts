import {
  type Context,
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { SupportedProvider } from "@shared";
import config from "@/config";
import logger from "@/logging";
import { SESSION_ID_KEY } from "@/observability/request-context";
import type { Agent, GenAiOperationName } from "@/types";
import {
  ATTR_ARCHESTRA_EXECUTION_ID,
  ATTR_ARCHESTRA_EXTERNAL_AGENT_ID,
  ATTR_GENAI_OPERATION_NAME,
  ATTR_GENAI_PROMPT,
  ATTR_GENAI_PROVIDER_NAME,
  ATTR_GENAI_REQUEST_MODEL,
  ATTR_GENAI_REQUEST_STREAMING,
  ATTR_ROUTE_CATEGORY,
  ATTR_SERVER_ADDRESS,
  EVENT_GENAI_CONTENT_PROMPT,
  RouteCategory,
  type SpanUserInfo,
  setAgentAttributes,
  setSessionId,
  setSpanError,
  setUserAttributes,
  truncateContent,
} from "./attributes";

const { captureContent } = config.observability.otel;

/**
 * Starts an active LLM span with attributes following the OTEL GenAI Semantic Conventions.
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
 *
 * Span name format: `{operationName} {model}` (e.g., "chat gpt-4o-mini").
 * The operationName is provided by each LLM adapter's `getSpanName()` method,
 * which returns a `GenAiOperationName` value.
 *
 * Lifecycle: The span is automatically ended in a finally block. The callback
 * should NOT call `span.end()`. On success, span status is set to OK. On error,
 * span status is set to ERROR with `error.type` attribute.
 *
 * @param params.operationName - The GenAI operation name (e.g., "chat", "generate_content")
 * @param params.provider - The LLM provider (openai, gemini, anthropic, etc.)
 * @param params.model - The LLM model being used
 * @param params.stream - Whether this is a streaming request
 * @param params.agent - The agent/profile object (optional)
 * @param params.sessionId - Conversation/session ID (optional)
 * @param params.executionId - Execution ID for tracking agent executions (optional)
 * @param params.externalAgentId - External agent ID from X-Archestra-Agent-Id header (optional)
 * @param params.serverAddress - The server address (base URL) of the LLM provider (optional)
 * @param params.promptMessages - The prompt messages to capture as a span event (optional)
 * @param params.callback - The callback function to execute within the span context
 * @returns The result of the callback function
 */
export async function startActiveLlmSpan<T>(params: {
  operationName: GenAiOperationName;
  provider: SupportedProvider;
  model: string;
  stream: boolean;
  agent?: Agent;
  sessionId?: string | null;
  executionId?: string;
  externalAgentId?: string;
  serverAddress?: string;
  promptMessages?: unknown;
  parentContext?: Context;
  user?: SpanUserInfo | null;
  callback: (span: Span) => Promise<T>;
}): Promise<T> {
  const spanName = `${params.operationName} ${params.model}`;
  logger.debug(
    {
      spanName,
      provider: params.provider,
      model: params.model,
      stream: params.stream,
      agentId: params.agent?.id,
    },
    "[tracing] startActiveLlmSpan: creating span",
  );
  const tracer = trace.getTracer("archestra");

  const spanOptions = {
    kind: SpanKind.CLIENT,
    attributes: {
      [ATTR_ROUTE_CATEGORY]: RouteCategory.LLM_PROXY,
      [ATTR_GENAI_OPERATION_NAME]: params.operationName,
      [ATTR_GENAI_PROVIDER_NAME]: params.provider,
      [ATTR_GENAI_REQUEST_MODEL]: params.model,
      [ATTR_GENAI_REQUEST_STREAMING]: params.stream,
    },
  };

  const spanCallback = async (span: Span) => {
    if (params.agent) {
      logger.debug(
        {
          agentId: params.agent.id,
          agentName: params.agent.name,
          labelCount: params.agent.labels?.length || 0,
        },
        "[tracing] startActiveLlmSpan: setting agent attributes",
      );
      setAgentAttributes(span, params.agent);
    }

    setSessionId(span, params.sessionId);

    if (params.executionId) {
      span.setAttribute(ATTR_ARCHESTRA_EXECUTION_ID, params.executionId);
    }
    if (params.externalAgentId) {
      span.setAttribute(
        ATTR_ARCHESTRA_EXTERNAL_AGENT_ID,
        params.externalAgentId,
      );
    }
    if (params.serverAddress) {
      span.setAttribute(ATTR_SERVER_ADDRESS, params.serverAddress);
    }

    setUserAttributes(span, params.user);

    if (captureContent && params.promptMessages) {
      span.addEvent(EVENT_GENAI_CONTENT_PROMPT, {
        [ATTR_GENAI_PROMPT]: truncateContent(params.promptMessages),
      });
    }

    logger.debug(
      { spanName },
      "[tracing] startActiveLlmSpan: executing callback",
    );

    try {
      const result = await params.callback(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      setSpanError(span, error);
      throw error;
    } finally {
      span.end();
    }
  };

  // Build the context: start from parentContext (if provided) or current context,
  // then inject the session ID so it's available to the pino mixin for log correlation.
  let ctx = params.parentContext ?? context.active();
  if (params.sessionId) {
    ctx = ctx.setValue(SESSION_ID_KEY, params.sessionId);
  }

  return tracer.startActiveSpan(spanName, spanOptions, ctx, spanCallback);
}
