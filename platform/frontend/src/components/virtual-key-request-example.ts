import {
  isModelRouterSupportedProvider,
  requiresOpenAiResponsesApi,
  requiresPerplexityAgentApi,
  requiresResponsesApi,
  type SupportedProvider,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";

/**
 * Model Router providers the router translates into from another wire format.
 * Every other router provider speaks OpenAI chat completions natively.
 */
const TRANSLATED_ROUTER_PROVIDERS: readonly SupportedProvider[] = [
  "anthropic",
  "bedrock",
  "cohere",
  "gemini",
];

export type RequestTarget =
  | { kind: "model-router" }
  | { kind: "provider"; provider: SupportedProvider };

/** Proxy base URL a client points at, mirroring the /connection page. */
export function getProxyBaseUrl(
  connectionBaseUrl: string,
  target: RequestTarget,
): string {
  return target.kind === "model-router"
    ? `${connectionBaseUrl}/model-router`
    : `${connectionBaseUrl}/${target.provider}`;
}

/**
 * The header a provider route reads the API key from (the proxy adapter's
 * `extractApiKey`), or null when this example has no native request for it.
 */
export function getProviderAuthHeader(
  provider: SupportedProvider,
): string | null {
  if (provider === "anthropic") return "x-api-key";
  if (provider === "gemini") return "x-goog-api-key";
  if (provider === "jev") return "Authorization: Bearer";
  return isOpenAiWireProvider(provider) ? "Authorization: Bearer" : null;
}

/**
 * How a request authenticates: a standard virtual key in place of the
 * provider key, a passthrough key beside the caller's own provider key, or a
 * bearer token (an LLM OAuth access token or an identity-provider JWT), which
 * the proxy reads from `Authorization` on every provider route.
 */
export type RequestCredential = "standard" | "passthrough" | "token";

/**
 * A copy-pasteable curl request, or null when the provider has no example
 * (its wire format isn't covered here).
 *
 * Standard keys replace the provider key. Passthrough keys keep the caller's
 * own provider credential (read from an env var) and add the virtual key in
 * the {@link VIRTUAL_KEY_HEADER} header. Tokens go in `Authorization: Bearer`.
 */
export function buildCurlExample(params: {
  connectionBaseUrl: string;
  target: RequestTarget;
  keyType: RequestCredential;
  keyValue: string;
  model: string;
  supportedEndpoints?: readonly string[] | null;
}): string | null {
  const {
    connectionBaseUrl,
    target,
    keyType,
    keyValue,
    model,
    supportedEndpoints,
  } = params;
  const baseUrl = getProxyBaseUrl(connectionBaseUrl, target);
  const passthrough = keyType === "passthrough";

  if (target.kind === "model-router") {
    // The router calls providers with its own mapped keys; a passthrough key
    // has no provider key to pair with there.
    if (passthrough) return null;
    const [provider, ...modelIdParts] = model.split(":");
    const modelId = modelIdParts.join(":");
    const useResponses =
      (provider === "openai" && requiresOpenAiResponsesApi(modelId)) ||
      (provider === "github-copilot" &&
        requiresResponsesApi(supportedEndpoints));
    return curl(
      `${baseUrl}/${useResponses ? "responses" : "chat/completions"}`,
      [`Authorization: Bearer ${keyValue}`, "Content-Type: application/json"],
    )(useResponses ? responsesBody(model) : chatCompletionsBody(model));
  }

  const { provider } = target;
  const credential = passthrough ? `$${providerKeyEnvVar(provider)}` : keyValue;
  // No passthrough key means no attribution header, just the provider key.
  const virtualKeyHeader =
    passthrough && keyValue ? [`${VIRTUAL_KEY_HEADER}: ${keyValue}`] : [];
  // Tokens always travel as a bearer; keys use the provider's own header.
  const authHeader = (header: string) =>
    keyType === "token" ? `Authorization: Bearer ${credential}` : header;

  if (provider === "jev") {
    return curl(`${baseUrl}/decisions`, [
      `Authorization: Bearer ${credential}`,
      ...virtualKeyHeader,
      "Content-Type: application/json",
    ])(decisionsBody(model));
  }
  if (provider === "anthropic") {
    return curl(`${baseUrl}/v1/messages`, [
      authHeader(`x-api-key: ${credential}`),
      ...virtualKeyHeader,
      "anthropic-version: 2023-06-01",
      "Content-Type: application/json",
    ])(
      json({
        model,
        max_tokens: 256,
        messages: [{ role: "user", content: HELLO }],
      }),
    );
  }
  if (provider === "gemini") {
    return curl(`${baseUrl}/v1beta/models/${model}:generateContent`, [
      authHeader(`x-goog-api-key: ${credential}`),
      ...virtualKeyHeader,
      "Content-Type: application/json",
    ])(json({ contents: [{ parts: [{ text: HELLO }] }] }));
  }
  if (isOpenAiWireProvider(provider)) {
    const useResponses =
      (provider === "openai" && requiresOpenAiResponsesApi(model)) ||
      (provider === "perplexity" && requiresPerplexityAgentApi(model)) ||
      (provider === "github-copilot" &&
        requiresResponsesApi(supportedEndpoints));
    return curl(
      `${baseUrl}/${useResponses ? "responses" : "chat/completions"}`,
      [
        `Authorization: Bearer ${credential}`,
        ...virtualKeyHeader,
        "Content-Type: application/json",
      ],
    )(useResponses ? responsesBody(model) : chatCompletionsBody(model));
  }
  return null;
}

/** Env var a passthrough example reads the caller's provider key from. */
export function providerKeyEnvVar(provider: SupportedProvider): string {
  return `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

// ===

const HELLO = "Hello!";

function isOpenAiWireProvider(provider: SupportedProvider): boolean {
  return (
    isModelRouterSupportedProvider(provider) &&
    !TRANSLATED_ROUTER_PROVIDERS.includes(provider)
  );
}

function chatCompletionsBody(model: string): string {
  return json({ model, messages: [{ role: "user", content: HELLO }] });
}

function responsesBody(model: string): string {
  return json({ model, input: HELLO });
}

/** One yes/no question about a tool call: the smallest real decisions request. */
function decisionsBody(model: string): string {
  return json({
    model,
    state: { tool: "github__delete_repo", arguments: { repo: "acme/site" } },
    questions: {
      requires_trusted: {
        type: "noul",
        instructions: "Does this call need a trusted context?",
        criteria: { true: "Changes shared state", false: "Read-only" },
      },
    },
  });
}

function json(body: unknown): string {
  return JSON.stringify(body, null, 2);
}

function curl(url: string, headers: string[]) {
  return (body: string) =>
    [
      `curl "${url}"`,
      ...headers.map((header) => `  -H "${header}"`),
      `  -d '${body.replace(/\n/g, "\n  ")}'`,
    ].join(" \\\n");
}
