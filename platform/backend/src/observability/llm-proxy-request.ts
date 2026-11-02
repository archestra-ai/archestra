import type { InteractionSource, SupportedProvider } from "@archestra/shared";
import { type Context, context } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { GenAiOperationName } from "@/types";
import { reportLlmProxyRequest } from "./metrics/llm-proxy";

export type ProxyRequestFailure = {
  statusCode: number;
  origin: "archestra" | "provider" | "client";
  outcome:
    | "error"
    | "throttled"
    | "denied"
    | "cancelled"
    | "timeout"
    | "overloaded";
};

/** The router and provider handler share one lifecycle instead of counting twice. */
export function getLlmProxyRequestTelemetry(params: {
  request: object;
  provider: SupportedProvider | "router";
  operation: GenAiOperationName;
  stream: boolean;
}): LlmProxyRequestTelemetry {
  const existing = requests.get(params.request);
  if (existing) {
    existing.setProvider(params.provider);
    return existing;
  }
  const telemetry = new LlmProxyRequestTelemetry(params);
  requests.set(params.request, telemetry);
  return telemetry;
}

/** One logical request; retries and pool attempts never emit another observation. */
export class LlmProxyRequestTelemetry {
  private readonly startedAt = Date.now();
  private traceContext = context.active();
  private failure?: ProxyRequestFailure;
  private incomplete = false;
  private serverAborted = false;
  private finished = false;
  // An explicit metadata allowlist, never request bodies, headers or error messages.
  metadata: {
    model?: string;
    organizationId?: string;
    agentId?: string;
    userId?: string;
    virtualKeyId?: string;
    passthroughVirtualKeyId?: string;
    appId?: string;
    source?: InteractionSource;
    modelPoolMemberModel?: string;
    modelPoolId?: string;
    providerApiKeyId?: string;
    poolAttempts?: number;
  } = {};

  constructor(
    private readonly request: {
      provider: SupportedProvider | "router";
      operation: GenAiOperationName;
      stream: boolean;
    },
  ) {}

  setProvider(provider: SupportedProvider | "router"): void {
    this.request.provider = provider;
  }

  setStreaming(stream: boolean): void {
    this.request.stream = stream;
  }

  markIncomplete(): void {
    this.incomplete = true;
  }

  markServerAbort(): void {
    this.serverAborted = true;
  }

  fail(failure: ProxyRequestFailure): void {
    // Preserve the original failure if a response mapper rethrows a generic ApiError.
    // A later operational failure does supersede a policy denial while settling the response.
    if (!this.failure || this.failure.outcome === "denied")
      this.failure = failure;
  }

  setTraceContext(traceContext: Context): void {
    this.traceContext = traceContext;
  }

  finish(params: {
    statusCode: number;
    headersSent: boolean;
    disconnected: boolean;
  }): void {
    if (this.finished) return;
    this.finished = true;
    if (params.disconnected && !this.serverAborted)
      this.failure = {
        statusCode: 499,
        origin: "client",
        outcome: "cancelled",
      };
    if (!this.failure && params.statusCode >= 400)
      this.fail({
        statusCode: params.statusCode,
        origin: "archestra",
        outcome:
          params.statusCode === 429
            ? "throttled"
            : params.statusCode === 402 || params.statusCode === 403
              ? "denied"
              : "error",
      });
    // A stream keeps its committed 200 even if an error arrives in a later frame.
    const statusCode = normalizeStatus(
      params.headersSent
        ? params.statusCode
        : (this.failure?.statusCode ?? params.statusCode),
    );
    const outcome =
      this.failure?.outcome ?? (this.incomplete ? "incomplete" : "success");
    const errorOrigin = this.failure?.origin ?? "none";
    const durationSeconds = Math.max(0, Date.now() - this.startedAt) / 1000;
    try {
      reportLlmProxyRequest({
        ...this.request,
        statusCode,
        outcome,
        errorOrigin,
        durationSeconds,
      });
    } catch {
      // Telemetry must not change a response or hide its original failure.
    }
    try {
      // No standard OTel event describes a gateway's final logical outcome.
      // Standard GenAI/HTTP attributes are reused; only gateway semantics are custom.
      const attributes: Record<string, string | number | boolean> = {
        "gen_ai.provider.name": this.request.provider,
        "gen_ai.operation.name": this.request.operation,
        "gen_ai.request.streaming": this.request.stream,
        "http.response.status_code": statusCode,
        "archestra.proxy.outcome": outcome,
        "archestra.proxy.error_origin": errorOrigin,
        "archestra.proxy.duration_seconds": durationSeconds,
      };
      const metadata = {
        "gen_ai.request.model": this.metadata.model,
        "archestra.organization.id": this.metadata.organizationId,
        "gen_ai.agent.id": this.metadata.agentId,
        "archestra.user.id": this.metadata.userId,
        "archestra.virtual_key.id": this.metadata.virtualKeyId,
        "archestra.passthrough_virtual_key.id":
          this.metadata.passthroughVirtualKeyId,
        "archestra.app.id": this.metadata.appId,
        "archestra.trigger.source": this.metadata.source,
        // Configured pool member model, not a model reported by a provider response.
        "archestra.model_pool.member_model": this.metadata.modelPoolMemberModel,
        "archestra.model_pool.id": this.metadata.modelPoolId,
        "archestra.provider_api_key.id": this.metadata.providerApiKeyId,
        "archestra.proxy.pool_attempts": this.metadata.poolAttempts,
      };
      for (const [key, value] of Object.entries(metadata))
        if (value !== undefined) attributes[key] = value;
      if (this.failure)
        attributes["error.type"] = String(
          normalizeStatus(this.failure.statusCode),
        );
      logs.getLogger("archestra-llm-proxy").emit({
        context: this.traceContext,
        eventName: "archestra.llm_proxy.request",
        body: "LLM proxy request completed",
        severityNumber: this.failure
          ? SeverityNumber.WARN
          : SeverityNumber.INFO,
        attributes,
      });
    } catch {
      // Export is best-effort, independently of metric reporting and trace sampling.
    }
  }
}

function normalizeStatus(status: number): number {
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : 500;
}

const requests = new WeakMap<object, LlmProxyRequestTelemetry>();
