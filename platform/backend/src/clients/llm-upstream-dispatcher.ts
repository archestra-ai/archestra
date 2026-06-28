import { Agent } from "undici";
import config from "@/config";

/**
 * Shared undici dispatcher for outbound LLM-call fetches.
 *
 * Node's `globalThis.fetch` is backed by undici, whose default `headersTimeout`
 * and `bodyTimeout` are both 5 min — which aborts slow-but-healthy upstreams
 * with `UND_ERR_HEADERS_TIMEOUT`. This Agent raises both timeouts to a
 * configurable value and is injected per-request via the `dispatcher` option on
 * the LLM-call fetches (chat → proxy and proxy → upstream), keeping the change
 * scoped to LLM traffic rather than every fetch in the process.
 *
 * Opt-in: when `ARCHESTRA_LLM_PROXY_UPSTREAM_TIMEOUT_MS` is unset, this returns
 * `undefined` and callers leave undici's defaults untouched (no dispatcher).
 */
let dispatcher: Agent | undefined;

export function getLlmUpstreamDispatcher(): Agent | undefined {
  const upstreamTimeoutMs = config.llmProxy.upstreamTimeoutMs;
  if (!upstreamTimeoutMs) {
    return;
  }

  dispatcher ??= new Agent({
    headersTimeout: upstreamTimeoutMs,
    bodyTimeout: upstreamTimeoutMs,
  });

  return dispatcher;
}
