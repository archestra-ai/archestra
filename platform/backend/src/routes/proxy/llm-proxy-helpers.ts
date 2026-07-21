/**
 * LLM Proxy Helpers
 *
 * Shared helper functions extracted from llm-proxy-handler.ts to reduce
 * duplication between streaming and non-streaming code paths.
 */

import {
  ApiError,
  ArchestraInternalErrorCode,
  type BillingMode,
  type InteractionSource,
  type SupportedProvider,
  type SupportedProviderDiscriminator,
} from "@archestra/shared";
import { context as otelContext } from "@opentelemetry/api";
import type { FastifyReply } from "fastify";
import { isNativeAnthropicModelShape } from "@/clients/anthropic-endpoint";
import logger from "@/logging";
import { metrics } from "@/observability";
import { SESSION_ID_KEY } from "@/observability/request-context";
import type { SpanTeamInfo, SpanUserInfo } from "@/observability/tracing";
import { getTokenizer } from "@/tokenizers";
import type {
  CommonMcpToolDefinition,
  DualLlmAnalysis,
  GatewayAgent,
  InsertInteraction,
  InteractionAuthMethod,
  InteractionRequest,
  InteractionResponse,
  ToolCompressionStats,
  ToonSkipReason,
  UnsafeContextBoundary,
  UsageView,
} from "@/types";
import {
  collectErrorCodes,
  isConnectionErrno,
  isTimeoutErrno,
} from "@/utils/network-errors";
import * as utils from "./utils";
import { estimateToolTokens } from "./utils/cost-optimization";
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
 * Whether to forward the inbound `anthropic-beta` header to the upstream.
 *
 * The Anthropic SDK auto-adds beta flags (e.g. `pdfs-2024-09-25`) that are
 * proprietary to genuine Anthropic. An Anthropic-compatible endpoint (a custom
 * base URL serving a non-Claude model) rejects them with a turn-0 400. Forward
 * for real Anthropic (no base-URL override) and for Claude proxied behind a
 * custom URL (model name still reads `claude`); strip otherwise.
 */
export function shouldForwardAnthropicBeta(
  model: string,
  baseUrlOverridden: boolean,
): boolean {
  return isNativeAnthropicModelShape(model, baseUrlOverridden);
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
  usage: UsageView;
  providerName: SupportedProvider;
}): Promise<{
  baselineCost: number | undefined;
  actualCost: number | undefined;
  cacheCost: number | undefined;
  cacheSavings: number | undefined;
  cacheReadSavings: number | undefined;
}> {
  const cacheTokens = {
    readTokens: params.usage.cacheReadTokens ?? 0,
    writeTokens: params.usage.cacheWriteTokens ?? 0,
    write1hTokens: params.usage.cacheWrite1hTokens ?? 0,
  };
  const baselineCost = await utils.costOptimization.calculateCost(
    params.baselineModel,
    params.usage.inputTokens,
    params.usage.outputTokens,
    params.providerName,
    cacheTokens,
  );
  const actualCost = await utils.costOptimization.calculateCost(
    params.actualModel,
    params.usage.inputTokens,
    params.usage.outputTokens,
    params.providerName,
    cacheTokens,
  );
  const cacheBreakdown = await utils.costOptimization.calculateCacheCost(
    params.actualModel,
    params.providerName,
    cacheTokens.readTokens,
    cacheTokens.writeTokens,
    params.usage.cacheWrite1hTokens ?? 0,
  );
  return {
    baselineCost,
    actualCost,
    cacheCost: cacheBreakdown?.cacheCost,
    cacheSavings: cacheBreakdown?.cacheSavings,
    cacheReadSavings: cacheBreakdown?.cacheReadSavings,
  };
}

/**
 * Some Anthropic-compatible endpoints (a non-Claude model behind a custom base
 * URL) report `input_tokens: 0` even for a non-empty prompt, which would zero out
 * this request's input-token cost and usage-limit accounting. When usage shows zero
 * uncached input yet produced output, and no cache tokens explain the zero, replace
 * `inputTokens` with a local estimate and mark the row estimated.
 *
 * Intentionally provider-agnostic: a zero-input-with-output response for a non-empty
 * request is a provider accounting bug regardless of vendor, and the estimate is the
 * right remedy for all of them. The normal path (any non-zero input, or a legitimately
 * fully-cached prompt) returns untouched and is never tokenized. Estimation is
 * best-effort: any failure degrades to the provider's (zero) value rather than
 * breaking interaction recording.
 */
