import { hasArchestraTokenPrefix } from "@archestra/shared";
import OpenAI from "openai";
import config from "@/config";
import logger from "@/logging";
import { ApiError } from "@/types";
import { grokCatalogForProxy } from "./grok-native-catalog";
import { openAiResponsesAdapterFactory } from "./openai-responses";
import { xaiAdapterFactory } from "./xai";

type NativeGrokApiBackend = "chat_completions" | "responses";

export function nativeGrokSessionAdapter(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): typeof xaiAdapterFactory | null;
export function nativeGrokSessionAdapter(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  apiBackend: "chat_completions",
): typeof xaiAdapterFactory | null;
export function nativeGrokSessionAdapter(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  apiBackend: "responses",
): typeof openAiResponsesAdapterFactory | null;
export function nativeGrokSessionAdapter(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  apiBackend: NativeGrokApiBackend = "chat_completions",
): typeof xaiAdapterFactory | typeof openAiResponsesAdapterFactory | null {
  if (
    headers["x-archestra-grok-credential-mode"] !== "native-session" &&
    headers["x-xai-token-auth"] !== "xai-grok-cli"
  )
    return null;
  const authorization =
    typeof headers.authorization === "string"
      ? headers.authorization.replace(/^Bearer /i, "")
      : "";
  if (!/^[^\s]{1,16384}$/.test(authorization))
    throw new ApiError(401, "Native Grok session authentication is required.");
  if (/^(?:xai[-_]|sk-)/i.test(authorization))
    throw new ApiError(
      401,
      "API keys cannot authenticate native Grok subscription mode. Select API-key mode or sign in with grok login.",
    );
  if (
    hasArchestraTokenPrefix(authorization) ||
    /^(?:xai-subscription|chatgpt-oauth):/.test(authorization)
  )
    throw new ApiError(
      401,
      "A native Grok access token, not a platform key or stored subscription credential, is required.",
    );
  // Both markers select the transport; neither authenticates the caller.
  // Custom native models can omit the vendor marker. Set it for the fixed
  // upstream, which still validates the actual native bearer on every call.
  const sessionHeaders: Record<string, string> = {
    "x-xai-token-auth": "xai-grok-cli",
  };
  for (const name of [
    "x-userid",
    "x-email",
    "x-authenticateresponse",
    "x-grok-client-version",
    "x-grok-client-identifier",
    "x-grok-client-mode",
    "x-grok-session-id",
    "x-grok-conv-id",
    "x-grok-conv-group-id",
    "x-grok-agent-id",
    "x-grok-req-id",
    "x-grok-turn-idx",
  ]) {
    const value = headers[name];
    if (
      typeof value === "string" &&
      value.length <= 16384 &&
      !/[\r\n]/.test(value)
    )
      sessionHeaders[name] = value;
  }
  let nativeAccepted = false;
  const nativeClient = {
    isSubscriptionCredential: (credential: string | undefined) =>
      nativeAccepted && credential?.replace(/^Bearer /i, "") === authorization,
    getBaseUrl: () => config.llm.xai.subscription.baseUrl,
    createClient: (
      credential: string | undefined,
      options: Parameters<typeof xaiAdapterFactory.createClient>[1],
    ) => {
      if (
        !credential ||
        credential.replace(/^Bearer /i, "") !== authorization ||
        options.llmProviderApiKeyId ||
        (options.baseUrl &&
          options.baseUrl.replace(/\/+$/, "") !==
            config.llm.xai.subscription.baseUrl.replace(/\/+$/, ""))
      )
        throw new ApiError(
          400,
          "Native Grok subscription requests cannot use a provider key or a custom upstream.",
        );
      return new OpenAI({
        apiKey: credential.replace(/^Bearer /i, ""),
        baseURL: config.llm.xai.subscription.baseUrl,
        maxRetries: 0,
        defaultHeaders: sessionHeaders,
        fetch: async (input, init) => {
          nativeAccepted = false;
          options.onResponseHeaders?.(new Headers());
          const response = await fetch(input, { ...init, redirect: "error" });
          nativeAccepted = response.ok;
          options.onResponseHeaders?.(response.headers);
          return response;
        },
      });
    },
  };
  if (apiBackend === "responses") {
    return {
      ...openAiResponsesAdapterFactory,
      ...nativeClient,
      provider: "xai",
      interactionType: "xai:responses",
      executeStream: async (
        client: Parameters<
          typeof openAiResponsesAdapterFactory.executeStream
        >[0],
        request: Parameters<
          typeof openAiResponsesAdapterFactory.executeStream
        >[1],
        onAccepted?: Parameters<
          typeof openAiResponsesAdapterFactory.executeStream
        >[2],
      ) => {
        const stream = await openAiResponsesAdapterFactory.executeStream.call(
          { provider: "xai", interactionType: "xai:responses" },
          client,
          request,
          onAccepted,
        );
        return {
          async *[Symbol.asyncIterator]() {
            try {
              yield* stream;
            } catch (error) {
              nativeAccepted = false;
              throw error;
            }
          },
        };
      },
    };
  }
  return { ...xaiAdapterFactory, ...nativeClient };
}

