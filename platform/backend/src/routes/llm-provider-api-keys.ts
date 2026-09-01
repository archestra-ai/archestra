import type { IncomingHttpHeaders } from "node:http";
import {
  builtInProviderLabel,
  credentialRequiresPerUserScope,
  integrationLabel,
  isCredentialLevelSubscriptionProvider,
  isProviderApiKeyOptional,
  isSubscriptionCredential,
  MAX_BULK_IDS,
  parseLabelsParam,
  perUserCredentialLabel,
  providerDisplayNames,
  RouteId,
  type SupportedProvider,
  SupportedProvidersSchema,
} from "@archestra/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { hasPermission, userHasPermission } from "@/auth";
import { anthropicWorkloadIdentity } from "@/clients/anthropic-workload-identity";
import { isAzureOpenAiEntraIdEnabled } from "@/clients/azure-openai-credentials";
import {
  type BedrockSigV4Credentials,
  encodeBedrockSigV4Marker,
} from "@/clients/bedrock-credentials";
import { isVertexAiEnabled } from "@/clients/gemini-client";
import { getProviderConfiguredBaseUrl } from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import {
  LlmOauthClientModel,
  LlmProviderApiKeyLabelModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
  TeamModel,
  VirtualApiKeyModel,
} from "@/models";
import SecretModel from "@/models/secret";
import { testProviderApiKey } from "@/routes/chat/model-fetchers/registry";
import {
  assertByosEnabled,
  getSecretValueForLlmProviderApiKey,
  isByosEnabled,
  secretManager,
} from "@/secrets-manager";
import { assertModelProviderAllowed } from "@/services/integration-overrides";
import { modelSyncService } from "@/services/model-sync";
import { withLatestRotatedRefreshToken } from "@/services/subscription-credential-rotation";
import {
  ApiError,
  constructResponseSchema,
  type LlmProviderApiKey,
  LlmProviderApiKeyWithScopeInfoSchema,
  type ResourceVisibilityScope,
  ResourceVisibilityScopeSchema,
  SelectLlmProviderApiKeySchema,
  type SelectSecret,
} from "@/types";
import { isUniqueConstraintError } from "@/utils/db";
import {
  dockerLocalhostConnectionHint,
  isConnectionFailureMessage,
} from "@/utils/docker-localhost-hint";
import { BulkOutcomeSchema, runBulk } from "./bulk-route";
import { registerEntityLabelRoutes } from "./entity-labels";

const BulkDeleteLlmProviderApiKeysBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(MAX_BULK_IDS),
});

