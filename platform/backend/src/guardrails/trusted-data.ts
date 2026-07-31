import { createHash } from "node:crypto";
import {
  ApiError,
  ArchestraInternalErrorCode,
  buildTrustedDataBlockedContentNotice,
  extractMcpToolError,
  isSeededAppRenderToolResult,
  type SensitiveContextOrigin,
  TimeInMs,
} from "@archestra/shared";
import {
  DualLlmAgentCallError,
  DualLlmSubagent,
} from "@/agents/subagents/dual-llm";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import {
  resolveRunToolDispatch,
  resolveRunToolTarget,
} from "@/archestra-mcp-server/run-tool-target";
import { type AllowedCacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { TrustedDataPolicyModel } from "@/models";
import type { PolicyEvaluationContext } from "@/models/tool-invocation-policy";
import type {
  CommonMessage,
  DualLlmAnalysis,
  ToolResultUpdates,
  UnsafeContextBoundary,
  UnsafeContextBoundaryReason,
} from "@/types";
import { DualLlmAnalysisSchema, UNSAFE_CONTEXT_BOUNDARY_REASON } from "@/types";

/**
 * A `sanitize_with_dual_llm` policy promises the model never sees the raw
 * tool result — only the quarantined summary. When the analysis itself fails,
 * the only safe outcome is to fail the whole request closed: substituting the
 * raw result (or silently marking it untrusted and continuing) would hand the
 * model exactly the content the policy quarantines.
 *
 * The message carries the actual upstream failure — the provider/model the
 * Dual LLM workflow resolved to (which may differ from the chat request's
 * provider), the upstream HTTP status and provider error code, and the
 * upstream message — so the error surface explains the real cause instead of
 * repeating the policy narrative shown in the streamed dual LLM block.
 */
export class DualLlmSanitizationError extends ApiError {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly upstreamFailure: DualLlmUpstreamFailure;

  constructor(params: {
    toolCallId: string;
    toolName: string;
    cause: unknown;
  }) {
    const upstream = describeDualLlmFailure(params.cause);
    super(
      502,
      buildSanitizationFailureMessage(params.toolName, upstream),
      classifyDualLlmFailureCode(upstream),
    );
    this.name = "DualLlmSanitizationError";
    this.toolCallId = params.toolCallId;
    this.toolName = params.toolName;
    this.upstreamFailure = upstream;
    this.cause = params.cause;
  }
}

/**
 * Evaluate if context is trusted and return updates for tool results
 *
 * @param messages - Messages in common format
 * @param agentId - The agent ID
 * @param apiKey - API key for the LLM provider (optional for Gemini with Vertex AI)
 * @param provider - The LLM provider
 * @param considerContextUntrusted - If true, marks context as untrusted from the beginning
 * @param onDualLlmStart - Optional callback when dual LLM processing starts
 * @param onDualLlmProgress - Optional callback for dual LLM Q&A progress
 * @param onDualLlmError - Optional callback to surface a failed analysis in the stream before the request fails closed
 * @returns Object with tool result updates and trust status
 */
export async function evaluateIfContextIsTrusted(
  messages: CommonMessage[],
  agentId: string,
  organizationId: string,
  userId: string | undefined,
  considerContextUntrusted: boolean = false,
  policyContext: PolicyEvaluationContext,
  onDualLlmStart?: () => void,
  onDualLlmProgress?: (progress: {
    question: string;
    options: string[];
    answer: string;
  }) => void,
  onDualLlmError?: (message: string) => void,
  initialUntrustedReason?: UnsafeContextBoundaryReason,
): Promise<{
  toolResultUpdates: ToolResultUpdates;
  contextIsTrusted: boolean;
  usedDualLlm: boolean;
  dualLlmAnalyses: DualLlmAnalysis[];
  unsafeContextBoundary?: UnsafeContextBoundary;
}> {
  logger.debug(
    {
      agentId,
      messageCount: messages.length,
      considerContextUntrusted,
    },
    "[trustedData] evaluateIfContextIsTrusted: starting evaluation",
  );

  const toolResultUpdates: ToolResultUpdates = {};
  const dualLlmAnalyses: DualLlmAnalysis[] = [];
  let hasUntrustedData = false;
  let usedDualLlm = false;
  let unsafeContextBoundary: UnsafeContextBoundary | undefined;

  // If agent configured to consider context untrusted from the beginning,
  // mark context as untrusted immediately and skip evaluation
  if (considerContextUntrusted) {
    logger.debug(
      { agentId },
      "[trustedData] evaluateIfContextIsTrusted: context marked untrusted by agent config",
    );
    return {
      toolResultUpdates: {},
      contextIsTrusted: false,
      usedDualLlm: false,
      dualLlmAnalyses: [],
      unsafeContextBoundary: {
        kind: "preexisting_untrusted",
        reason:
          initialUntrustedReason ??
          UNSAFE_CONTEXT_BOUNDARY_REASON.agentConfiguredUntrusted,
      },
    };
  }

  // First, collect all tool calls from all messages
  const allToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    toolArguments: Record<string, unknown>;
    isRunToolDispatchTarget: boolean;
    // biome-ignore lint/suspicious/noExplicitAny: tool outputs can be any shape
    toolResult: any;
    isPlatformAuthoredResult: boolean;
    isUnresolvedDispatch: boolean;
  }> = [];

  for (const message of messages) {
    if (message.toolCalls && message.toolCalls.length > 0) {
      for (const toolCall of message.toolCalls) {
        // A run_tool call carries the *target* tool's output (progressive
        // tool loading routes every third-party call through it). Evaluate
        // the target's trusted-data policies — the wrapper's built-in name
        // would be auto-trusted and the target's "sensitive" policy would
        // never fire. A dispatch whose target cannot be recovered from the
        // call's arguments is flagged to fail closed below.
        const dispatch = resolveRunToolDispatch(
          toolCall.name,
          toolCall.arguments,
        );
        allToolCalls.push({
          toolCallId: toolCall.id,
          toolName:
            dispatch.kind === "target" ? dispatch.toolName : toolCall.name,
          // For run_tool dispatches this unwraps to the target tool's own
          // arguments, mirroring the name resolution above.
          toolArguments: resolveRunToolTarget(toolCall.name, toolCall.arguments)
            .toolInput,
          isRunToolDispatchTarget: dispatch.kind === "target",
          toolResult: toolCall.content,
          // Results the platform itself authored carry no external data and
          // must not flip the context to untrusted:
          // - a platform-generated `tool_state` envelope (e.g. unknown_tool)
          //   means no upstream tool ran, so the result is our own text;
          // - a seeded app render (open-in-chat conversation seeding) is a
          //   platform-built render pointer, marked with a reserved `_meta`
          //   key that mcp-client strips from every live upstream result.
          isPlatformAuthoredResult:
            extractMcpToolError(toolCall)?.type === "tool_state" ||
            isSeededAppRenderToolResult(toolCall.content),
          isUnresolvedDispatch: dispatch.kind === "unresolved",
        });
      }
    }
  }

  logger.debug(
    { agentId, toolCallCount: allToolCalls.length },
    "[trustedData] evaluateIfContextIsTrusted: collected tool calls from messages",
  );

  if (allToolCalls.length === 0) {
    logger.debug(
      { agentId },
      "[trustedData] evaluateIfContextIsTrusted: no tool calls found, context is trusted",
    );
    return {
      toolResultUpdates,
      contextIsTrusted: true,
      usedDualLlm: false,
      dualLlmAnalyses: [],
      unsafeContextBoundary,
    };
  }

  // Bulk evaluate all tool calls for trusted data policies
  logger.debug(
    { agentId, toolCallCount: allToolCalls.length },
    "[trustedData] evaluateIfContextIsTrusted: bulk evaluating trusted data policies",
  );
  const evaluationResults = await TrustedDataPolicyModel.evaluateBulk(
    agentId,
    allToolCalls.map(({ toolName, toolResult, isRunToolDispatchTarget }) => ({
      toolName,
      toolOutput: toolResult,
      isRunToolDispatchTarget,
    })),
    policyContext,
  );

  logger.debug(
    { agentId, evaluationResultCount: evaluationResults.size },
    "[trustedData] evaluateIfContextIsTrusted: evaluation results received",
  );

  // Process evaluation results
  let streamedDualLlmStart = false;
  for (let i = 0; i < allToolCalls.length; i++) {
    const {
      toolCallId,
      toolResult,
      toolName,
      toolArguments,
      isPlatformAuthoredResult,
      isUnresolvedDispatch,
    } = allToolCalls[i];
    // A platform-authored result (dispatch error or seeded app render) never
    // carries upstream data. Skip it — otherwise it has no trusted-data
    // evaluation (or no matching policy) and falls through to the untrusted
    // branch below, poisoning the session over a benign platform message.
    if (isPlatformAuthoredResult) {
      continue;
    }
    // A run_tool call whose target tool cannot be recovered: we cannot know
    // which tool produced this data, so its policies cannot be consulted —
    // fail closed rather than inherit the wrapper's built-in auto-trust.
    if (isUnresolvedDispatch) {
      hasUntrustedData = true;
      unsafeContextBoundary ??= createToolResultBoundary({
        reason: "tool_result_marked_untrusted",
        toolCallId,
        toolName,
      });
      continue;
    }
    // evaluateBulk() returns a Map keyed by the stringified input index, so we
    // read results back using the same positional key we submitted above.
    const evaluation = evaluationResults.get(i.toString());

    if (!evaluation) {
      // Tool not found - treat as untrusted
      logger.debug(
        { agentId, toolCallId, toolName },
        "[trustedData] evaluateIfContextIsTrusted: no evaluation result, treating as untrusted",
      );
      hasUntrustedData = true;
      // Preserve the first point where context became unsafe so the UI can show
      // a stable boundary even if later tool results are also untrusted.
      unsafeContextBoundary ??= createToolResultBoundary({
        reason: "tool_result_marked_untrusted",
        toolCallId,
        toolName,
      });
      continue;
    }

    const { isTrusted, isBlocked, shouldSanitizeWithDualLlm, reason } =
      evaluation;
    let toolResultIsTrusted = isTrusted;
    logger.debug(
      {
        agentId,
        toolCallId,
        toolName,
        isTrusted,
        isBlocked,
        shouldSanitizeWithDualLlm,
      },
      "[trustedData] evaluateIfContextIsTrusted: tool evaluation result",
    );

    if (isBlocked) {
      // Tool result is blocked - replace with blocked message
      logger.debug(
        { agentId, toolCallId, reason },
        "[trustedData] evaluateIfContextIsTrusted: tool result blocked by policy",
      );
      toolResultUpdates[toolCallId] = buildTrustedDataBlockedContentNotice({
        reason,
        productName: archestraMcpBranding.catalogName,
      });
      toolResultIsTrusted = false;
      // Preserve the first point where context became unsafe so the UI can show
      // a stable boundary even if later tool results are also untrusted.
      unsafeContextBoundary ??= createToolResultBoundary({
        reason: "tool_result_blocked",
        toolCallId,
        toolName,
      });
    } else if (shouldSanitizeWithDualLlm) {
      usedDualLlm = true;

      const userRequest = extractUserRequest(messages);

      // The agentic loop resends the full history on every round trip, so the
      // same tool result would be re-analyzed once per step (and each analysis
      // is a sequence of LLM calls). Memoize the sanitized analysis across
      // requests and pods; the key hashes everything the analysis depends on.
      const cacheKey = buildSanitizationCacheKey({
        organizationId,
        toolCallId,
        toolName,
        toolResult,
        userRequest,
      });
      const cachedAnalysis = await readCachedSanitization(cacheKey);
      if (cachedAnalysis) {
        logger.debug(
          { agentId, toolCallId },
          "[trustedData] evaluateIfContextIsTrusted: reusing cached dual LLM analysis",
        );
        dualLlmAnalyses.push({ ...cachedAnalysis, toolCallId });
        toolResultUpdates[toolCallId] = cachedAnalysis.result;
        toolResultIsTrusted = true;
      } else {
        if (!streamedDualLlmStart && onDualLlmStart) {
          logger.debug(
            { agentId, toolCallId },
            "[trustedData] evaluateIfContextIsTrusted: starting dual LLM processing",
          );
          onDualLlmStart();
          streamedDualLlmStart = true;
        }

        logger.debug(
          { agentId, toolCallId, organizationId, userId },
          "[trustedData] evaluateIfContextIsTrusted: creating dual LLM subagent",
        );
        let analysis: DualLlmAnalysis;
        try {
          const dualLlmSubagent = await DualLlmSubagent.create({
            dualLlmParams: {
              toolCallId,
              userRequest,
              toolResult,
              toolName,
              toolArguments,
            },
            callingAgentId: agentId,
            organizationId,
            userId,
          });

          logger.debug(
            { agentId, toolCallId },
            "[trustedData] evaluateIfContextIsTrusted: processing with dual LLM subagent",
          );
          analysis =
            await dualLlmSubagent.processWithMainAgent(onDualLlmProgress);
        } catch (error) {
          // Fail closed: the policy promises the model never sees this raw
          // result, so a failed analysis must fail the whole request — not
          // fall through to the untrusted-marking path with raw content.
          logger.error(
            { err: error, agentId, toolCallId, toolName },
            "[trustedData] dual LLM sanitization failed; failing the request closed",
          );
          const sanitizationError = new DualLlmSanitizationError({
            toolCallId,
            toolName,
            cause: error,
          });
          // The streamed block carries the policy narrative; the thrown error
          // carries the upstream mechanics — no duplicated essay between them.
          onDualLlmError?.(
            `Sanitization failed for ${toolName}: ${sanitizationError.upstreamFailure.message}\n\n` +
              `The tool result was not shown to the model — the "sanitize with Dual LLM" trusted data policy fails closed. ` +
              `Fix the organization's LLM API keys before retrying.\n`,
          );
          throw sanitizationError;
        }
        dualLlmAnalyses.push(analysis);
        toolResultUpdates[toolCallId] = analysis.result;
        logger.debug(
          { agentId, toolCallId, summaryLength: analysis.result.length },
          "[trustedData] evaluateIfContextIsTrusted: dual LLM processing complete",
        );
        toolResultIsTrusted = true;
        await writeCachedSanitization(cacheKey, analysis);
      }
    }

    if (!toolResultIsTrusted) {
      hasUntrustedData = true;
      // Preserve the first point where context became unsafe so the UI can show
      // a stable boundary even if later tool results are also untrusted.
      unsafeContextBoundary ??= createToolResultBoundary({
        reason: "tool_result_marked_untrusted",
        toolCallId,
        toolName,
      });
    }
    // If not blocked or sanitized, no update needed (original content remains)
  }

  logger.debug(
    {
      agentId,
      updateCount: Object.keys(toolResultUpdates).length,
      contextIsTrusted: !hasUntrustedData,
      usedDualLlm,
      dualLlmAnalysisCount: dualLlmAnalyses.length,
    },
    "[trustedData] evaluateIfContextIsTrusted: evaluation complete",
  );

  return {
    toolResultUpdates,
    contextIsTrusted: !hasUntrustedData,
    usedDualLlm,
    dualLlmAnalyses,
    unsafeContextBoundary,
  };
}

