import config from "@/config";
import logger from "@/logging";
import { isAnthropicBillingBlock } from "@/utils/anthropic-billing-error";
import { joinBaseUrl } from "@/utils/base-url";
import { getAnthropicAuthHeaders } from "./anthropic";

// The free `GET /v1/models` endpoint validates a key but returns 200 even at a
// zero balance, so only a real billed `POST /v1/messages` reveals whether the
// key can actually serve traffic. This fires the cheapest such request (Haiku, a
// 1-token prompt, `max_tokens: 1`) purely to classify the key. Anthropic-only.

/**
 * - `usable`       — key works and has balance (HTTP 200).
 * - `exhausted`    — remaining usage balance too low (out of credit or over a
 *                    usage/spend limit).
 * - `inconclusive` — couldn't determine (transient errors after retries, or any
 *                    other unexpected response). Callers MUST fail open on this.
 */
export type AnthropicCreditVerdict = "usable" | "exhausted" | "inconclusive";

/**
 * Probe an Anthropic key for remaining usage balance. Transient failures (429,
 * 5xx, network, timeout) are retried a few times before resolving `inconclusive`;
 * `usable` / `exhausted` return immediately. Never throws.
 */
export async function probeAnthropicCredit(
  apiKey: string,
  baseUrlOverride?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<AnthropicCreditVerdict> {
  const url = joinBaseUrl(
    baseUrlOverride || config.llm.anthropic.baseUrl,
    "/v1/messages",
  );
  const headers = {
    ...(extraHeaders ?? {}),
    ...(await getAnthropicAuthHeaders(apiKey)),
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  const body = JSON.stringify({
    model: PROBE_MODEL,
    max_tokens: 1,
    // Minimal valid prompt — the content is irrelevant; we only need the request
    // to reach billing so the response classifies the key.
    messages: [{ role: "user", content: "1" }],
  });

  for (let attempt = 1; attempt <= PROBE_MAX_ATTEMPTS; attempt++) {
    const { verdict, retriable } = await runProbeAttempt(url, headers, body);
    if (!retriable) return verdict;
    if (attempt < PROBE_MAX_ATTEMPTS) await delay(PROBE_RETRY_DELAY_MS);
  }
  return "inconclusive";
}

// Behind a custom Anthropic-compatible base URL this model may not be served; the
// probe then can't reach billing and resolves `inconclusive`, and callers fail
// open — the expected, safe fallback for non-standard endpoints.
const PROBE_MODEL = "claude-haiku-4-5";
const PROBE_MAX_ATTEMPTS = 3;
const PROBE_TIMEOUT_MS = 8_000;
const PROBE_RETRY_DELAY_MS = 500;

async function runProbeAttempt(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ verdict: AnthropicCreditVerdict; retriable: boolean }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure or timeout — transient, retry.
    logger.debug({ err }, "Anthropic credit probe request failed (retriable)");
    return { verdict: "inconclusive", retriable: true };
  }

  if (response.ok) return { verdict: "usable", retriable: false };

  const { type, message } = await readAnthropicError(response);
  if (isAnthropicBillingBlock({ status: response.status, type, message })) {
    return { verdict: "exhausted", retriable: false };
  }
  // 429/5xx are transient (retry); anything else is a verdict we can't derive
  // but isn't worth retrying — fail open as inconclusive either way.
  const retriable = response.status === 429 || response.status >= 500;
  return { verdict: "inconclusive", retriable };
}

async function readAnthropicError(
  response: Response,
): Promise<{ type?: string; message?: string }> {
  try {
    const parsed = (await response.json()) as {
      error?: { type?: string; message?: string };
    };
    return { type: parsed?.error?.type, message: parsed?.error?.message };
  } catch {
    return {};
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
