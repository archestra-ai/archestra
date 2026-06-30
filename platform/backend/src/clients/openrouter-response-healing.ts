/**
 * OpenRouter response-healing plugin.
 *
 * Appends `{ id: "response-healing" }` to a request's `plugins` so OpenRouter
 * repairs malformed structured-output JSON server-side. The plugin only takes
 * effect on NON-streaming requests carrying a json `response_format`, so we
 * inject it exactly under those conditions and leave every other request
 * untouched.
 *
 * @see https://openrouter.ai/docs/guides/features/plugins/response-healing
 */
import config from "@/config";

const RESPONSE_HEALING_PLUGIN_ID = "response-healing";

type Plugin = { id: string };

/** Minimal request shape the healing decision depends on. */
type HealableRequest = {
  stream?: boolean | null;
  response_format?: { type?: string | null } | null;
  plugins?: Plugin[];
};

/**
 * Returns the request with the response-healing plugin appended when (and only
 * when) it can take effect: feature enabled, non-streaming, and a json
 * `response_format` present. Pure and idempotent — never mutates the input and
 * never duplicates an already-present healing plugin.
 */
export function applyResponseHealing<T extends HealableRequest>(
  request: T,
): T & { plugins?: Plugin[] } {
  if (!config.llm.openrouter.responseHealing) {
    return request;
  }
  if (request.stream === true) {
    return request;
  }
  const responseFormatType = request.response_format?.type;
  if (
    responseFormatType !== "json_schema" &&
    responseFormatType !== "json_object"
  ) {
    return request;
  }

  const plugins = request.plugins ?? [];
  if (plugins.some((plugin) => plugin.id === RESPONSE_HEALING_PLUGIN_ID)) {
    return request;
  }

  return {
    ...request,
    plugins: [...plugins, { id: RESPONSE_HEALING_PLUGIN_ID }],
  };
}

/**
 * Wraps a `fetch` so OpenRouter requests gain the response-healing plugin.
 *
 * Direct OpenRouter models (via the Vercel AI SDK) bypass our proxy adapter, so
 * this is the only injection point for them. The SDK serializes request bodies
 * to a JSON string; we heal that body and forward everything else untouched.
 * Only attach this to OpenRouter-bound clients.
 */
export function createResponseHealingFetch(
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init) => {
    // The Vercel AI SDK always calls fetch as `(url, { body: <json string> })`,
    // so we only handle string bodies; any other shape is forwarded untouched.
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

    const healed = applyResponseHealing(parsed as HealableRequest);
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