async function testApiKeyOrThrow(params: {
  provider: SupportedProvider;
  apiKey: string;
  baseUrl?: string | null;
  extraHeaders?: Record<string, string> | null;
  /** Existing key row the credential belongs to, when re-testing a stored key. */
  providerApiKeyId?: string;
  /** Resolves the organization's own name for the provider, on failure only. */
  organizationId: string;
}): Promise<void> {
  const {
    provider,
    apiKey,
    baseUrl,
    extraHeaders,
    providerApiKeyId,
    organizationId,
  } = params;
  try {
    await testProviderApiKey({
      provider,
      apiKey,
      baseUrl,
      extraHeaders,
      providerApiKeyId,
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    // The model fetchers name the provider as it ships ("Failed to fetch
    // OpenAI models: 401") — right for the log they also write, wrong for a
    // user in an organization that renamed it. Drop their noun here and let
    // this message carry exactly one name: the organization's own.
    //
    // Classification stays on the raw text: it keys off the fetchers' own
    // `: <status>` ending, which the rewrite deliberately removes.
    const message = stripFetcherProviderNoun(rawMessage);
    // Name the URL actually tested: a base-URL override (user- or
    // env-configured, e.g. the e2e WireMock) silently redirects validation
    // away from the real provider, and the message is the only place that
    // misconfiguration can surface.
    const testedUrl = effectiveBaseUrlForHint(provider, baseUrl);
    const providerName = await resolveProviderLabel({
      organizationId,
      provider,
    });
    const providerLabel = testedUrl
      ? `${providerName} (${testedUrl})`
      : providerName;
    // A connection failure means the key was never checked — surface it as a
    // network problem, not a credentials problem.
    if (isConnectionFailureMessage(rawMessage)) {
      const hint = dockerLocalhostConnectionHint({
        baseUrl: testedUrl,
        errorMessage: message,
      });
      throw new ApiError(
        400,
        `Could not reach ${providerLabel} to validate the API key: ${message}. Check the server's outbound network connectivity.${hint ? ` ${hint}` : ""}`,
      );
    }
    const providerSideSuffix = providerSideErrorSuffix(rawMessage);
    if (providerSideSuffix) {
      throw new ApiError(
        400,
        `${providerLabel} returned an error while validating the API key: ${message}. ${providerSideSuffix}`,
      );
    }
    throw new ApiError(400, `Invalid API key: ${message}`);
  }
}

/**
 * The organization's own name for a provider, for a message a user reads.
 * Resolved lazily on the failure path, so the happy path pays nothing.
 */
async function resolveProviderLabel(params: {
  organizationId: string;
  provider: SupportedProvider;
}): Promise<string> {
  const { modelProviderOverrides } =
    await OrganizationModel.getIntegrationOverrides(params.organizationId);
  return integrationLabel(
    modelProviderOverrides,
    params.provider,
    builtInProviderLabel(params.provider),
  );
}

/**
 * Drops the provider noun the model fetchers put in their message, leaving the
 * status behind: `Failed to fetch OpenAI models: 401` → `HTTP 401`. The
 * fetchers share that string with the log line they write, where the shipped
 * name is the right one; only the user-facing copy needs it gone.
 */
function stripFetcherProviderNoun(message: string): string {
  return message.replace(/^Failed to fetch .*?: (\d{3})$/, "HTTP $1");
}

/**
 * Classifies a failure where the tested endpoint responded but the credential
 * wasn't the problem, returning the guidance to append (null = treat as a
 * rejected credential). Model fetchers throw `Failed to fetch <provider>
 * models: <status>` for non-2xx responses; 400/401/403 on a plain models-list
 * read means the credential was rejected (Gemini uses 400 for invalid keys).
 * A 404 or a non-JSON body means the URL isn't the provider's API; other
 * statuses — 429, 5xx — are provider-side trouble.
 */
function providerSideErrorSuffix(message: string): string | null {
  const status = message.match(/: (\d{3})$/)?.[1];
  if (status === "404" || /not valid JSON|Unexpected token/i.test(message)) {
    return "The endpoint does not look like the provider's API — if a custom base URL is configured, verify it.";
  }
  if (status && !["400", "401", "403"].includes(status)) {
    return "This may be a temporary provider issue (e.g. rate limiting or an outage).";
  }
  return null;
}

/**
 * Verifies connectivity for optional-key providers (Ollama, vLLM) when no API
 * key was supplied. Unlike {@link testApiKeyOrThrow}, an empty model list is
 * treated as success: the server is reachable, the user simply hasn't pulled
 * any models yet, so we shouldn't block key creation. Genuine connection
 * failures still throw — with a Docker localhost hint when applicable.
 */
async function testKeylessConnectivityOrThrow(
  provider: SupportedProvider,
  baseUrl?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<void> {
  try {
    await testProviderApiKey({ provider, apiKey: "", baseUrl, extraHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Models list is empty")) return;
    const hint = dockerLocalhostConnectionHint({
      baseUrl: effectiveBaseUrlForHint(provider, baseUrl),
      errorMessage: message,
    });
    throw new ApiError(
      400,
      `Failed to connect to ${providerDisplayNames[provider]}: ${message}${hint ? ` ${hint}` : ""}`,
    );
  }
}

/**
 * The base URL connectivity is actually tested against: an explicit override if
 * present, otherwise the provider's configured default. Needed so validation
 * errors name the URL they hit and so the Docker hint fires when a key is
 * created with no Base URL but a loopback default (e.g. Ollama).
 */
function effectiveBaseUrlForHint(
  provider: SupportedProvider,
  baseUrl: string | null | undefined,
): string | null {
  if (baseUrl) return baseUrl;
  return getProviderConfiguredBaseUrl(provider) ?? null;
}

async function testKeylessAzureEntraOrThrow(
  context: "discovery" | "runtime",
  baseUrl?: string | null,
  extraHeaders?: Record<string, string> | null,
): Promise<void> {
  try {
    await testProviderApiKey({
      provider: "azure",
      apiKey: "",
      baseUrl,
      extraHeaders,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const contextMessage =
      context === "discovery"
        ? `${archestraMcpBranding.appName} could not discover any Azure model deployments. Confirm the Base URL points to an Azure OpenAI resource or Foundry v1 endpoint, and that the Azure identity has permission to read deployments on that resource.`
        : `${archestraMcpBranding.appName} could not connect to the Azure inference endpoint. Confirm the Inference URL is reachable and the Azure identity can use models on that endpoint.`;
    const validationLabel =
      context === "discovery"
        ? "Azure Entra ID validation"
        : "Azure Entra ID runtime validation";
    throw new ApiError(
      400,
      `${validationLabel} failed: ${contextMessage} Provider error: ${errorMessage}`,
    );
  }
}

function resolveRuntimeTestBaseUrl(params: {
  body: {
    baseUrl?: string | null;
    inferenceBaseUrl?: string | null;
  };
  apiKey: Pick<LlmProviderApiKey, "baseUrl" | "inferenceBaseUrl">;
}): string | null {
  const { body, apiKey } = params;
  const effectiveInferenceBaseUrl =
    body.inferenceBaseUrl !== undefined
      ? body.inferenceBaseUrl
      : apiKey.inferenceBaseUrl;
  const effectiveBaseUrl =
    body.baseUrl !== undefined ? body.baseUrl : apiKey.baseUrl;
  return effectiveInferenceBaseUrl ?? effectiveBaseUrl;
}

const llmProviderApiKeyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  registerEntityLabelRoutes(fastify, {
    basePath: "/api/llm-provider-api-keys",
    tag: "LLM Provider API Keys",
    entityNamePlural: "model provider API keys",
    model: LlmProviderApiKeyLabelModel,
    keysOperationId: RouteId.GetLlmProviderApiKeyLabelKeys,
    valuesOperationId: RouteId.GetLlmProviderApiKeyLabelValues,
  });

  // List all visible LLM provider API keys for the user
  fastify.get(
    "/api/llm-provider-api-keys",
    {
      schema: {
        operationId: RouteId.GetLlmProviderApiKeys,
        description:
          "Get all LLM provider API keys visible to the current user based on scope access",
        tags: ["LLM Provider API Keys"],
        querystring: z.object({
          search: z.string().trim().min(1).optional(),
          provider: SupportedProvidersSchema.optional(),
          labels: z
            .string()
            .optional()
            .describe(
              "Filter by labels. Format: key1:val1|val2;key2:val3. AND across keys, OR within values.",
            ),
        }),
        response: constructResponseSchema(
          z.array(LlmProviderApiKeyWithScopeInfoSchema),
        ),
      },
    },
    async ({ organizationId, user, query }, reply) => {
      // Get user's team IDs
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);

      const isLlmProviderApiKeyAdmin = await userHasPermission(
        user.id,
        organizationId,
        "llmProviderApiKey",
        "admin",
      );

      const apiKeys = await LlmProviderApiKeyModel.getVisibleKeys(
        organizationId,
        user.id,
        userTeamIds,
        isLlmProviderApiKeyAdmin,
        {
          search: query.search,
          provider: query.provider,
          labels: parseLabelsParam(query.labels),
        },
        { includeSubscriptionInfo: true },
      );
      return reply.send(apiKeys);
    },
  );

  // Get available API keys for LLM-powered features
  fastify.get(
    "/api/llm-provider-api-keys/available",
    {
      schema: {
        operationId: RouteId.GetAvailableLlmProviderApiKeys,
        description:
          "Get LLM provider API keys available for the current user to use",
        tags: ["LLM Provider API Keys"],
        querystring: z.object({
          provider: SupportedProvidersSchema.optional(),
          /** Include a specific key by ID even if user doesn't have direct access (e.g. agent's configured key) */
          includeKeyId: z.string().uuid().optional(),
        }),
        response: constructResponseSchema(
          z.array(LlmProviderApiKeyWithScopeInfoSchema),
        ),
      },
    },
    async ({ organizationId, user, query }, reply) => {
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);

      const apiKeys = await LlmProviderApiKeyModel.getAvailableKeysForUser(
        organizationId,
        user.id,
        userTeamIds,
        query.provider,
        { includeSubscriptionInfo: true },
      );

      // If includeKeyId is provided and not already in results, fetch it separately.
      // Subscription metadata rides along so the chat/agent preflight can tell
      // that the pinned key is somebody's personal subscription (and which one)
      // even though the viewer can't list the key itself.
      if (
        query.includeKeyId &&
        !apiKeys.some((k) => k.id === query.includeKeyId)
      ) {
        // Check organization membership before resolving secret-derived
        // subscription metadata for an agent-pinned key.
        const storedAgentKey = await LlmProviderApiKeyModel.findById(
          query.includeKeyId,
        );
        const agentKey =
          storedAgentKey?.organizationId === organizationId
            ? await LlmProviderApiKeyModel.findByIdWithSubscriptionInfo(
                storedAgentKey.id,
              )
            : null;
        if (agentKey) {
          apiKeys.push({
            ...agentKey,
            teamName: null,
            userName: null,
            isAgentKey: true,
          });
        }
      }

      const bestModelsByApiKeyId =
        await LlmProviderApiKeyModelLinkModel.getBestModelsForApiKeys(
          apiKeys.map((key) => key.id),
        );

      const apiKeysWithBestModel = apiKeys.map((key) => ({
        ...key,
        bestModelId: bestModelsByApiKeyId.get(key.id)?.id ?? null,
      }));

      return reply.send(apiKeysWithBestModel);
    },
  );

  // Create a new LLM provider API key
  fastify.post(
    "/api/llm-provider-api-keys",
    {
      schema: {
        operationId: RouteId.CreateLlmProviderApiKey,
        description:
          "Create a new LLM provider API key with specified visibility",
        tags: ["LLM Provider API Keys"],
        body: z
          .object({
            name: z.string().min(1, "Name is required"),
            provider: SupportedProvidersSchema,
            apiKey: z.string().min(1).optional(),
            baseUrl: z.string().url().nullable().optional(),
            inferenceBaseUrl: z.string().url().nullable().optional(),
            extraHeaders: z
              .record(z.string(), z.string())
              .nullable()
              .optional(),
            scope: ResourceVisibilityScopeSchema.default("personal"),
            teamId: z.string().optional(),
            isPrimary: z.boolean().optional(),
            vaultSecretPath: z.string().min(1).optional(),
            vaultSecretKey: z.string().min(1).optional(),
            /** Bedrock-only: AWS access key ID for SigV4 auth */
            awsAccessKeyId: z.string().min(1).optional(),
            /** Bedrock-only: AWS secret access key for SigV4 auth */
            awsSecretAccessKey: z.string().min(1).optional(),
            /** Bedrock-only: optional AWS session token for STS/temporary creds */
            awsSessionToken: z.string().min(1).optional(),
          })
          .refine(
            (data) => {
              const hasSigV4 = data.awsAccessKeyId && data.awsSecretAccessKey;
              if (hasSigV4) return data.provider === "bedrock";
              if (isByosEnabled()) {
                return data.vaultSecretPath && data.vaultSecretKey;
              }
              return (
                isProviderApiKeyOptional({
                  provider: data.provider,
                  azureEntraIdEnabled: isAzureOpenAiEntraIdEnabled(),
                  anthropicWifEnabled: anthropicWorkloadIdentity.isEnabled(),
                }) || data.apiKey
              );
            },
            {
              message:
                "Either apiKey, both vaultSecretPath and vaultSecretKey, or AWS SigV4 credentials (Bedrock only) must be provided",
            },
          ),
        response: constructResponseSchema(SelectLlmProviderApiKeySchema),
      },
    },
    async ({ body, organizationId, user, headers }, reply) => {
      // Prevent creating Gemini API keys when Vertex AI is enabled
      validateProviderAllowed(body.provider);
      // …and providers the organization's admins switched off entirely.
      await assertModelProviderAllowed({
        organizationId,
        provider: body.provider,
      });

      // Validate scope/teamId combination and authorization
      await validateScopeAndAuthorization({
        scope: body.scope,
        teamId: body.teamId,
        userId: user.id,
        organizationId,
        provider: body.provider,
        apiKey: body.apiKey,
        headers,
      });

      // Personal-scoped keys are self-service: any authenticated user can
      // connect their own account / create a key only they can use (this is
      // what lets "basic users" link GitHub Copilot without elevated rights).
      // Shareable scopes (team, org) still require the create permission — org
      // additionally requires llmProviderApiKey:admin, enforced above.
      if (body.scope !== "personal") {
        const canCreateSharedKeys = await userHasPermission(
          user.id,
          organizationId,
          "llmProviderApiKey",
          "create",
        );
        if (!canCreateSharedKeys) {
          throw new ApiError(
            403,
            "You need the llmProviderApiKey:create permission to create team- or organization-scoped keys.",
          );
        }
      }

      let secret: SelectSecret | null = null;
      let actualApiKeyValue: string | null = null;
      const runtimeTestBaseUrl = body.inferenceBaseUrl ?? body.baseUrl;

      // Bedrock SigV4: store credentials as JSON in the secret payload, then
      // test using the marker-encoded form.
      if (body.awsAccessKeyId && body.awsSecretAccessKey) {
        if (body.provider !== "bedrock") {
          throw new ApiError(
            400,
            "AWS SigV4 credentials are only supported for the Bedrock provider",
          );
        }
        const sigV4: BedrockSigV4Credentials = {
          accessKeyId: body.awsAccessKeyId,
          secretAccessKey: body.awsSecretAccessKey,
          sessionToken: body.awsSessionToken,
        };
        actualApiKeyValue = encodeBedrockSigV4Marker(sigV4);
        await testApiKeyOrThrow({
          organizationId,
          provider: body.provider,
          apiKey: actualApiKeyValue,
          baseUrl: runtimeTestBaseUrl,
          extraHeaders: body.extraHeaders,
        });
        secret = await secretManager().createSecret(
          {
            accessKeyId: sigV4.accessKeyId,
            secretAccessKey: sigV4.secretAccessKey,
            ...(sigV4.sessionToken ? { sessionToken: sigV4.sessionToken } : {}),
          },
          getChatApiKeySecretName({
            scope: body.scope,
            teamId: body.teamId ?? null,
            userId: user.id,
          }),
        );
      } else if (isByosEnabled()) {
        if (!body.vaultSecretPath || !body.vaultSecretKey) {
          throw new ApiError(400, "Vault secret path and key are required");
        }
        const vaultReference = `${body.vaultSecretPath}#${body.vaultSecretKey}`;
        // first, get secret from vault path and key
        const manager = assertByosEnabled();
        const vaultData = await manager.getSecretFromPath(body.vaultSecretPath);
        actualApiKeyValue = vaultData[body.vaultSecretKey];

        if (!actualApiKeyValue) {
          throw new ApiError(
            400,
            `API key not found in Vault secret at path "${body.vaultSecretPath}" with key "${body.vaultSecretKey}"`,
          );
        }
        // then test the API key
        await testApiKeyOrThrow({
          organizationId,
          provider: body.provider,
          apiKey: actualApiKeyValue,
          baseUrl: runtimeTestBaseUrl,
          extraHeaders: body.extraHeaders,
        });
        // then create the secret
        secret = await secretManager().createSecret(
          { apiKey: vaultReference },
          getChatApiKeySecretName({
            scope: body.scope,
            teamId: body.teamId ?? null,
            userId: user.id,
          }),
        );
      } else if (body.apiKey) {
        // When readonly_vault is disabled
        actualApiKeyValue = body.apiKey;
        // Test the API key before saving
        await testApiKeyOrThrow({
          organizationId,
          provider: body.provider,
          apiKey: actualApiKeyValue,
          baseUrl: runtimeTestBaseUrl,
          extraHeaders: body.extraHeaders,
        });

        // Validating a subscription credential redeems its refresh token, and
        // the issuer may rotate it — invalidating the submitted one. Persist
        // the newest token or the stored credential is dead on arrival and the
        // first chat request demands a reconnect.
        actualApiKeyValue = withLatestRotatedRefreshToken(actualApiKeyValue);

        secret = await secretManager().createSecret(
          { apiKey: actualApiKeyValue },
          getChatApiKeySecretName({
            scope: body.scope,
            teamId: body.teamId ?? null,
            userId: user.id,
          }),
        );
      }

      if (
        body.provider === "azure" &&
        !actualApiKeyValue &&
        isAzureOpenAiEntraIdEnabled()
      ) {
        await testKeylessAzureEntraOrThrow(
          "discovery",
          body.baseUrl,
          body.extraHeaders,
        );
        if (body.inferenceBaseUrl && body.inferenceBaseUrl !== body.baseUrl) {
          await testKeylessAzureEntraOrThrow(
            "runtime",
            body.inferenceBaseUrl,
            body.extraHeaders,
          );
        }
      } else if (
        body.provider === "anthropic" &&
        !actualApiKeyValue &&
        anthropicWorkloadIdentity.isEnabled()
      ) {
        // Keyless Anthropic key backed by Workload Identity Federation —
        // exercises the token exchange and model listing end to end.
        await testApiKeyOrThrow({
          organizationId,
          provider: body.provider,
          apiKey: "",
          baseUrl: runtimeTestBaseUrl,
          extraHeaders: body.extraHeaders,
        });
      } else if (
        !actualApiKeyValue &&
        isProviderApiKeyOptional({
          provider: body.provider,
          // azure is handled by the keyless Entra branch above; only the
          // always-optional self-hosted providers (Ollama, vLLM) fall here.
          azureEntraIdEnabled: false,
        })
      ) {
        // No API key for a self-hosted provider — still verify connectivity so
        // connection errors (e.g. the Docker localhost trap) surface with a
        // helpful hint instead of silently creating an unusable key.
        await testKeylessConnectivityOrThrow(
          body.provider,
          runtimeTestBaseUrl,
          body.extraHeaders,
        );
      }

      if (
        !secret &&
        !isProviderApiKeyOptional({
          provider: body.provider,
          azureEntraIdEnabled: isAzureOpenAiEntraIdEnabled(),
          anthropicWifEnabled: anthropicWorkloadIdentity.isEnabled(),
        })
      ) {
        throw new ApiError(
          400,
          "Secret creation failed, cannot create API key",
        );
      }

      // Create the API key record. The model demotes the current primary in
      // the same transaction; a unique violation here means a concurrent
      // writer won the race — surface it as a conflict, not a 500.
      let createdApiKey: Awaited<
        ReturnType<typeof LlmProviderApiKeyModel.create>
      >;
      try {
        createdApiKey = await LlmProviderApiKeyModel.create({
          organizationId,
          name: body.name,
          provider: body.provider,
          secretId: secret?.id ?? null,
          baseUrl: body.baseUrl ?? null,
          inferenceBaseUrl: body.inferenceBaseUrl ?? null,
          extraHeaders: body.extraHeaders ?? null,
          scope: body.scope,
          userId: body.scope === "personal" ? user.id : null,
          teamId: body.scope === "team" ? body.teamId : null,
          isPrimary: body.isPrimary ?? false,
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ApiError(
            409,
            "Another primary key for this provider and scope was set concurrently. Please retry.",
          );
        }
        throw error;
      }

      // Sync models for the new API key before returning so the frontend
      // can immediately show available models after creation.
      // For optional-key providers (Ollama, vLLM), sync even without an API key value.
      const canSync =
        actualApiKeyValue ||
        isProviderApiKeyOptional({
          provider: body.provider,
          azureEntraIdEnabled: isAzureOpenAiEntraIdEnabled(),
          anthropicWifEnabled: anthropicWorkloadIdentity.isEnabled(),
        });
      if (canSync) {
        try {
          await modelSyncService.syncModelsForApiKey({
            apiKeyId: createdApiKey.id,
            provider: body.provider,
            apiKeyValue: actualApiKeyValue ?? "",
            // Model sync uses the discovery endpoint; runtime calls use inferenceBaseUrl.
            baseUrl: body.baseUrl,
            extraHeaders: body.extraHeaders ?? null,
          });
        } catch (error) {
          // Model sync failure shouldn't block API key creation
          logger.error(
            {
              apiKeyId: createdApiKey.id,
              provider: body.provider,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            },
            "Failed to sync models for new API key",
          );
        }

        try {
          await modelSyncService.maybeAutoSetOrgDefaultModel({
            organizationId,
            apiKeyId: createdApiKey.id,
            provider: body.provider,
          });
        } catch (error) {
          // Auto-default selection is best-effort; never block key creation.
          logger.error(
            {
              apiKeyId: createdApiKey.id,
              provider: body.provider,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            },
            "Failed to auto-select org default model for new API key",
          );
        }
      }

      return reply.send(createdApiKey);
    },
  );

  // Get a single LLM provider API key
  fastify.get(
    "/api/llm-provider-api-keys/:id",
    {
      schema: {
        operationId: RouteId.GetLlmProviderApiKey,
        description: "Get a specific LLM provider API key",
        tags: ["LLM Provider API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(LlmProviderApiKeyWithScopeInfoSchema),
      },
    },
    async ({ params, organizationId, user }, reply) => {
      // Subscription metadata included: the edit dialog's URL-param path
      // resolves a single key through this route and needs the derived kind to
      // reopen a subscription key on its connected card rather than the
      // API-key tab.
      const storedApiKey = await LlmProviderApiKeyModel.findById(params.id);

      if (!storedApiKey || storedApiKey.organizationId !== organizationId) {
        throw new ApiError(404, "LLM provider API key not found");
      }

      // Check visibility based on scope
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      const isLlmProviderApiKeyAdmin = await userHasPermission(
        user.id,
        organizationId,
        "llmProviderApiKey",
        "admin",
      );

      // Personal keys: only visible to owner
      if (
        storedApiKey.scope === "personal" &&
        storedApiKey.userId !== user.id
      ) {
        throw new ApiError(404, "LLM provider API key not found");
      }

      // Team keys: visible to team members or admins
      if (storedApiKey.scope === "team" && !isLlmProviderApiKeyAdmin) {
        if (
          !storedApiKey.teamId ||
          !userTeamIds.includes(storedApiKey.teamId)
        ) {
          throw new ApiError(404, "LLM provider API key not found");
        }
      }

      // Resolve Vault-backed subscription metadata only after organization and
      // scope authorization. The edit dialog needs it, but an unauthorized ID
      // must never trigger a privileged external secret-store read.
      const apiKey = await LlmProviderApiKeyModel.findByIdWithSubscriptionInfo(
        storedApiKey.id,
      );
      if (!apiKey) {
        throw new ApiError(404, "LLM provider API key not found");
      }

      return reply.send(apiKey);
    },
  );

  // Update an LLM provider API key
  fastify.patch(
    "/api/llm-provider-api-keys/:id",
    {
      schema: {
        operationId: RouteId.UpdateLlmProviderApiKey,
        description:
          "Update an LLM provider API key (name, API key value, visibility, or team)",
        tags: ["LLM Provider API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        body: z
          .object({
            name: z.string().min(1).optional(),
            apiKey: z.string().min(1).optional(),
            baseUrl: z.string().url().nullable().optional(),
            inferenceBaseUrl: z.string().url().nullable().optional(),
            extraHeaders: z
              .record(z.string(), z.string())
              .nullable()
              .optional(),
            scope: ResourceVisibilityScopeSchema.optional(),
            teamId: z.string().uuid().nullable().optional(),
            isPrimary: z.boolean().optional(),
            vaultSecretPath: z.string().min(1).optional(),
            vaultSecretKey: z.string().min(1).optional(),
            /** Bedrock-only: AWS access key ID for SigV4 auth */
            awsAccessKeyId: z.string().min(1).optional(),
            /** Bedrock-only: AWS secret access key for SigV4 auth */
            awsSecretAccessKey: z.string().min(1).optional(),
            /** Bedrock-only: optional AWS session token for STS/temporary creds */
            awsSessionToken: z.string().min(1).optional(),
          })
          .refine(
            (data) => {
              const hasSigV4 = data.awsAccessKeyId && data.awsSecretAccessKey;
              if (hasSigV4) return true;
              // If no key-related fields are provided, that's fine (updating other fields)
              if (
                !data.apiKey &&
                !data.vaultSecretPath &&
                !data.vaultSecretKey
              ) {
                return true;
              }
              // If apiKey is provided, that's always valid
              if (data.apiKey) {
                return true;
              }
              // If BYOS is enabled and vault fields are provided, both must be present
              if (isByosEnabled()) {
                return data.vaultSecretPath && data.vaultSecretKey;
              }
              return false;
            },
            {
              message:
                "Either apiKey, both vaultSecretPath and vaultSecretKey, or AWS SigV4 credentials must be provided",
            },
          ),
        response: constructResponseSchema(SelectLlmProviderApiKeySchema),
      },
    },
    async ({ params, body, organizationId, user, headers }, reply) => {
      const apiKeyFromDB = await LlmProviderApiKeyModel.findById(params.id);

      if (!apiKeyFromDB || apiKeyFromDB.organizationId !== organizationId) {
        throw new ApiError(404, "LLM provider API key not found");
      }

      // Check authorization based on current scope
      await authorizeApiKeyAccess({
        apiKey: apiKeyFromDB,
        userId: user.id,
        organizationId,
        headers,
      });

      // A key for a provider the admins switched off is frozen: it can be
      // deleted, but not renamed, rescoped, or rotated back into service.
      await assertModelProviderAllowed({
        organizationId,
        provider: apiKeyFromDB.provider,
      });

      // If scope is changing, validate the new scope
      const newScope = body.scope ?? apiKeyFromDB.scope;
      const newTeamId =
        body.teamId !== undefined ? body.teamId : apiKeyFromDB.teamId;
      let newSecretId: string | null = null;

      if (body.scope !== undefined || body.teamId !== undefined) {
        // A scope change on an existing ChatGPT-subscription (Codex) key must be
        // rejected too, so classify by the effective secret (new or stored).
        const effectiveApiKey =
          body.apiKey ??
          (apiKeyFromDB.secretId
            ? ((await getSecretValueForLlmProviderApiKey(
                apiKeyFromDB.secretId,
              )) as string | undefined)
            : undefined);
        await validateScopeAndAuthorization({
          scope: newScope,
          teamId: newTeamId,
          userId: user.id,
          organizationId,
          provider: apiKeyFromDB.provider,
          apiKey: effectiveApiKey,
          headers,
        });
      } else if (body.apiKey) {
        // A new secret value alone can flip an existing shared key into a
        // per-user credential (pasting an encoded ChatGPT-subscription
        // credential into a team/org key would share one person's account
        // with everyone), so classify the new value even when scope/team
        // don't change.
        assertPerUserCredentialScope({
          provider: apiKeyFromDB.provider,
          apiKey: body.apiKey,
          scope: newScope,
        });
      }

      const sigV4FromBody =
        body.awsAccessKeyId && body.awsSecretAccessKey
          ? {
              accessKeyId: body.awsAccessKeyId,
              secretAccessKey: body.awsSecretAccessKey,
              sessionToken: body.awsSessionToken,
            }
          : null;
      const hasSigV4Update = sigV4FromBody !== null;
      if (hasSigV4Update && apiKeyFromDB.provider !== "bedrock") {
        throw new ApiError(
          400,
          "AWS SigV4 credentials are only supported for the Bedrock provider",
        );
      }

      // Update the secret if a new API key is provided (via direct value, vault reference, or SigV4 credentials)
      if (
        body.apiKey ||
        (body.vaultSecretPath && body.vaultSecretKey) ||
        hasSigV4Update
      ) {
        let secretPayload: Record<string, string>;
        let testValue: string;

        if (sigV4FromBody) {
          const sigV4: BedrockSigV4Credentials = sigV4FromBody;
          secretPayload = {
            accessKeyId: sigV4.accessKeyId,
            secretAccessKey: sigV4.secretAccessKey,
            ...(sigV4.sessionToken ? { sessionToken: sigV4.sessionToken } : {}),
          };
          testValue = encodeBedrockSigV4Marker(sigV4);
        } else if (
          isByosEnabled() &&
          body.vaultSecretPath &&
          body.vaultSecretKey
        ) {
          // Get secret from vault
          const manager = assertByosEnabled();
          const vaultData = await manager.getSecretFromPath(
            body.vaultSecretPath,
          );
          const apiKeyValue = vaultData[body.vaultSecretKey];
          if (!apiKeyValue) {
            throw new ApiError(
              400,
              `API key not found in Vault secret at path "${body.vaultSecretPath}" with key "${body.vaultSecretKey}"`,
            );
          }
          const vaultReference = `${body.vaultSecretPath}#${body.vaultSecretKey}`;
          secretPayload = { apiKey: vaultReference };
          testValue = apiKeyValue;
        } else if (body.apiKey) {
          // Use direct API key value
          secretPayload = { apiKey: body.apiKey };
          testValue = body.apiKey;
        } else {
          // This shouldn't happen due to refine, but TypeScript needs this
          throw new ApiError(400, "API key or vault reference is required");
        }

        // Test the API key before saving
        // Use user-provided baseUrl/extraHeaders if present, otherwise fall
        // back to what's stored on the API key record.
        const testBaseUrl = resolveRuntimeTestBaseUrl({
          body,
          apiKey: apiKeyFromDB,
        });
        const testExtraHeaders =
          body.extraHeaders !== undefined
            ? body.extraHeaders
            : apiKeyFromDB.extraHeaders;
        await testApiKeyOrThrow({
          organizationId,
          provider: apiKeyFromDB.provider,
          apiKey: testValue,
          baseUrl: testBaseUrl,
          extraHeaders: testExtraHeaders,
        });

        // Validating a subscription credential redeems its refresh token, and
        // the issuer may rotate it — invalidating the submitted one. Persist
        // the newest token or the stored credential is dead on arrival. Only
        // the direct-value path applies: vault references and SigV4 payloads
        // are not subscription credentials.
        if (body.apiKey && secretPayload.apiKey === body.apiKey) {
          secretPayload = {
            apiKey: withLatestRotatedRefreshToken(body.apiKey),
          };
        }

        // Update or create the secret
        if (apiKeyFromDB.secretId) {
          await secretManager().updateSecret(
            apiKeyFromDB.secretId,
            secretPayload,
          );
        } else {
          const secret = await secretManager().createSecret(
            secretPayload,
            getChatApiKeySecretName({
              scope: newScope,
              teamId: newTeamId,
              userId: user.id,
            }),
          );
          newSecretId = secret.id;
        }
      } else if (
        body.baseUrl !== undefined ||
        body.inferenceBaseUrl !== undefined ||
        body.extraHeaders !== undefined
      ) {
        // If runtime connection settings are being updated without a new API key,
        // re-test using the existing API key.
        let apiKeyValue: string | undefined;

        if (apiKeyFromDB.secretId) {
          apiKeyValue = await getSecretValueForLlmProviderApiKey(
            apiKeyFromDB.secretId,
          );
        }
        const testBaseUrl = resolveRuntimeTestBaseUrl({
          body,
          apiKey: apiKeyFromDB,
        });
        const testExtraHeaders =
          body.extraHeaders !== undefined
            ? body.extraHeaders
            : apiKeyFromDB.extraHeaders;
        if (apiKeyValue) {
          // Re-testing the STORED credential: pass the row id so a rotated
          // subscription refresh token is persisted back to this key instead
          // of discarded (which would leave the stored token dead).
          await testApiKeyOrThrow({
            organizationId,
            provider: apiKeyFromDB.provider,
            apiKey: apiKeyValue,
            baseUrl: testBaseUrl,
            extraHeaders: testExtraHeaders,
            providerApiKeyId: apiKeyFromDB.id,
          });
        } else if (
          apiKeyFromDB.provider === "azure" &&
          isAzureOpenAiEntraIdEnabled()
        ) {
          await testKeylessAzureEntraOrThrow(
            "runtime",
            testBaseUrl,
            testExtraHeaders,
          );
        } else if (
          apiKeyFromDB.provider === "anthropic" &&
          anthropicWorkloadIdentity.isEnabled()
        ) {
          // Keyless Anthropic WIF key — re-test with the updated runtime settings.
          await testApiKeyOrThrow({
            organizationId,
            provider: apiKeyFromDB.provider,
            apiKey: "",
            baseUrl: testBaseUrl,
            extraHeaders: testExtraHeaders,
          });
        } else if (
          isProviderApiKeyOptional({
            provider: apiKeyFromDB.provider,
            // azure is handled above; only self-hosted Ollama/vLLM fall here.
            azureEntraIdEnabled: false,
          })
        ) {
          // Self-hosted provider with no stored key — re-test connectivity so a
          // newly-set Base URL that can't be reached (e.g. Docker localhost)
          // surfaces with a helpful hint.
          await testKeylessConnectivityOrThrow(
            apiKeyFromDB.provider,
            testBaseUrl,
            testExtraHeaders,
          );
        } else {
          throw new ApiError(
            400,
            "Cannot update Base URL, Inference URL, or extra headers without existing API key",
          );
        }
      }

      // Build update object
      const updateData: Partial<{
        name: string;
        baseUrl: string | null;
        inferenceBaseUrl: string | null;
        extraHeaders: Record<string, string> | null;
        scope: ResourceVisibilityScope;
        userId: string | null;
        teamId: string | null;
        secretId: string | null;
        isPrimary: boolean;
      }> = {};

      if (body.name) {
        updateData.name = body.name;
      }

      if (body.baseUrl !== undefined) {
        updateData.baseUrl = body.baseUrl;
      }

      if (body.inferenceBaseUrl !== undefined) {
        updateData.inferenceBaseUrl = body.inferenceBaseUrl;
      }

      if (body.extraHeaders !== undefined) {
        updateData.extraHeaders = body.extraHeaders;
      }

      if (body.isPrimary !== undefined) {
        updateData.isPrimary = body.isPrimary;
      }

      if (newSecretId) {
        updateData.secretId = newSecretId;
      }

      if (body.scope !== undefined) {
        updateData.scope = body.scope;
        // Set userId/teamId based on new scope
        updateData.userId = body.scope === "personal" ? user.id : null;
        updateData.teamId = body.scope === "team" ? newTeamId : null;
      } else if (body.teamId !== undefined && apiKeyFromDB.scope === "team") {
        // Only update teamId if scope is team and not changing
        updateData.teamId = body.teamId;
      }

      if (Object.keys(updateData).length > 0) {
        try {
          await LlmProviderApiKeyModel.update(params.id, updateData);
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new ApiError(
              409,
              "Another primary key for this provider and scope was set concurrently. Please retry.",
            );
          }
          throw error;
        }
      }

      const updated = await LlmProviderApiKeyModel.findById(params.id);
      if (!updated) {
        throw new ApiError(404, "LLM provider API key not found");
      }
      return reply.send(updated);
    },
  );

  // Reconnect (re-authenticate) the caller's own personal subscription key.
  // Self-service on purpose: connecting a subscription is self-service (the
  // create route + device flows carry no permission requirement), so RECONNECTING
  // the same credential after it expires must not suddenly demand
  // llmProviderApiKey:update — that stranded default members in a loop where
  // the sign-in completed but the rotated credential could never be saved.
  fastify.post(
    "/api/llm-provider-api-keys/:id/reconnect",
    {
      schema: {
        operationId: RouteId.ReconnectLlmProviderApiKey,
        description:
          "Re-authenticate the caller's own personal subscription key in place, rotating its stored credential",
        tags: ["LLM Provider API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        body: z.object({
          /** The fresh device-flow credential for the same subscription. */
          apiKey: z.string().min(1),
        }),
        response: constructResponseSchema(SelectLlmProviderApiKeySchema),
      },
    },
    async ({ params, body, organizationId, user }, reply) => {
      const keyRow = await LlmProviderApiKeyModel.findById(params.id);
      if (!keyRow || keyRow.organizationId !== organizationId) {
        throw new ApiError(404, "LLM provider API key not found");
      }
      // Another user's personal key is invisible (404, matching the GET route);
      // shared keys go through the regular permission-gated edit flow.
      if (keyRow.scope === "personal" && keyRow.userId !== user.id) {
        throw new ApiError(404, "LLM provider API key not found");
      }
      if (keyRow.scope !== "personal") {
        throw new ApiError(
          400,
          "Only personal subscription keys can be reconnected — shared keys use the regular edit flow.",
        );
      }
      // The new credential must be subscription material for this key's
      // provider: a per-user provider's own token (GitHub/Microsoft Copilot) or
      // a marker-encoded subscription credential (ChatGPT, X Premium). A plain
      // API key must go through the permission-gated edit flow instead.
      if (
        !credentialRequiresPerUserScope({
          provider: keyRow.provider,
          apiKey: body.apiKey,
        })
      ) {
        throw new ApiError(
          400,
          "Reconnect only accepts a subscription sign-in credential — to change an API key, use the regular edit flow.",
        );
      }
      // For providers that also take plain API keys, the ROW must already hold
      // a subscription credential — reconnect refreshes a sign-in, it does not
      // convert an API key into one. An unreadable stored secret (e.g. rotated
      // encryption key) still qualifies: recovery is exactly the point.
      if (
        isCredentialLevelSubscriptionProvider(keyRow.provider) &&
        keyRow.secretId
      ) {
        const secretRow = await SecretModel.findById(keyRow.secretId);
        if (secretRow?.isByosVault) {
          throw new ApiError(
            400,
            "This key's credential lives in your external Vault, which is read-only — update it there instead.",
          );
        }
        const storedValue = await getSecretValueForLlmProviderApiKey(
          keyRow.secretId,
        );
        if (
          storedValue !== undefined &&
          !isSubscriptionCredential(storedValue)
        ) {
          throw new ApiError(
            400,
            "This key stores a plain API key, not a subscription sign-in — use the regular edit flow.",
          );
        }
      }

      // Validate by redeeming. The manager stashes any rotation so the
      // persisted credential carries the newest refresh token.
      await testApiKeyOrThrow({
        organizationId,
        provider: keyRow.provider,
        apiKey: body.apiKey,
        baseUrl: resolveRuntimeTestBaseUrl({ body: {}, apiKey: keyRow }),
        extraHeaders: keyRow.extraHeaders,
      });
      const latestValue = withLatestRotatedRefreshToken(body.apiKey);

      if (keyRow.secretId) {
        await secretManager().updateSecret(keyRow.secretId, {
          apiKey: latestValue,
        });
      } else {
        const secret = await secretManager().createSecret(
          { apiKey: latestValue },
          getChatApiKeySecretName({
            scope: "personal",
            teamId: null,
            userId: user.id,
          }),
        );
        await LlmProviderApiKeyModel.update(keyRow.id, {
          secretId: secret.id,
        });
      }

      const updated = await LlmProviderApiKeyModel.findById(keyRow.id);
      if (!updated) {
        throw new ApiError(404, "LLM provider API key not found");
      }
      return reply.send(updated);
    },
  );

  // Delete several LLM provider API keys in one request.
  fastify.delete(
    "/api/llm-provider-api-keys/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteLlmProviderApiKeys,
        description:
          "Delete several LLM provider API keys in one request. Keys outside " +
          "the caller's organization, protected system keys, and keys that are " +
          "still in use are reported in `failed` while the remaining keys are deleted.",
        tags: ["LLM Provider API Keys"],
        body: BulkDeleteLlmProviderApiKeysBodySchema,
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId, user } = request;
      const [organization, userTeamIds, isLlmProviderApiKeyAdmin] =
        await Promise.all([
          OrganizationModel.getById(organizationId),
          TeamModel.getUserTeamIds(user.id),
          userHasPermission(
            user.id,
            organizationId,
            "llmProviderApiKey",
            "admin",
          ),
        ]);

      const outcome = await runBulk({
        ids: request.body.ids,
        logLabel: "LLM provider API keys bulk delete",
        notFoundMessage: "LLM provider API key not found",
        unexpectedMessage: "Could not delete this LLM provider API key",
        // The organization condition is part of the query, so foreign ids never
        // resolve to a row in memory or disclose their names in the outcome.
        load: async (ids) =>
          new Map(
            (
              await LlmProviderApiKeyModel.getVisibleKeys(
                organizationId,
                user.id,
                userTeamIds,
                isLlmProviderApiKeyAdmin,
                { ids },
              )
            ).map((apiKey) => [apiKey.id, apiKey]),
          ),
        describe: (apiKey) => apiKey.name,
        authorize: async (apiKey) => {
          assertApiKeyIsNotSystem(apiKey);
          await authorizeApiKeyAccess({
            apiKey,
            userId: user.id,
            organizationId,
            headers: request.headers,
          });
          await assertApiKeyCanBeDeleted({
            apiKey,
            organization,
            organizationId,
            userId: user.id,
            userTeamIds,
          });
        },
        applyEach: (apiKey) =>
          deleteProviderApiKeyAtomically({
            apiKeyId: apiKey.id,
            organizationId,
            userId: user.id,
            userTeamIds,
            headers: request.headers,
          }),
        audit: {
          target: request,
          snapshot: (ids) =>
            buildBulkApiKeyAuditSnapshot({
              ids,
              organizationId,
              userId: user.id,
              userTeamIds,
              isLlmProviderApiKeyAdmin,
            }),
        },
      });

      // Model links cascade with the keys. Sweep once after the whole batch,
      // rather than re-scanning global models after each successful row.
      if (outcome.succeeded.length > 0) {
        try {
          await cleanupOrphanedModels();
        } catch (error) {
          // The keys are already deleted and audited; cleanup must not turn a
          // completed batch into a misleading 500 response.
          logger.error(
            { error },
            "Failed to clean up orphaned models after API key bulk deletion",
          );
        }
      }
      if (outcome.succeeded.length === 0) request.auditSkip = true;

      return reply.send(outcome);
    },
  );

  // Delete an LLM provider API key
  fastify.delete(
    "/api/llm-provider-api-keys/:id",
    {
      schema: {
        operationId: RouteId.DeleteLlmProviderApiKey,
        description: "Delete an LLM provider API key",
        tags: ["LLM Provider API Keys"],
        params: z.object({
          id: z.string().uuid(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId, user, headers }, reply) => {
      const apiKey = await LlmProviderApiKeyModel.findById(params.id);

      if (!apiKey || apiKey.organizationId !== organizationId) {
        throw new ApiError(404, "LLM provider API key not found");
      }

      assertApiKeyIsNotSystem(apiKey);

      // Check authorization based on scope
      await authorizeApiKeyAccess({
        apiKey,
        userId: user.id,
        organizationId,
        headers,
      });

      const [organization, userTeamIds] = await Promise.all([
        OrganizationModel.getById(organizationId),
        TeamModel.getUserTeamIds(user.id),
      ]);
      await assertApiKeyCanBeDeleted({
        apiKey,
        organization,
        organizationId,
        userId: user.id,
        userTeamIds,
      });

      await deleteProviderApiKeyAtomically({
        apiKeyId: apiKey.id,
        organizationId,
        userId: user.id,
        userTeamIds,
        headers,
      });
      await cleanupOrphanedModels();

      return reply.send({ success: true });
    },
  );
};

/**
 * Validates scope/teamId combination and checks user authorization for the scope.
 * Used for both creating and updating API keys.
 */
async function validateScopeAndAuthorization(params: {
  scope: ResourceVisibilityScope;
  teamId: string | null | undefined;
  userId: string;
  organizationId: string;
  provider: SupportedProvider;
  apiKey?: string | null;
  headers: IncomingHttpHeaders;
}): Promise<void> {
  const { scope, teamId, userId, organizationId, provider, apiKey, headers } =
    params;

  assertPerUserCredentialScope({ provider, apiKey, scope });

  // Validate scope-specific requirements
  if (scope === "team" && !teamId) {
    throw new ApiError(400, "teamId is required for team-scoped API keys");
  }

  if (scope === "personal" && teamId) {
    throw new ApiError(
      400,
      "teamId should not be provided for personal-scoped API keys",
    );
  }

  if (scope === "org" && teamId) {
    throw new ApiError(
      400,
      "teamId should not be provided for org-wide API keys",
    );
  }

  // For team-scoped keys, verify user has access to the team
  if (scope === "team" && teamId) {
    const { success: canManageAllTeams } = await hasPermission(
      { team: ["create"] },
      headers,
    );

    if (!canManageAllTeams) {
      const isUserInTeam = await TeamModel.isUserInTeam(teamId, userId);
      if (!isUserInTeam) {
        throw new ApiError(
          403,
          "You must be a member of the team to use this scope",
        );
      }
    }
  }

  // For org-wide keys, require the dedicated API-key admin permission
  if (scope === "org") {
    const isLlmProviderApiKeyAdmin = await userHasPermission(
      userId,
      organizationId,
      "llmProviderApiKey",
      "admin",
    );
    if (!isLlmProviderApiKeyAdmin) {
      throw new ApiError(
        403,
        "Only llmProviderApiKey admins can use organization-wide scope",
      );
    }
  }
}

/**
 * Per-user credentials — GitHub/Microsoft Copilot, and a ChatGPT-subscription
 * (Codex) key on `openai` — hold an individual's token, so team/org scope
 * would share one person's credential with everyone. Only personal keys are
 * allowed; each user links their own account.
 */
function assertPerUserCredentialScope(params: {
  provider: SupportedProvider;
  apiKey: string | null | undefined;
  scope: ResourceVisibilityScope;
}): void {
  const { provider, apiKey, scope } = params;
  if (
    credentialRequiresPerUserScope({ provider, apiKey }) &&
    scope !== "personal"
  ) {
    throw new ApiError(
      400,
      `${perUserCredentialLabel({ provider, apiKey })} keys are per-user — each user connects their own account, so only the "personal" scope is allowed.`,
    );
  }
}

/**
 * Helper to check if a user is authorized to modify an API key based on scope
 */
async function authorizeApiKeyAccess(params: {
  apiKey: { scope: string; userId: string | null; teamId: string | null };
  userId: string;
  organizationId: string;
  headers: IncomingHttpHeaders;
}): Promise<void> {
  const { apiKey, userId, organizationId, headers } = params;

  // Personal keys: only owner can modify
  if (apiKey.scope === "personal") {
    if (apiKey.userId !== userId) {
      throw new ApiError(403, "You can only modify your own personal API keys");
    }
    return;
  }

  // Team keys: require team membership or organization-level team management
  if (apiKey.scope === "team") {
    const { success: canManageAllTeams } = await hasPermission(
      { team: ["create"] },
      headers,
    );

    if (!canManageAllTeams && apiKey.teamId) {
      const isUserInTeam = await TeamModel.isUserInTeam(apiKey.teamId, userId);
      if (!isUserInTeam) {
        throw new ApiError(
          403,
          "You can only modify team API keys for teams you are a member of",
        );
      }
    }
    return;
  }

  // Org-wide keys: require the dedicated API-key admin permission
  if (apiKey.scope === "org") {
    const isLlmProviderApiKeyAdmin = await userHasPermission(
      userId,
      organizationId,
      "llmProviderApiKey",
      "admin",
    );
    if (!isLlmProviderApiKeyAdmin) {
      throw new ApiError(
        403,
        "Only llmProviderApiKey admins can modify organization-wide API keys",
      );
    }
    return;
  }
}

function assertApiKeyIsNotSystem(apiKey: { isSystem: boolean }): void {
  if (apiKey.isSystem) {
    throw new ApiError(400, "System API keys cannot be deleted");
  }
}

async function assertApiKeyCanBeDeleted(params: {
  apiKey: Pick<LlmProviderApiKey, "id">;
  organization: Awaited<ReturnType<typeof OrganizationModel.getById>>;
  organizationId: string;
  userId: string;
  userTeamIds: string[];
}): Promise<void> {
  const { apiKey, organization, organizationId, userId, userTeamIds } = params;
  if (organization) {
    const usages: string[] = [];
    if (organization.embeddingChatApiKeyId === apiKey.id)
      usages.push("embedding");
    if (organization.rerankerChatApiKeyId === apiKey.id)
      usages.push("reranking");
    if (organization.ocrChatApiKeyId === apiKey.id) usages.push("OCR");
    if (usages.length > 0) {
      throw new ApiError(
        400,
        `This API key is used for knowledge base ${usages.join(" and ")}. Remove it from Settings > Knowledge before deleting.`,
      );
    }
  }

  const virtualKeys = await VirtualApiKeyModel.findByProviderApiKeyId({
    providerApiKeyId: apiKey.id,
    organizationId,
    userId,
    userTeamIds,
    isAdmin: true,
  });
  if (virtualKeys.length > 0) {
    throw new ApiError(
      400,
      "This API key is mapped to one or more virtual API keys. Remove those mappings before deleting it.",
    );
  }

  const oauthClients = await LlmOauthClientModel.findByProviderApiKeyId({
    providerApiKeyId: apiKey.id,
    organizationId,
  });
  if (oauthClients.length > 0) {
    throw new ApiError(
      400,
      "This API key is mapped to one or more OAuth clients. Remove those mappings before deleting it.",
    );
  }
}

async function deleteProviderApiKeyAtomically(params: {
  apiKeyId: string;
  organizationId: string;
  userId: string;
  userTeamIds: string[];
  headers: IncomingHttpHeaders;
}): Promise<void> {
  const deleted =
    process.env.NODE_ENV === "test"
      ? await deleteProviderApiKeyInPglite(params)
      : await db.transaction(async (tx) => {
          // OAuth-client mappings are JSON rather than a foreign key, so lock their
          // table while checking and deleting. The provider-key row lock also blocks
          // concurrent foreign-key mappings until the delete commits.
          // PGlite's test backend does not implement PostgreSQL table locks. The
          // production lock closes the JSON-mapping writer race; row/FK behavior is
          // still exercised in route tests.
          await tx.execute(
            sql`LOCK TABLE "oauth_client" IN SHARE ROW EXCLUSIVE MODE`,
          );
          const [apiKey] = await tx
            .select()
            .from(schema.llmProviderApiKeysTable)
            .where(eq(schema.llmProviderApiKeysTable.id, params.apiKeyId))
            .for("update");
          if (!apiKey || apiKey.organizationId !== params.organizationId) {
            throw new ApiError(404, "LLM provider API key not found");
          }
          const [organization] = await tx
            .select()
            .from(schema.organizationsTable)
            .where(eq(schema.organizationsTable.id, params.organizationId))
            .for("update");

          assertApiKeyIsNotSystem(apiKey);
          await authorizeApiKeyAccess({
            apiKey,
            userId: params.userId,
            organizationId: params.organizationId,
            headers: params.headers,
          });
          await assertApiKeyCanBeDeleted({
            apiKey,
            organization,
            organizationId: params.organizationId,
            userId: params.userId,
            userTeamIds: params.userTeamIds,
          });
          const [row] = await tx
            .delete(schema.llmProviderApiKeysTable)
            .where(eq(schema.llmProviderApiKeysTable.id, apiKey.id))
            .returning({ id: schema.llmProviderApiKeysTable.id });
          if (!row) throw new ApiError(404, "LLM provider API key not found");
          return apiKey;
        });

  if (!deleted.secretId) return;

  try {
    await secretManager().deleteSecret(deleted.secretId);
  } catch (error) {
    // The key row is already gone. Report the deletion honestly and leave the
    // orphaned secret for operational cleanup rather than returning a false
    // failure for a mutation that completed.
    logger.error(
      { error, providerApiKeyId: deleted.id },
      "Failed to delete secret after LLM provider API key deletion",
    );
  }
}

async function deleteProviderApiKeyInPglite(params: {
  apiKeyId: string;
  organizationId: string;
  userId: string;
  userTeamIds: string[];
  headers: IncomingHttpHeaders;
}) {
  const apiKey = await LlmProviderApiKeyModel.findById(params.apiKeyId);
  if (!apiKey || apiKey.organizationId !== params.organizationId) {
    throw new ApiError(404, "LLM provider API key not found");
  }
  assertApiKeyIsNotSystem(apiKey);
  await authorizeApiKeyAccess({
    apiKey,
    userId: params.userId,
    organizationId: params.organizationId,
    headers: params.headers,
  });
  await assertApiKeyCanBeDeleted({
    apiKey,
    organization: await OrganizationModel.getById(params.organizationId),
    organizationId: params.organizationId,
    userId: params.userId,
    userTeamIds: params.userTeamIds,
  });
  if (!(await LlmProviderApiKeyModel.delete(apiKey.id))) {
    throw new ApiError(404, "LLM provider API key not found");
  }
  return apiKey;
}

async function cleanupOrphanedModels(): Promise<void> {
  const deletedCount = await ModelModel.deleteOrphanedModels();
  if (deletedCount > 0) {
    logger.info(
      { deletedCount },
      "Cleaned up orphaned models after API key deletion",
    );
  }
}

async function buildBulkApiKeyAuditSnapshot(params: {
  ids: string[];
  organizationId: string;
  userId: string;
  userTeamIds: string[];
  isLlmProviderApiKeyAdmin: boolean;
}): Promise<Record<string, unknown>> {
  const wanted = new Set(params.ids);
  const apiKeys = await LlmProviderApiKeyModel.getVisibleKeys(
    params.organizationId,
    params.userId,
    params.userTeamIds,
    params.isLlmProviderApiKeyAdmin,
    { ids: params.ids },
  );
  return {
    llmProviderApiKeys: apiKeys
      .filter((apiKey) => wanted.has(apiKey.id))
      // Deliberately excludes secretId, header values, and every credential field.
      .map(({ id, name, provider, scope, isSystem }) => ({
        id,
        name,
        provider,
        scope,
        isSystem,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function getChatApiKeySecretName({
  scope,
  teamId,
  userId,
}: {
  scope: ResourceVisibilityScope;
  teamId: string | null;
  userId: string | null;
}): string {
  if (scope === "personal") {
    return `chatapikey-personal-${userId}`;
  }
  if (scope === "team") {
    return `chatapikey-team-${teamId}`;
  }
  return `chatapikey-org`;
}

/**
 * Validates that the provider is allowed based on current configuration.
 * Throws ApiError if Gemini provider is requested while Vertex AI is enabled.
 */
export function validateProviderAllowed(provider: SupportedProvider): void {
  if (provider === "gemini" && isVertexAiEnabled()) {
    throw new ApiError(
      400,
      "Cannot create Gemini API key: Vertex AI is configured. Gemini uses Application Default Credentials instead of API keys.",
    );
  }
}

export default llmProviderApiKeyRoutes;
