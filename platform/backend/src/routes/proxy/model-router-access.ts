import {
  credentialRequiresPerUserScope,
  isChatCompletionsOnlyRouterProvider,
  isModelRouterSupportedProvider,
  perUserCredentialLabel,
  type ResourceVisibilityScope,
  requiresOpenAiResponsesApi,
  requiresResponsesApi,
  type SupportedProvider,
} from "@archestra/shared";
import { z } from "zod";
import { isAzureOpenAiFirstPartyModelName } from "@/clients/azure-url";
import { LlmProviderApiKeyModel } from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { assertSubscriptionCredentialForProvider } from "@/services/subscription-credential-guard";
import { ApiError } from "@/types";
import { selectMappedProviderKey } from "@/utils/provider-key-mappings";
import type { ModelRouterResolution } from "./model-router-resolver";

export type ModelRouterMappedProviderKey = {
  provider: SupportedProvider;
  providerApiKeyId: string;
  providerApiKeyName: string;
  secretId: string | null;
  baseUrl: string | null;
  scope: ResourceVisibilityScope;
  userId: string | null;
};

export type ModelRouterVirtualKeyAuth = {
  authMethod: "virtual_key";
  serviceAccountId?: string;
  organizationId: string;
  virtualKeyId: string;
  virtualKeyIsPersonal: boolean;
  virtualKeyAuthorId: string | null;
  billingTeamId: string | null;
  /** In preference order; see `selectMappedProviderKey`. */
  providerApiKeys: ModelRouterMappedProviderKey[];
  oauthClient?: never;
};

export type ModelRouterOAuthClientAuth = {
  authMethod: "oauth_client_credentials";
  serviceAccountId?: string;
  organizationId: string;
  billingTeamId: string | null;
  /** In preference order; see `selectMappedProviderKey`. */
  providerApiKeys: ModelRouterMappedProviderKey[];
  /** Pools the client was granted outright. */
  modelPoolIds: string[];
  oauthClient: {
    id: string;
    name: string;
    clientId: string;
  };
};

export type ModelRouterUserOAuthAuth = {
  authMethod: "oauth_user";
  serviceAccountId?: never;
  organizationId: string;
  userId: string;
  /** In preference order; see `selectMappedProviderKey`. */
  providerApiKeys: ModelRouterMappedProviderKey[];
  oauthClient: {
    id: string;
    name: string;
    clientId: string;
  } | null;
};

export type ModelRouterAuth =
  | ModelRouterVirtualKeyAuth
  | ModelRouterOAuthClientAuth
  | ModelRouterUserOAuthAuth;

export const ModelRouterEndpointSchema = z.enum([
  "chat_completions",
  "responses",
]);
export type ModelRouterEndpoint = z.infer<typeof ModelRouterEndpointSchema>;

export type ModelRouterCredential =
  | {
      kind: "selected";
      mappedApiKey: ModelRouterMappedProviderKey;
      apiKey: string | undefined;
    }
  | { kind: "denied"; error: ApiError };

/**
 * The user a Model Router credential proves: an OAuth user, or the author of a
 * personal virtual key. Organization keys, OAuth clients and service accounts
 * identify no user.
 */
export function modelRouterAuthenticatedUserId(
  auth: ModelRouterAuth,
): string | undefined {
  switch (auth.authMethod) {
    case "oauth_user":
      return auth.userId;
    case "virtual_key":
      return auth.virtualKeyIsPersonal
        ? (auth.virtualKeyAuthorId ?? undefined)
        : undefined;
    case "oauth_client_credentials":
      return undefined;
  }
}

/** The agent a Model Router request is served by, as usage limits scope it. */
export type ModelRouterLimitAgent = {
  id: string;
  organizationId: string;
  environmentId: string | null;
};

/**
 * The identity the proxy checks usage limits for on a Model Router request,
 * matching what `applyModelRouterAuthOverride` hands the proxy.
 */
export function modelRouterLimitScope(
  auth: ModelRouterAuth,
  agent: ModelRouterLimitAgent,
) {
  return {
    agentId: agent.id,
    agent,
    userId: modelRouterAuthenticatedUserId(auth),
    virtualKeyId:
      auth.authMethod === "virtual_key" ? auth.virtualKeyId : undefined,
    llmOauthClientId: auth.oauthClient?.id,
    billingTeamId:
      auth.authMethod === "oauth_user"
        ? undefined
        : (auth.billingTeamId ?? undefined),
  };
}

/**
 * The provider credential a Model Router request for `resolution` would be
 * sent with, or why it may not be sent. Reads only.
 */
export async function selectModelRouterCredential(params: {
  auth: ModelRouterAuth;
  resolution: ModelRouterResolution;
}): Promise<ModelRouterCredential> {
  const { provider, modelId } = params.resolution;
  const mappedApiKey = await selectMappedProviderKey({
    mappings: params.auth.providerApiKeys,
    provider,
    modelId,
  });
  if (!mappedApiKey) {
    return {
      kind: "denied",
      error: new ApiError(
        400,
        `Model Router credential is not mapped to provider "${provider}".`,
      ),
    };
  }

  const apiKey = mappedApiKey.secretId
    ? await readRequestSecret(params.auth, mappedApiKey.secretId)
    : undefined;
  try {
    assertSubscriptionCredentialForProvider({ apiKey, provider });
  } catch (error) {
    if (error instanceof ApiError) return { kind: "denied", error };
    throw error;
  }

  if (
    credentialRequiresPerUserScope({ provider, apiKey }) &&
    !isOwnedPersonalCredential(params.auth, mappedApiKey)
  ) {
    return {
      kind: "denied",
      error: new ApiError(
        403,
        `${perUserCredentialLabel({ provider, apiKey })} is per-user: it can only be used through the same user's own personal credential.`,
      ),
    };
  }
  return { kind: "selected", mappedApiKey, apiKey };
}

