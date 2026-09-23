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
  return isOpenAiWireProvider(provider) ? "Authorization: Bearer" : null;
}

/**
 * A copy-pasteable curl request for a freshly created virtual key, or null
 * when the provider has no example (its wire format isn't covered here).
 *
 * Standard keys replace the provider key. Passthrough keys keep the caller's
 * own provider credential (read from an env var) and add the virtual key in
 * the {@link VIRTUAL_KEY_HEADER} header.
 */
export function buildCurlExample(params: {
  connectionBaseUrl: string;
  target: RequestTarget;
  keyType: "standard" | "passthrough";
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
  const virtualKeyHeader = passthrough
    ? [`${VIRTUAL_KEY_HEADER}: ${keyValue}`]
    : [];

  if (provider === "anthropic") {
    return curl(`${baseUrl}/v1/messages`, [
      `x-api-key: ${credential}`,
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
      `x-goog-api-key: ${credential}`,
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