export function applyInputTokenFallback(params: {
  usage: UsageView;
  provider: SupportedProvider;
  providerMessages: unknown;
  tools: CommonMcpToolDefinition[];
  model: string;
}): UsageView {
  const { usage } = params;
  const hasCacheTokens =
    (usage.cacheReadTokens ?? 0) !== 0 ||
    (usage.cacheWriteTokens ?? 0) !== 0 ||
    (usage.cacheWrite1hTokens ?? 0) !== 0;
  if (usage.inputTokens !== 0 || usage.outputTokens <= 0 || hasCacheTokens) {
    return usage;
  }

  let estimatedInputTokens: number;
  try {
    estimatedInputTokens = estimateRequestInputTokens({
      provider: params.provider,
      providerMessages: params.providerMessages,
      tools: params.tools,
    });
  } catch (error) {
    // An unexpected message shape must not break interaction recording — fall back
    // to the provider's value (zero input) and surface the failure for triage.
    logger.warn(
      { err: error, provider: params.provider, model: params.model },
      "Failed to estimate input tokens for a zero-input response; leaving it unrecorded",
    );
    return usage;
  }
  if (estimatedInputTokens <= 0) {
    return usage;
  }

  logger.warn(
    {
      provider: params.provider,
      model: params.model,
      estimatedInputTokens,
      outputTokens: usage.outputTokens,
    },
    "Provider reported 0 input tokens for a non-empty request; recording a local estimate",
  );
  return {
    ...usage,
    inputTokens: estimatedInputTokens,
    inputTokensEstimated: true,
  };
}

/**
 * Build the InsertInteraction record from proxy context and response data.
 * Pure function — callers handle `InteractionModel.create()` and error handling.
 */
