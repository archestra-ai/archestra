/**
 * Injects OpenRouter's response-healing plugin so OpenRouter repairs malformed
 * structured-output JSON server-side. It only takes effect on non-streaming
 * requests carrying a json `response_format`.
 *
 * @see https://openrouter.ai/docs/guides/features/plugins/response-healing
 */

const RESPONSE_HEALING_PLUGIN_ID = "response-healing";

type ResponseHealingRequest = {
  stream?: boolean | null;
  response_format?: { type?: string | null } | null;
  plugins?: Array<{ id: string }>;
};

/**
 * Returns the request with the healing plugin appended when it can take effect.
 * Pure and idempotent — never mutates the input, never duplicates the plugin.
 */
export function applyResponseHealing(
  request: ResponseHealingRequest,
): ResponseHealingRequest {
  const type = request.response_format?.type;
  const plugins = request.plugins ?? [];
  const shouldHeal =
    request.stream !== true &&
    (type === "json_schema" || type === "json_object") &&
    !plugins.some((plugin) => plugin.id === RESPONSE_HEALING_PLUGIN_ID);

  return shouldHeal
    ? { ...request, plugins: [...plugins, { id: RESPONSE_HEALING_PLUGIN_ID }] }
    : request;
}

/**
 * Wraps a `fetch` so OpenRouter requests gain the response-healing plugin.
 * Direct OpenRouter models (via the Vercel AI SDK) bypass our proxy adapter,
 * and the SDK's only body hook is `fetch`. It always sends a JSON string body.
 */
export function createResponseHealingFetch(
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init) => {
    const body = init?.body;
    if (typeof body !== "string") {
      return baseFetch(input, init);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return baseFetch(input, init);
    }
    if (parsed === null || typeof parsed !== "object") {
      return baseFetch(input, init);
    }

    const healed = applyResponseHealing(parsed as ResponseHealingRequest);
    if (healed === parsed) {
      return baseFetch(input, init);
    }

    // Body length changed; drop any stale content-length so fetch recomputes it.
    const headers = new Headers(init?.headers);
    headers.delete("content-length");
    return baseFetch(input, {
      ...init,
      body: JSON.stringify(healed),
      headers,
    });
  };
}