export async function resolveNativeGrokDefault(params: {
  model: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  apiBackend?: NativeGrokApiBackend;
}): Promise<string> {
  if (params.model !== "archestra-native-default") return params.model;
  const adapter = nativeGrokSessionAdapter(params.headers);
  if (!adapter)
    throw new ApiError(
      400,
      "Native Grok automatic selection requires native subscription mode.",
    );
  let catalogShape: Record<string, unknown> = {};
  try {
    const signal = AbortSignal.timeout(10000);
    const settings = (await fetchNativeGrokMetadata({
      name: "settings",
      headers: params.headers,
      signal,
    })) as { default_model?: unknown } | null;
    const defaultModel = settings?.default_model;
    if (
      typeof defaultModel !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(defaultModel)
    )
      throw new Error("default unavailable");
    const body = (await fetchNativeGrokMetadata({
      name: "models",
      headers: params.headers,
      signal,
    })) as {
      data?: unknown;
      models?: unknown;
    };
    const models = body.data ?? body.models;
    const entry = Array.isArray(models)
      ? models.find(
          (candidate) =>
            candidate &&
            typeof candidate === "object" &&
            candidate.id === defaultModel,
        )
      : null;
    catalogShape = {
      dataArray: Array.isArray(body.data),
      modelsArray: Array.isArray(body.models),
      count: Array.isArray(models) ? models.length : 0,
      defaultPresent: Boolean(entry),
      modelField: typeof entry?.model,
      modelIdField: typeof entry?.modelId,
      metaModelField: typeof entry?._meta?.model,
      backend: ["chat_completions", "responses", "messages"].includes(
        entry?.api_backend,
      )
        ? entry.api_backend
        : "other_or_absent",
      hidden: entry?.hidden === true || entry?._meta?.hidden === true,
    };
    if (!entry) throw new Error("default unavailable");
    const model =
      entry?.model ??
      entry?.modelId ??
      entry?._meta?.model ??
      entry?._meta?.modelId ??
      entry?.id;
    const backend = entry?.apiBackend ?? entry?.api_backend;
    const modelBase = entry?.baseUrl ?? entry?.base_url;
    if (
      (backend ?? "chat_completions") !==
      (params.apiBackend ?? "chat_completions")
    )
      throw new ApiError(
        400,
        "The native Grok default model requires a different inference protocol. Reconnect Grok to update its managed model configuration. No inference request was sent.",
      );
    if (
      entry.hidden === true ||
      entry._meta?.hidden === true ||
      (backend !== undefined &&
        backend !== "chat_completions" &&
        backend !== "responses") ||
      (modelBase !== undefined &&
        (typeof modelBase !== "string" ||
          modelBase.replace(/\/+$/, "") !==
            config.llm.xai.subscription.baseUrl.replace(/\/+$/, ""))) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(
        typeof model === "string" ? model : "",
      )
    )
      throw new Error("default unavailable");
    return model;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.warn(
      {
        nativeGrokCatalogShape: catalogShape,
        credentialMode: "native-session",
        authShape:
          String(params.headers.authorization).split(".").length === 3
            ? "three-part-token"
            : "opaque-token",
        headerNames: [
          "x-xai-token-auth",
          "x-userid",
          "x-email",
          "x-authenticateresponse",
          "x-grok-client-version",
        ].filter((name) => typeof params.headers[name] === "string"),
      },
      "Native Grok catalog mapping rejected an unsupported shape",
    );
    throw new ApiError(
      502,
      "The native Grok catalog did not identify an available default model. Choose an explicit subscription model or retry later.",
    );
  }
}

