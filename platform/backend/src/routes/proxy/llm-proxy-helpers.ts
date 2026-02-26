/**
 * LLM Proxy Helpers
 *
 * Shared helper functions extracted from llm-proxy-handler.ts to reduce
 * duplication between streaming and non-streaming code paths.
 */

import { context as otelContext } from "@opentelemetry/api";
import {
  ApiError,
  type SupportedProvider,
  type SupportedProviderDiscriminator,
} from "@shared";
import type { FastifyReply } from "fastify";
import logger from "@/logging";
import { metrics } from "@/observability";
import { SESSION_ID_KEY } from "@/observability/request-context";
import type { SpanUserInfo } from "@/observability/tracing";
import type {
  Agent,
  InsertInteraction,
  InteractionRequest,
  InteractionResponse,
  ToolCompressionStats,
  ToonSkipReason,
} from "@/types";
import * as utils from "./utils";
import type { SessionSource } from "./utils/headers/session-id";

/**
 * Convert a resolved user object to the SpanUserInfo shape used by tracing.
 * Returns null if the user is null or undefined.
 */
export function toSpanUserInfo(
  user: { id: string; email: string; name: string } | null | undefined,
): SpanUserInfo | null {
  return user ? { id: user.id, email: user.email, name: user.name } : null;
}

/**
 * Normalize tool calls from either streaming or non-streaming responses
 * into the shape expected by `evaluatePolicies`.
 *
 * - String arguments: validated as JSON, wrapped in `{ raw: ... }` if invalid
 * - Object arguments: serialized with JSON.stringify
 */
export function normalizeToolCallsForPolicy(
  toolCalls: Array<{ name: string; arguments: string | object }>,
): Array<{ toolCallName: string; toolCallArgs: string }> {
  return toolCalls.map((tc) => {
    let argsString: string;
    if (typeof tc.arguments === "string") {
      try {
        JSON.parse(tc.arguments);
        argsString = tc.arguments;
      } catch {
        argsString = JSON.stringify({ raw: tc.arguments });
      }
    } else {
      argsString = JSON.stringify(tc.arguments);
    }
    return { toolCallName: tc.name, toolCallArgs: argsString };
  });
}

/**
 * Calculate both baseline and actual costs for an interaction.
 */
export async function calculateInteractionCosts(params: {
  baselineModel: string;
  actualModel: string;
  usage: { inputTokens: number; outputTokens: number };
  providerName: SupportedProvider;
}): Promise<{
  baselineCost: number | undefined;
  actualCost: number | undefined;
}> {
  const baselineCost = await utils.costOptimization.calculateCost(
    params.baselineModel,
    params.usage.inputTokens,
    params.usage.outputTokens,
    params.providerName,
  );
  const actualCost = await utils.costOptimization.calculateCost(
    params.actualModel,
    params.usage.inputTokens,
    params.usage.outputTokens,
    params.providerName,
  );
  return { baselineCost, actualCost };
}

/**
 * Build the InsertInteraction record from proxy context and response data.
 * Pure function — callers handle `InteractionModel.create()` and error handling.
 */
export function buildInteractionRecord(params: {
  agent: Agent;
  externalAgentId?: string;
  executionId?: string;
  userId?: string;
  sessionId?: string | null;
  sessionSource?: SessionSource;
  providerType: SupportedProviderDiscriminator;
  request: unknown;
  processedRequest: unknown;
  response: unknown;
  actualModel: string;
  baselineModel: string;
  usage: { inputTokens: number; outputTokens: number };
  costs: { baselineCost: number | undefined; actualCost: number | undefined };
  toonStats: ToolCompressionStats;
  toonSkipReason: ToonSkipReason | null;
}): InsertInteraction {
  return {
    profileId: params.agent.id,
    externalAgentId: params.externalAgentId,
    executionId: params.executionId,
    userId: params.userId,
    sessionId: params.sessionId,
    sessionSource: params.sessionSource,
    type: params.providerType,
    request: params.request as InteractionRequest,
    processedRequest: params.processedRequest as InteractionRequest,
    response: params.response as InteractionResponse,
    model: params.actualModel,
    baselineModel: params.baselineModel,
    inputTokens: params.usage.inputTokens,
    outputTokens: params.usage.outputTokens,
    cost: params.costs.actualCost?.toFixed(10) ?? null,
    baselineCost: params.costs.baselineCost?.toFixed(10) ?? null,
    toonTokensBefore: params.toonStats.tokensBefore,
    toonTokensAfter: params.toonStats.tokensAfter,
    toonCostSavings: params.toonStats.costSavings?.toFixed(10) ?? null,
    toonSkipReason: params.toonSkipReason,
  };
}