/**
 * Map the tracked unsafe-context boundary to the origin descriptor embedded in
 * sensitive-context policy block reasons, so the refusal names what flipped
 * the session (a specific tool's result, agent config, or delegation).
 */
export function sensitiveContextOriginFromBoundary(
  boundary: UnsafeContextBoundary | undefined,
): SensitiveContextOrigin | undefined {
  if (!boundary) {
    return undefined;
  }
  if (boundary.kind === "tool_result") {
    return { kind: "tool_result", toolName: boundary.toolName };
  }
  if (boundary.reason === UNSAFE_CONTEXT_BOUNDARY_REASON.inheritedFromParent) {
    return { kind: "inherited_from_parent" };
  }
  return { kind: "agent_configured" };
}

/**
 * Extract the user's original request from messages
 * Looks for the last user message that contains actual content
 */
function extractUserRequest(messages: CommonMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user" && message.content?.trim()) {
      return message.content.trim();
    }
  }

  return "process this data";
}

function createToolResultBoundary(params: {
  reason: UnsafeContextBoundaryReason;
  toolCallId: string;
  toolName: string;
}): UnsafeContextBoundary {
  return {
    kind: "tool_result",
    reason: params.reason,
    toolCallId: params.toolCallId,
    toolName: params.toolName,
  };
}