/** Native account metadata only; never a general subscription passthrough. */
export async function fetchNativeGrokMetadata(params: {
  name: "models" | "settings" | "login-config" | "user";
  headers: Readonly<Record<string, string | string[] | undefined>>;
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${config.llm.xai.subscription.baseUrl.replace(/\/+$/, "")}${nativeMetadataPath(params.name)}`,
    {
      headers: nativeAccountHeaders(params.headers),
      redirect: "error",
      signal: params.signal,
    },
  ).catch(() => {
    throw new ApiError(
      502,
      "Native Grok model discovery is unavailable. No inference request was sent.",
    );
  });
  if (!response.ok)
    throw new ApiError(
      response.status === 401 || response.status === 403
        ? response.status
        : 502,
      "Native Grok model discovery failed. Sign in with grok login or retry when the subscription service is available.",
    );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty native metadata");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 2 * 1024 * 1024) throw new Error("limit");
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ApiError(502, "Native Grok metadata has an unsupported shape.");
    return params.name === "models"
      ? grokCatalogForProxy(value as Record<string, unknown>)
      : (value as Record<string, unknown>);
  } catch {
    throw new ApiError(
      502,
      "Native Grok metadata was incomplete or invalid. Retry when the subscription service is available.",
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function nativeMetadataPath(name: string): string {
  // Select literal paths at runtime too; never interpolate a caller's string.
  switch (name) {
    case "models":
      return "/models";
    case "settings":
      return "/settings";
    case "login-config":
      return "/login-config";
    case "user":
      return "/user";
    default:
      throw new ApiError(400, "Unsupported native Grok metadata endpoint.");
  }
}

/** Only the native privacy toggle; this is not an arbitrary account proxy. */
export async function updateNativeGrokPrivacy(params: {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  optOut: boolean;
  signal: AbortSignal;
}): Promise<void> {
  const response = await fetch(
    `${config.llm.xai.subscription.baseUrl.replace(/\/+$/, "")}/privacy/coding-data-retention`,
    {
      method: "PUT",
      headers: {
        ...nativeAccountHeaders(params.headers),
        "content-type": "application/json",
      },
      body: JSON.stringify({ codingDataRetentionOptOut: params.optOut }),
      redirect: "error",
      signal: params.signal,
    },
  ).catch(() => {
    throw new ApiError(
      502,
      "Native Grok privacy settings could not be updated.",
    );
  });
  await response.body?.cancel().catch(() => {});
  if (!response.ok)
    throw new ApiError(
      [400, 401, 403, 409, 429].includes(response.status)
        ? response.status
        : 502,
      "The native Grok service rejected the privacy update. Your local preference was not changed.",
    );
}

function nativeAccountHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  if (!nativeGrokSessionAdapter(headers))
    throw new ApiError(401, "Native Grok session authentication is required.");
  return {
    authorization:
      "Bearer " + String(headers.authorization).replace(/^Bearer /i, ""),
    "X-XAI-Token-Auth": "xai-grok-cli",
    "accept-encoding": "identity",
    ...Object.fromEntries(
      [
        "x-userid",
        "x-email",
        "x-authenticateresponse",
        "x-grok-client-version",
        "x-grok-client-identifier",
        "x-grok-client-mode",
      ].flatMap((name) =>
        typeof headers[name] === "string"
          ? [[name, headers[name] as string]]
          : [],
      ),
    ),
  };
}