/**
 * Record OTEL spans and Prometheus metrics for blocked tool calls.
 * Used by both streaming and non-streaming paths when tool invocation
 * policies refuse tool calls.
 */
export function recordBlockedToolCallMetrics(params: {
  allToolCallNames: string[];
  reason: string;
  agent: Agent;
  sessionId?: string | null;
  resolvedUser?: { id: string; email: string; name: string } | null;
  providerName: SupportedProvider;
  toolCallCount: number;
  actualModel: string;
  externalAgentId?: string;
}): void {
  utils.tracing.recordBlockedToolSpans({
    toolCallNames: params.allToolCallNames,
    blockedReason: params.reason,
    agent: params.agent,
    sessionId: params.sessionId,
    agentType: params.agent.agentType ?? undefined,
    user: toSpanUserInfo(params.resolvedUser),
  });

  withSessionContext(params.sessionId, () =>
    metrics.llm.reportBlockedTools(
      params.providerName,
      params.agent,
      params.toolCallCount,
      params.actualModel,
      params.externalAgentId,
    ),
  );
}

/**
 * Run a function within the OTEL context that has the session ID set.
 * Used for metric calls that happen outside the span callback so that
 * exemplar labels include the sessionID for Grafana correlation.
 */
export function withSessionContext<T>(
  sessionId: string | null | undefined,
  fn: () => T,
): T {
  if (!sessionId) return fn();
  const ctx = otelContext.active().setValue(SESSION_ID_KEY, sessionId);
  return otelContext.with(ctx, fn);
}

export function handleError(
  error: unknown,
  reply: FastifyReply,
  extractErrorMessage: (error: unknown) => string,
  isStreaming: boolean,
): FastifyReply | never {
  logger.error(error);

  // Extract status code from error, checking multiple common property names
  // and ensuring the value is a valid number (not undefined/null)
  let statusCode: number = 500;
  if (error instanceof Error) {
    const errorObj = error as Error & {
      status?: number;
      statusCode?: number;
    };
    if (typeof errorObj.status === "number") {
      statusCode = errorObj.status;
    } else if (typeof errorObj.statusCode === "number") {
      statusCode = errorObj.statusCode;
    }
  }

  const errorMessage = extractErrorMessage(error);

  // If headers already sent (mid-stream error), write error to stream.
  // Clients (like AI SDK) detect errors via HTTP status code, but we can't change
  // the status after headers are committed - so SSE error event is our only option.
  // Check reply.raw.headersSent (set after writeHead) rather than reply.sent
  // (which is only set after hijack or full send).
  if (isStreaming && reply.raw.headersSent) {
    const errorEvent = {
      type: "error",
      error: {
        type: "api_error",
        message: errorMessage,
      },
    };
    try {
      reply.raw.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
      reply.raw.end();
    } catch (writeError) {
      // Connection already closed by the client — nothing more we can do.
      logger.debug(
        { err: writeError },
        "Failed to write SSE error event (connection likely closed)",
      );
    }
    return reply;
  }

  // Headers not sent yet - throw ApiError to let central handler return proper status code
  // This matches V1 handler behavior and ensures clients receive correct HTTP status
  throw new ApiError(statusCode, errorMessage);
}