/**
 * Every provider key `userId` may use, as Model Router mappings in preference
 * order; a request takes the first one linked to its model
 * (`selectMappedProviderKey`).
 */
export async function userProviderKeyMappings(params: {
  organizationId: string;
  userId: string;
}): Promise<ModelRouterMappedProviderKey[]> {
  const { keys } = await LlmProviderApiKeyModel.findUsableKeys(params);
  return [...keys].sort(compareModelRouterUserProviderKeys).map((apiKey) => ({
    provider: apiKey.provider,
    providerApiKeyId: apiKey.id,
    providerApiKeyName: apiKey.name,
    secretId: apiKey.secretId,
    baseUrl: apiKey.inferenceBaseUrl ?? apiKey.baseUrl,
    scope: apiKey.scope,
    userId: apiKey.userId,
  }));
}

/**
 * Provider secrets read for one request, keyed by its auth: auto routing
 * checks every tier and forwarding selects the credential again, usually all
 * with the same secret.
 */
const requestSecrets = new WeakMap<
  ModelRouterAuth,
  Map<string, Promise<string | undefined>>
>();

function readRequestSecret(
  auth: ModelRouterAuth,
  secretId: string,
): Promise<string | undefined> {
  const secrets = requestSecrets.get(auth) ?? new Map();
  requestSecrets.set(auth, secrets);
  const secret =
    secrets.get(secretId) ?? getSecretValueForLlmProviderApiKey(secretId);
  secrets.set(secretId, secret);
  return secret;
}

function isOwnedPersonalCredential(
  auth: ModelRouterAuth,
  mappedApiKey: ModelRouterMappedProviderKey,
): boolean {
  return (
    mappedApiKey.userId !== null &&
    (auth.authMethod === "oauth_user"
      ? mappedApiKey.userId === auth.userId
      : auth.authMethod === "virtual_key" &&
        auth.virtualKeyIsPersonal &&
        auth.virtualKeyAuthorId !== null &&
        mappedApiKey.userId === auth.virtualKeyAuthorId)
  );
}

export function modelRequiresResponses(
  resolution: Pick<
    ModelRouterResolution,
    "provider" | "modelId" | "supportedEndpoints"
  >,
): boolean {
  return (
    requiresResponsesApi(resolution.supportedEndpoints) ||
    (resolution.provider === "openai" &&
      requiresOpenAiResponsesApi(resolution.modelId))
  );
}

/**
 * The provider whose native Responses surface serves `resolution`, or null
 * when the router translates Responses to Chat Completions.
 *
 * OpenAI is always native. Azure deployments of OpenAI models are native too:
 * Azure Chat Completions rejects function tools combined with reasoning on
 * GPT reasoning deployments, and its Responses API answers other deployments
 * (most open models) with "Model not supported". GitHub Copilot is native for
 * its Responses-only models.
 */
export function nativeResponsesProvider(
  resolution: ModelRouterResolution,
): "openai" | "azure" | "github-copilot" | null {
  switch (true) {
    case resolution.provider === "openai":
      return "openai";
    case resolution.provider === "azure" &&
      isAzureOpenAiFirstPartyModelName(resolution.modelId):
      return "azure";
    case resolution.provider === "github-copilot" &&
      modelRequiresResponses(resolution):
      return "github-copilot";
    default:
      return null;
  }
}

/** Whether the router serves `resolution` on `endpoint` at all. */
export function modelRouterServesEndpoint(
  resolution: ModelRouterResolution,
  endpoint: ModelRouterEndpoint,
): boolean {
  if (!isModelRouterSupportedProvider(resolution.provider)) return false;
  switch (endpoint) {
    case "chat_completions":
      return !modelRequiresResponses(resolution);
    case "responses":
      return (
        nativeResponsesProvider(resolution) !== null ||
        !isChatCompletionsOnlyRouterProvider(resolution.provider)
      );
  }
}

type ModelRouterUserProviderKey = Awaited<
  ReturnType<typeof LlmProviderApiKeyModel.findUsableKeys>
>["keys"][number];

function compareModelRouterUserProviderKeys(
  left: ModelRouterUserProviderKey,
  right: ModelRouterUserProviderKey,
) {
  if (left.provider !== right.provider) {
    return left.provider.localeCompare(right.provider);
  }

  const leftScopePriority = getModelRouterUserProviderKeyScopePriority(left);
  const rightScopePriority = getModelRouterUserProviderKeyScopePriority(right);
  if (leftScopePriority !== rightScopePriority) {
    return leftScopePriority - rightScopePriority;
  }

  if (left.isPrimary !== right.isPrimary) {
    return left.isPrimary ? -1 : 1;
  }

  return left.createdAt.getTime() - right.createdAt.getTime();
}

function getModelRouterUserProviderKeyScopePriority(
  apiKey: ModelRouterUserProviderKey,
) {
  switch (apiKey.scope) {
    case "personal":
      return 0;
    case "team":
      return 1;
    case "org":
      return 2;
    default:
      return 3;
  }
}