// A conversation revisits the same tool results for hours; recomputing after
// expiry is cheap (one analysis) and picks up edits to the built-in dual LLM
// agents, so the TTL stays short of a full day.
const SANITIZATION_CACHE_TTL_MS = 6 * TimeInMs.Hour;

function buildSanitizationCacheKey(params: {
  organizationId: string;
  toolCallId: string;
  toolName: string;
  toolResult: unknown;
  userRequest: string;
}): AllowedCacheKey {
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({
        toolName: params.toolName,
        toolResult: params.toolResult,
        userRequest: params.userRequest,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `dual-llm-sanitized-result-${params.organizationId}-${params.toolCallId}-${contentHash}`;
}

async function readCachedSanitization(
  cacheKey: AllowedCacheKey,
): Promise<DualLlmAnalysis | undefined> {
  const cached = await cacheManager.get<DualLlmAnalysis>(cacheKey);
  if (!cached) {
    return undefined;
  }
  const parsed = DualLlmAnalysisSchema.safeParse(cached);
  return parsed.success ? parsed.data : undefined;
}

async function writeCachedSanitization(
  cacheKey: AllowedCacheKey,
  analysis: DualLlmAnalysis,
): Promise<void> {
  try {
    await cacheManager.set(cacheKey, analysis, SANITIZATION_CACHE_TTL_MS);
  } catch (error) {
    // A failed cache write only costs a re-analysis on the next round trip.
    logger.warn(
      { error, cacheKey },
      "[trustedData] failed to cache dual LLM analysis",
    );
  }
}

interface DualLlmUpstreamFailure {
  provider?: string;
  modelName?: string;
  statusCode?: number;
  providerErrorCode?: string;
  message: string;
}

/**
 * Walk a Dual LLM failure to the innermost upstream provider error: through
 * the DualLlmAgentCallError tag (provider/model attribution), then through
 * SDK retry wrappers (RetryError.lastError / .errors) and `cause` chains,
 * collecting the upstream HTTP status, the provider's own error code (from
 * the parsed or raw response body), and the innermost message.
 */
function describeDualLlmFailure(cause: unknown): DualLlmUpstreamFailure {
  const info: DualLlmUpstreamFailure = {
    message: cause instanceof Error ? cause.message : String(cause),
  };

  let current: unknown = cause;
  if (current instanceof DualLlmAgentCallError) {
    info.provider = current.provider;
    info.modelName = current.modelName;
    current = current.cause;
  }

  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    if (current.message) {
      info.message = current.message;
    }

    const candidate = current as Error & {
      statusCode?: unknown;
      status?: unknown;
      data?: unknown;
      responseBody?: unknown;
      lastError?: unknown;
      errors?: unknown;
    };

    const statusCode = candidate.statusCode ?? candidate.status;
    if (info.statusCode === undefined && typeof statusCode === "number") {
      info.statusCode = statusCode;
    }

    info.providerErrorCode ??=
      extractProviderErrorCode(candidate.data) ??
      extractProviderErrorCode(candidate.responseBody);

    const next =
      candidate.lastError ??
      (Array.isArray(candidate.errors) ? candidate.errors.at(-1) : undefined) ??
      candidate.cause;
    if (!(next instanceof Error) || next === current) {
      break;
    }
    current = next;
  }

  return info;
}

/** Pull the provider's own error code out of a parsed or raw error body. */
function extractProviderErrorCode(body: unknown): string | undefined {
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const errorField = (parsed as { error?: unknown }).error;
  const code =
    typeof errorField === "object" && errorField !== null
      ? (errorField as { code?: unknown }).code
      : (parsed as { code?: unknown }).code;
  if (typeof code === "string" && code.length > 0) {
    return code;
  }
  if (typeof code === "number") {
    return `${code}`;
  }
  return undefined;
}

function buildSanitizationFailureMessage(
  toolName: string,
  upstream: DualLlmUpstreamFailure,
): string {
  const model = upstream.provider
    ? `${upstream.provider}${upstream.modelName ? `/${upstream.modelName}` : ""}`
    : "the sanitization model";
  const status =
    upstream.statusCode !== undefined
      ? ` with HTTP ${upstream.statusCode}`
      : "";
  const code =
    upstream.providerErrorCode !== undefined
      ? ` (provider error code ${upstream.providerErrorCode})`
      : "";
  return (
    `Dual LLM sanitization for "${toolName}" failed; the tool result was not shown to the model. ` +
    `Sanitization call to ${model} failed${status}${code}: ${upstream.message}`
  );
}

/**
 * Map the upstream failure to the same normalized codes provider adapters
 * emit, so clients classify the real cause (e.g. the sanitization key being
 * out of credit) instead of a generic API error.
 */
function classifyDualLlmFailureCode(
  upstream: DualLlmUpstreamFailure,
): ArchestraInternalErrorCode | undefined {
  if (
    /insufficient balance|please recharge|credit balance is too low|insufficient credits/i.test(
      upstream.message,
    )
  ) {
    return ArchestraInternalErrorCode.ProviderInsufficientBalance;
  }
  return undefined;
}
