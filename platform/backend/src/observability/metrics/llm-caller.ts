import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who made an LLM call, for the opt-in caller labels on LLM metrics
 * (`ARCHESTRA_METRICS_LLM_CALLER_LABELS`). A missing part means the request
 * did not identify one (a service account has no user; a provider key or
 * OAuth client is not a virtual key), and its labels are empty.
 */
export interface LlmMetricsCaller {
  user?: { id: string; email: string } | null;
  virtualKey?: { id: string; name: string } | null;
}

/** Which caller label groups are added to the LLM counters. */
export interface LlmCallerLabelOptions {
  user: boolean;
  virtualKey: boolean;
}

/**
 * Carries the caller of the LLM proxy request being served, so every metric
 * the request emits (including those recorded inside provider transports,
 * which see only the agent) can label it without each call site passing it.
 * A separate module from `llm.ts` so the proxy handler can scope a request
 * even where tests replace the `@/observability` barrel with spies.
 */
class LlmMetricsCallerScope {
  private storage = new AsyncLocalStorage<LlmMetricsCaller>();

  /** Run `fn` with `caller` as the caller of every LLM metric it emits. */
  run<T>(caller: LlmMetricsCaller, fn: () => T): T {
    return this.storage.run(caller, fn);
  }

  /** The caller of the request being served, if any. */
  current(): LlmMetricsCaller | undefined {
    return this.storage.getStore();
  }
}

export const llmMetricsCallerScope = new LlmMetricsCallerScope();