export function buildInteractionRecord(params: {
  agent: GatewayAgent;
  externalAgentId?: string;
  authMethod?: InteractionAuthMethod;
  billingMode: BillingMode;
  authenticatedApp?: {
    id: string;
    name: string;
    clientId: string;
  };
  executionId?: string;
  userId?: string;
  virtualKeyId?: string;
  passthroughVirtualKeyId?: string;
  sessionId?: string | null;
  sessionSource?: SessionSource;
  source?: InteractionSource | null;
  providerType: SupportedProviderDiscriminator;
  request: unknown;
  processedRequest: unknown;
  response: unknown;
  actualModel: string;
  baselineModel: string;
  usage: UsageView;
  costs: {
    baselineCost: number | undefined;
    actualCost: number | undefined;
    cacheCost: number | undefined;
    cacheSavings: number | undefined;
  };
  toonStats: ToolCompressionStats;
  toonSkipReason: ToonSkipReason | null;
  dualLlmAnalyses: DualLlmAnalysis[];
  unsafeContextBoundary?: UnsafeContextBoundary;
}): InsertInteraction {
  return {
    profileId: params.agent.id,
    externalAgentId: params.externalAgentId,
    authMethod: params.authMethod,
    billingMode: params.billingMode,
    authenticatedAppId: params.authenticatedApp?.id,
    authenticatedAppName: params.authenticatedApp?.name,
    executionId: params.executionId,
    userId: params.userId,
    virtualKeyId: params.virtualKeyId,
    passthroughVirtualKeyId: params.passthroughVirtualKeyId,
    sessionId: params.sessionId,
    sessionSource: params.sessionSource,
    source: params.source,
    type: params.providerType,
    request: params.request as InteractionRequest,
    processedRequest: params.processedRequest as InteractionRequest,
    response: params.response as InteractionResponse,
    dualLlmAnalyses: params.dualLlmAnalyses,
    unsafeContextBoundary: params.unsafeContextBoundary,
    model: params.actualModel,
    baselineModel: params.baselineModel,
    inputTokens: params.usage.inputTokens,
    inputTokensEstimated: params.usage.inputTokensEstimated ?? false,
    outputTokens: params.usage.outputTokens,
    cacheReadTokens: params.usage.cacheReadTokens ?? null,
    cacheWriteTokens: params.usage.cacheWriteTokens ?? null,
    cacheWrite1hTokens: params.usage.cacheWrite1hTokens ?? null,
    cost: params.costs.actualCost?.toFixed(10) ?? null,
    baselineCost: params.costs.baselineCost?.toFixed(10) ?? null,
    cacheCost: params.costs.cacheCost?.toFixed(10) ?? null,
    cacheSavings: params.costs.cacheSavings?.toFixed(10) ?? null,
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
  agent: GatewayAgent;
  teams?: SpanTeamInfo[];
  userTeams?: SpanTeamInfo[];
  sessionId?: string | null;
  resolvedUser?: { id: string; email: string; name: string } | null;
  providerName: SupportedProvider;
  toolCallCount: number;
  actualModel: string;
  source: InteractionSource;
}): void {
  utils.tracing.recordBlockedToolSpans({
    toolCallNames: params.allToolCallNames,
    blockedReason: params.reason,
    agent: params.agent,
    teams: params.teams,
    userTeams: params.userTeams,
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
      params.source,
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
  extractInternalCode: (
    error: unknown,
  ) => ArchestraInternalErrorCode | undefined,
): FastifyReply | never {
  logger.error(error);

  // Extract status code from error, checking multiple common property names
  // and ensuring the value is a valid number (not undefined/null)
  let statusCode: number = 500;
  let hasExplicitStatus = false;
  if (error instanceof Error) {
    const errorObj = error as Error & {
      status?: number;
      statusCode?: number;
    };
    if (typeof errorObj.status === "number") {
      statusCode = errorObj.status;
      hasExplicitStatus = true;
    } else if (typeof errorObj.statusCode === "number") {
      statusCode = errorObj.statusCode;
      hasExplicitStatus = true;
    }
  }

  // Some SDK transport and streaming failures do not carry an HTTP status.
  if (!hasExplicitStatus) {
    const upstreamStatus = classifyTransientUpstreamError(error);
    if (upstreamStatus !== undefined) {
      statusCode = upstreamStatus;
    }
  }

  // The internal code preserves overload semantics after streaming starts.
  const isUpstreamOverload =
    statusCode === 529 ||
    (statusCode === 503 &&
      !(error instanceof ApiError) &&
      classifyUpstreamOverload(error) !== undefined);

  const errorMessage = extractErrorMessage(error);
  const internalCode =
    extractInternalCode(error) ??
    (error instanceof ApiError ? error.internalCode : undefined) ??
    (isUpstreamOverload
      ? ArchestraInternalErrorCode.ProviderOverloaded
      : undefined);

  // Headers cannot be changed after streaming starts.
  if (!reply.raw.headersSent) {
    const retryAfter = extractRetryAfterHeader(error);
    if (retryAfter !== undefined) {
      reply.header("retry-after", retryAfter);
    }
  }

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
        // Surface the normalized code (e.g. provider_insufficient_balance)
        // mid-stream too, so a failure after headers commit stays classifiable.
        ...(internalCode ? { internal_code: internalCode } : {}),
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
  throw new ApiError(statusCode, errorMessage, internalCode);
}

/**
 * Classify status-less SDK transport and overload errors as upstream failures.
 */
function classifyTransientUpstreamError(
  error: unknown,
): 502 | 503 | 504 | 529 | undefined {
  if (!(error instanceof Error)) return undefined;

  const overloadStatus = classifyUpstreamOverload(error);
  if (overloadStatus !== undefined) return overloadStatus;

  const { name, message } = error;
  const codes = collectErrorCodes(error);

  const isTimeout =
    name === "APIConnectionTimeoutError" ||
    /timed out|timeout/i.test(message) ||
    codes.some(isTimeoutErrno);
  if (isTimeout) return 504;

  const isConnectionFailure =
    name === "APIConnectionError" ||
    /^connection error\.?$/i.test(message) ||
    /fetch failed|socket hang up|network error|connection (?:reset|refused|closed|aborted)|terminated/i.test(
      message,
    ) ||
    codes.some(isConnectionErrno);
  if (isConnectionFailure) return 502;

  return undefined;
}

/**
 * Anthropic's `overloaded_error` maps to 529; other provider overloads map to
 * 503. Message matching is limited to SDK-like errors so internal failures are
 * not reclassified.
 */
function classifyUpstreamOverload(error: unknown): 503 | 529 | undefined {
  if (!(error instanceof Error)) return undefined;

  if (
    nestedProviderErrorType(error) === "overloaded_error" ||
    /\boverloaded_error\b/.test(error.message)
  ) {
    return 529;
  }
  const hasProviderErrorShape =
    "error" in error ||
    "headers" in error ||
    "status" in error ||
    "statusCode" in error;
  if (hasProviderErrorShape && /\boverloaded\b/i.test(error.message)) {
    return 503;
  }

  return undefined;
}

/**
 * Read a provider error type from the SDK's direct or nested error body.
 */
function nestedProviderErrorType(error: Error): string | undefined {
  const body = (error as Error & { error?: unknown }).error;
  const inner =
    body && typeof body === "object"
      ? (body as { error?: unknown }).error
      : undefined;
  for (const candidate of [inner, body]) {
    if (candidate && typeof candidate === "object") {
      const type = (candidate as { type?: unknown }).type;
      if (typeof type === "string" && type !== "error") return type;
    }
  }
  return undefined;
}

/**
 * Read a valid Retry-After value from current or legacy SDK error headers.
 */
function extractRetryAfterHeader(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const headers = (error as Error & { headers?: unknown }).headers;

  let value: unknown;
  if (headers instanceof Headers) {
    value = headers.get("retry-after");
  } else if (headers && typeof headers === "object") {
    const record = headers as Record<string, unknown>;
    value = record["retry-after"] ?? record["Retry-After"];
  }
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed) || Number.isFinite(Date.parse(trimmed))) {
    return trimmed;
  }
  return undefined;
}

/**
 * Estimate input tokens for a request from its provider messages + tool schemas,
 * using the provider's tokenizer (mirrors the cost-optimization estimator). The
 * system prompt is not separately counted, matching that path. May throw on an
 * unexpected message shape; the caller (applyInputTokenFallback) contains that.
 */
function estimateRequestInputTokens(params: {
  provider: SupportedProvider;
  providerMessages: unknown;
  tools: CommonMcpToolDefinition[];
}): number {
  const tokenizer = getTokenizer(params.provider);
  const messageTokens = tokenizer.countTokens(
    params.providerMessages as Parameters<typeof tokenizer.countTokens>[0],
  );
  const toolTokens = estimateToolTokens(params.tools, tokenizer);
  return messageTokens + toolTokens;
}
