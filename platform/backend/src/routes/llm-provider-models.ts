import {
  EmbeddingDimensionsSchema,
  hasScopedPermission,
  isFreeModel,
  providerRequiresPerUserCredential,
  ResourceAccessQuerySchema,
  ResourceSharedWithQuerySchema,
  RouteId,
  type SupportedProvider,
  SupportedProviders,
  SupportedProvidersSchema,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import { getEmbeddingClientInputModalities } from "@/knowledge-base/embedding-clients";
import logger from "@/logging";
import {
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  ModelLabelModel,
  ModelModel,
  ModelTeamModel,
  ModelUserModel,
  OrganizationModel,
  TeamModel,
} from "@/models";
import ResourcePermissionSubjectModel from "@/models/resource-permission-subject";
import { classifyAzureModelCapabilities } from "@/services/azure-model-capabilities";
import { withDistinctDisplayNames } from "@/services/model-sync";
import { syncModelsForVisibleApiKeys } from "@/services/model-sync-schedule";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  ApiError,
  constructResponseSchema,
  type LabelWithDetails,
  type LinkedApiKey,
  LlmModelOptionSchema,
  type Model,
  ModelCapabilitiesSchema,
  type ModelTeamDetail,
  ModelWithApiKeysSchema,
  PatchModelBodySchema,
  SelectModelSchema,
  UuidIdSchema,
} from "@/types";
import { BulkIdsSchema, BulkOutcomeSchema, runBulk } from "./bulk-route";
import { registerEntityLabelRoutes } from "./entity-labels";

export const LlmModelSchema = z.object({
  id: z.string(),
  /** The models.id UUID — used as the model_id FK on conversations/agents. */
  dbId: z.string(),
  displayName: z.string(),
  provider: SupportedProvidersSchema,
  createdAt: z.string().optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  isBest: z.boolean().optional(),
  /** True when the provider charges nothing for this model (both prices are zero). */
  isFree: z.boolean(),
  embeddingDimensions: EmbeddingDimensionsSchema.nullable().optional(),
  /**
   * True for models from a per-user provider (e.g. GitHub Copilot), whose
   * credential each member supplies via their own account. The model is
   * selectable by anyone, but using it requires the acting user to have
   * connected — see `isConnected`.
   */
  requiresUserConnection: z.boolean().optional(),
  /**
   * For `requiresUserConnection` models: whether the requesting user has linked
   * their own account. When false, the model is offered but the UI should prompt
   * the user to connect (and a send surfaces the connect flow).
   */
  isConnected: z.boolean().optional(),
});

const ModelSyncFailureSchema = z.object({
  apiKeyId: z.string(),
  name: z.string(),
  provider: SupportedProvidersSchema,
  requiresReauthentication: z.boolean(),
});

const llmModelsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  registerEntityLabelRoutes(fastify, {
    basePath: "/api/llm-provider-models",
    tag: "LLM Models",
    entityNamePlural: "models",
    model: ModelLabelModel,
    keysOperationId: RouteId.GetLlmProviderModelLabelKeys,
    valuesOperationId: RouteId.GetLlmProviderModelLabelValues,
  });

  fastify.get(
    "/api/llm-models/available",
    {
      schema: {
        operationId: RouteId.GetLlmModels,
        description:
          "Get available LLM models from configured provider API keys. Models are fetched from the provider-backed catalog and include capabilities when available.",
        tags: ["LLM Models"],
        querystring: z.object({
          provider: SupportedProvidersSchema.optional(),
          apiKeyId: z.string().uuid().optional(),
          isEmbedding: z
            .string()
            .transform((v) => v === "true")
            .optional(),
        }),
        response: constructResponseSchema(z.array(LlmModelSchema)),
      },
    },
    async ({ query, organizationId, user }, reply) => {
      return reply.send(
        await getAvailableLlmModels({ query, userId: user.id, organizationId }),
      );
    },
  );

  fastify.post(
    "/api/llm-models/sync",
    {
      schema: {
        operationId: RouteId.SyncLlmModels,
        description:
          "Sync models from providers for all visible API keys and store them in the database",
        tags: ["LLM Models"],
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            failures: z.array(ModelSyncFailureSchema),
          }),
        ),
      },
    },
    async ({ organizationId, user }, reply) => {
      const failures = await syncModelsForVisibleApiKeys({
        organizationId,
        userId: user.id,
      });

      logger.info({ organizationId }, "Completed model sync for all API keys");

      return reply.send({ success: failures.length === 0, failures });
    },
  );

  fastify.get(
    "/api/llm-models",
    {
      schema: {
        operationId: RouteId.GetModelsWithApiKeys,
        description:
          "Get all synced LLM models with their linked provider API keys.",
        tags: ["LLM Models"],
        querystring: z.object({
          access: ResourceAccessQuerySchema,
          sharedWith: ResourceSharedWithQuerySchema,
          apiKeyIds: z
            .preprocess(
              (value) =>
                typeof value === "string"
                  ? value.split(",").filter(Boolean)
                  : value,
              z.array(z.string().uuid()).max(100),
            )
            .optional()
            .describe("Only models linked to one of these provider keys."),
          embedding: z
            .preprocess(
              (value) => value === "true" || value === true,
              z.boolean(),
            )
            .optional()
            .describe("Only embedding models (models with known dimensions)."),
          includeAssignments: z
            .preprocess(
              (value) => value !== "false" && value !== false,
              z.boolean(),
            )
            .optional()
            .describe(
              "Include each model's teams, users and labels (default true). False returns them empty, for pickers that show only the models.",
            ),
        }),
        response: constructResponseSchema(z.array(ModelWithApiKeysSchema)),
      },
    },
    async ({ organizationId, user, query }, reply) => {
      // The link table spans every org and user (models are global metadata),
      // so attach only the caller's visible keys — the same rules as the Model
      // Providers page (own personal + team + org keys, other users' personal
      // keys hidden even from admins). Without this, per-user providers leak
      // every member's personal key as identical "Microsoft 365 Copilot"
      // entries. Models keep showing with an empty key list, like the unlinked
      // llm-proxy models below.
      const modelsWithApiKeys =
        await LlmProviderApiKeyModelLinkModel.findLinkedModels({
          visibleKeyIds: await LlmProviderApiKeyModel.getVisibleKeyIds(
            organizationId,
            user.id,
          ),
          apiKeyIds: query.apiKeyIds,
          embeddingOnly: query.embedding,
        });

      // Proxy-discovered models have no keys, so a key or embedding filter
      // leaves them out.
      const unlinkedLlmProxyModels =
        query.apiKeyIds || query.embedding
          ? []
          : await findUnlinkedLlmProxyModels(modelsWithApiKeys);

      const enrichedModelIds = [
        ...modelsWithApiKeys.map((item) => item.model.id),
        ...unlinkedLlmProxyModels.map((model) => model.id),
      ];
      const [teamsByModelId, usersByModelId, labelsByModelId] =
        query.includeAssignments === false
          ? [
              new Map<string, ModelTeamDetail[]>(),
              new Map<
                string,
                Array<{ id: string; name: string; email: string }>
              >(),
              new Map<string, LabelWithDetails[]>(),
            ]
          : await Promise.all([
              ModelTeamModel.getTeamDetailsForModels(enrichedModelIds),
              ModelUserModel.getUserDetailsForModels(enrichedModelIds),
              ModelLabelModel.getLabelsForMany(enrichedModelIds),
            ]);

      const enriched = [
        ...modelsWithApiKeys.map(({ model, isBest, apiKeys }) =>
          toModelWithApiKeysResponse({
            model,
            isBest,
            apiKeys,
            teams: teamsByModelId.get(model.id) ?? [],
            users: usersByModelId.get(model.id) ?? [],
            labels: labelsByModelId.get(model.id) ?? [],
          }),
        ),
        ...unlinkedLlmProxyModels.map((model) =>
          toModelWithApiKeysResponse({
            model,
            isBest: false,
            apiKeys: [],
            teams: teamsByModelId.get(model.id) ?? [],
            users: usersByModelId.get(model.id) ?? [],
            labels: labelsByModelId.get(model.id) ?? [],
          }),
        ),
      ];
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      const access = await ResourcePermissionSubjectModel.resolveAccessFilter({
        userId: user.id,
        organizationId,
        relations: query.access,
        sharedWith: query.sharedWith,
      });
      const matching =
        access &&
        (await ModelModel.idsMatchingAccess({
          organizationId,
          ids: enriched.map((model) => model.id),
          access,
        }));
      // SPDX-SnippetEnd
      const response = matching
        ? enriched.filter((model) => matching.has(model.id))
        : enriched;

      logger.debug(
        { modelCount: response.length },
        "Returning models with API keys",
      );

      return reply.send(
        await filterReadableModels({
          models: response,
          userId: user.id,
          organizationId,
        }),
      );
    },
  );

  fastify.get(
    "/api/llm-models/key-model-ids",
    {
      schema: {
        operationId: RouteId.GetLlmModelIdsByKey,
        description:
          "For each provider key the caller can see, the ids of the models it serves, leaving out hidden models. The models are the ones GET /api/llm-models lists for that key.",
        tags: ["LLM Models"],
        response: constructResponseSchema(
          z.array(
            z.object({
              apiKeyId: z.string().uuid(),
              modelIds: z.array(z.string()),
            }),
          ),
        ),
      },
    },
    async ({ organizationId, user }, reply) => {
      const rows = await filterReadableModels({
        models: await LlmProviderApiKeyModelLinkModel.findModelsByKey(
          await LlmProviderApiKeyModel.getVisibleKeyIds(
            organizationId,
            user.id,
          ),
        ),
        userId: user.id,
        organizationId,
      });
      const modelIdsByKey = new Map<string, string[]>();
      for (const row of rows) {
        const modelIds = modelIdsByKey.get(row.apiKeyId) ?? [];
        modelIds.push(row.modelId);
        modelIdsByKey.set(row.apiKeyId, modelIds);
      }
      return reply.send(
        [...modelIdsByKey].map(([apiKeyId, modelIds]) => ({
          apiKeyId,
          modelIds,
        })),
      );
    },
  );

  fastify.get(
    "/api/llm-models/options",
    {
      schema: {
        operationId: RouteId.GetLlmModelOptions,
        description:
          "The models GET /api/llm-models lists, in the same order, with only what a model picker shows: name, provider and price.",
        tags: ["LLM Models"],
        response: constructResponseSchema(z.array(LlmModelOptionSchema)),
      },
    },
    async ({ organizationId, user }, reply) => {
      // Resolve prices from the caller's instances; conflicting rates remain
      // unknown on a picker that has not selected a provider key yet.
      const linked = await LlmProviderApiKeyModelLinkModel.findLinkedModels({
        visibleKeyIds: await LlmProviderApiKeyModel.getVisibleKeyIds(
          organizationId,
          user.id,
        ),
      });
      const unlinked = await findUnlinkedLlmProxyModels(linked);
      const options = [
        ...linked,
        ...unlinked.map((model) => ({ model, isBest: false })),
      ].map(({ model, isBest }) => {
        const capabilities = ModelModel.toCapabilities(model);
        return {
          id: model.id,
          modelId: model.modelId,
          provider: model.provider,
          description: model.description,
          pricePerMillionInput: capabilities.pricePerMillionInput,
          pricePerMillionOutput: capabilities.pricePerMillionOutput,
          isFree: isFreeModel(model),
          isBest,
        };
      });
      return reply.send(
        await filterReadableModels({
          models: options,
          userId: user.id,
          organizationId,
        }),
      );
    },
  );

  fastify.patch(
    "/api/llm-models/bulk",
    {
      schema: {
        operationId: RouteId.BulkUpdateModels,
        description:
          "Update several LLM models in one request. Today the only " +
          "bulk-editable field is `ignored`, which hides a model from the " +
          "pickers without deleting anything. Ids that match no model are " +
          "reported in `failed` and leave the rest of the batch applied.",
        tags: ["LLM Models"],
        body: z.object({
          ids: BulkIdsSchema,
          ignored: z
            .boolean()
            .describe("Whether every model in the batch is hidden."),
        }),
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { ignored } = request.body;
      const permissionContext = {
        organizationId: request.organizationId,
        userId: request.user.id,
        resource: "llmModel" as const,
      };
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      const [objectGrants, wildcard] = await Promise.all([
        ResourcePermissions.resolveAll(permissionContext),
        ResourcePermissions.getEffective({ ...permissionContext, scope: "*" }),
      ]);
      // SPDX-SnippetEnd
      const grants = [...objectGrants, ...wildcard.grants];

      const outcome = await runBulk({
        ids: request.body.ids,
        logLabel: "models bulk update",
        notFoundMessage: "Model not found",
        unexpectedMessage: "Could not update this model",
        load: async (ids) =>
          new Map(
            (await ModelModel.findByIds(ids)).map((model) => [model.id, model]),
          ),
        authorize: async (model) => {
          if (
            !hasScopedPermission({
              grants,
              required: {
                ...permissionContext,
                scope: model.id,
                action: "update",
              },
            })
          )
            throw new ApiError(
              403,
              "You do not have permission to modify this model",
            );
        },
        // The row's own name, as the pickers show it.
        describe: (model) => model.modelId,
        applyEach: async (model, id) => {
          if (model.ignored === ignored) return;
          await ModelModel.update(id, { ignored });
        },
        audit: {
          target: request,
          snapshot: async (ids) => ({
            models: await ModelModel.findVisibilityForBulkAudit(ids),
          }),
        },
      });

      return reply.send(outcome);
    },
  );

  fastify.patch(
    "/api/llm-models/:id",
    {
      schema: {
        operationId: RouteId.UpdateModel,
        description:
          "Update LLM model details including custom pricing and modalities.",
        tags: ["LLM Models"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: PatchModelBodySchema,
        response: constructResponseSchema(SelectModelSchema),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissions.require({
        organizationId,
        userId: user.id,
        resource: "llmModel",
        scope: id,
        action: "update",
      });
      // SPDX-SnippetEnd
      const existing = await ModelModel.findById(id);
      if (!existing) {
        throw new ApiError(404, "Model not found");
      }

      // Validated here rather than in the body schema, which carries neither the
      // provider nor the context length. The route gate (`llmModel:update`) is
      // the only permission check: model rows are global, but so are the pricing
      // and `ignored` fields an editor can already write, so singling out
      // generation parameters bought a 403 class without a matching guarantee.
      if (
        body.configuredParameters !== undefined &&
        existing.provider !== "ollama-native"
      ) {
        throw new ApiError(
          400,
          `Generation parameters are only supported for Ollama (Native) models, not "${existing.provider}"`,
        );
      }

      // Checked against the post-patch state, and on either field changing:
      // lowering the custom context window below an already-configured num_ctx
      // is the same inconsistency as raising num_ctx above the window, and only
      // one of the two arrives in any given request.
      const numCtx =
        body.configuredParameters !== undefined
          ? body.configuredParameters?.num_ctx
          : existing.configuredParameters?.num_ctx;
      const contextCeiling = ModelModel.resolveArchitecturalContextLength({
        contextLength: existing.contextLength,
        customContextLength:
          body.customContextLength !== undefined
            ? body.customContextLength
            : existing.customContextLength,
      });
      if (
        (body.configuredParameters !== undefined ||
          body.customContextLength !== undefined) &&
        numCtx !== undefined &&
        contextCeiling !== null &&
        numCtx > contextCeiling
      ) {
        throw new ApiError(
          400,
          `num_ctx (${numCtx}) exceeds the model's context length of ${contextCeiling}`,
        );
      }

      // The knowledge base reads embedding dimensions from this row at embed
      // time, so changing them — or clearing them, which turns the model back
      // into a chat model — while an organization's embedding config points
      // here would silently corrupt the existing index. Mirror the
      // knowledge-settings lock: force changes through the drop-embedding flow.
      const existingInputModalities = new Set(existing.inputModalities ?? []);
      const requestedInputModalities = new Set(body.inputModalities ?? []);
      const inputModalitiesChanged =
        body.inputModalities !== undefined &&
        ((body.inputModalities === null) !==
          (existing.inputModalities === null) ||
          requestedInputModalities.size !== existingInputModalities.size ||
          [...requestedInputModalities].some(
            (modality) => !existingInputModalities.has(modality),
          ));
      const embeddingConfigurationChanged =
        (body.embeddingDimensions !== undefined &&
          body.embeddingDimensions !== existing.embeddingDimensions) ||
        inputModalitiesChanged;
      if (
        embeddingConfigurationChanged &&
        (await OrganizationModel.isKnowledgeEmbeddingModel({
          provider: existing.provider,
          modelId: existing.modelId,
        }))
      ) {
        throw new ApiError(
          400,
          "This model is used as the knowledge base embedding model, so its dimensions and input modalities cannot be changed. Drop the embedding configuration in Knowledge settings first — all documents will need to be re-embedded.",
          "embedding_validation_failed",
        );
      }

      // An embedding model can only be marked image-capable when the embedding
      // client can actually send images to it — otherwise connectors would
      // ingest images that fail at embed time. Checked on the post-patch state
      // so setting embedding dimensions on an image-capable chat model is
      // caught too.
      const effectiveEmbeddingDimensions =
        body.embeddingDimensions !== undefined
          ? body.embeddingDimensions
          : existing.embeddingDimensions;
      const effectiveInputModalities =
        body.inputModalities !== undefined
          ? body.inputModalities
          : existing.inputModalities;
      if (
        effectiveEmbeddingDimensions !== null &&
        effectiveInputModalities?.includes("image")
      ) {
        const clientModalities = getEmbeddingClientInputModalities(
          existing.provider,
          existing.modelId,
        );
        if (clientModalities !== null && !clientModalities.includes("image")) {
          throw new ApiError(
            400,
            `Embedding for "${existing.modelId}" is text-only: the ${existing.provider} embedding client cannot send images to this model, so it cannot accept the image input modality while configured as an embedding model.`,
            "embedding_validation_failed",
          );
        }
      }

      const { labels, ...modelUpdates } = body;
      const updated = await ModelModel.update(id, modelUpdates);
      if (!updated) {
        throw new ApiError(500, "Failed to update model");
      }

      // Only touch labels when the caller sent them, so an update that omits
      // the field leaves existing labels alone.
      if (labels !== undefined) {
        await ModelLabelModel.syncLabels(id, labels);
      }

      return reply.send(updated);
    },
  );
};

export default llmModelsRoutes;

// =============================================================================
// Reads shared with the new-chat bootstrap (routes/bootstrap.ts). Each returns
// exactly what its endpoint above sends.
// =============================================================================

/** `GET /api/llm-models/available` */
export async function getAvailableLlmModels(params: {
  query: {
    provider?: SupportedProvider;
    apiKeyId?: string;
    isEmbedding?: boolean;
  };
  userId: string;
  organizationId: string;
}) {
  const { query, userId, organizationId } = params;
  const { provider, apiKeyId, isEmbedding } = query;

  const userTeamIds = await TeamModel.getUserTeamIds(userId);
  const apiKeys = await LlmProviderApiKeyModel.getAvailableKeysForUser(
    organizationId,
    userId,
    userTeamIds,
    provider,
  );

  logger.info(
    {
      organizationId,
      provider,
      apiKeyId,
      apiKeyCount: apiKeys.length,
      apiKeys: apiKeys.map((key) => ({
        id: key.id,
        name: key.name,
        provider: key.provider,
        isSystem: key.isSystem,
      })),
    },
    "Available API keys for user",
  );

  const accessibleKeyIds = apiKeys.map((key) => key.id);
  if (apiKeyId && !accessibleKeyIds.includes(apiKeyId)) {
    logger.warn(
      { apiKeyId, organizationId, userId: userId },
      "Requested apiKeyId not found in user's accessible keys, falling back to all keys",
    );
  }

  const apiKeyIds =
    apiKeyId && accessibleKeyIds.includes(apiKeyId)
      ? [apiKeyId]
      : accessibleKeyIds;
  const dbModels =
    await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds(apiKeyIds);

  logger.info(
    {
      organizationId,
      provider,
      apiKeyIds,
      modelCount: dbModels.length,
    },
    "Models fetched from database",
  );

  // Per-user providers (e.g. GitHub Copilot) are catalogued org-wide and
  // resolved per-user at request time, so they're sourced separately below
  // (visible to everyone, flagged) — keep them out of the per-key path so a
  // member's own connected copy isn't listed twice or shown unflagged.
  let filteredModels = dbModels.filter(
    ({ model }) => !providerRequiresPerUserCredential(model.provider),
  );
  if (provider) {
    filteredModels = filteredModels.filter(
      ({ model }) => model.provider === provider,
    );
  }

  const azureLinks =
    await LlmProviderApiKeyModelLinkModel.findCapabilitiesForApiKeyModels(
      apiKeyIds,
    );
  filteredModels = filteredModels.map((entry) => {
    if (entry.model.provider !== "azure") return entry;
    const evidence = azureLinks
      .filter((link) => link.model.id === entry.model.id)
      .map(classifyAzureModelCapabilities)
      .find((evidence) => evidence.status === "known");
    return {
      ...entry,
      model: {
        ...entry.model,
        azureCapabilities: evidence?.status === "known" ? evidence : null,
      },
    };
  });

  // Filter by embedding status if requested
  if (isEmbedding !== undefined) {
    filteredModels = filteredModels.filter(({ model }) =>
      isEmbedding
        ? model.embeddingDimensions !== null
        : model.embeddingDimensions === null,
    );
  }

  const keyLinkedModels = filteredModels
    .filter(({ model }) =>
      isEmbedding ? true : ModelModel.supportsTextChat(model),
    )
    .map(({ model, isBest, recommendedForAgents }) => ({
      id: model.modelId,
      dbId: model.id,
      displayName: model.description || model.modelId,
      provider: model.provider,
      capabilities: ModelModel.toCapabilities(model, recommendedForAgents),
      isBest,
      isFree: isFreeModel(model),
      embeddingDimensions: model.embeddingDimensions,
    }));

  const perUserModels = await getPerUserProviderModels({
    organizationId,
    provider,
    isEmbedding,
    connectedProviders: new Set(
      apiKeys
        .filter((key) => providerRequiresPerUserCredential(key.provider))
        .map((key) => key.provider),
    ),
  });

  const models = [...keyLinkedModels, ...perUserModels];

  // Hide models restricted to teams the caller is not part of. Catalog
  // managers (llmModel:update) keep full visibility so they can see what
  // they are restricting.
  const isModelCatalogAdmin = await userHasPermission(
    userId,
    organizationId,
    "llmModel",
    "update",
  );
  let visibleModels = models;
  if (!isModelCatalogAdmin) {
    const allowedModelIds = await ModelTeamModel.filterAllowedModelIds({
      modelIds: models.map((model) => model.dbId),
      organizationId,
      userId,
      action: "read",
    });
    visibleModels = models.filter((model) => allowedModelIds.has(model.dbId));
  }

  if (!(await userHasPermission(userId, organizationId, "llmModel", "read"))) {
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const grants = await ResourcePermissions.resolveAll({
      organizationId,
      userId,
    });
    // SPDX-SnippetEnd
    visibleModels = visibleModels.filter((model) =>
      grants.some(
        (grant) =>
          grant.resource === "llmModel" &&
          grant.action === "read" &&
          (grant.scope === "*" || grant.scope === model.dbId),
      ),
    );
  }

  logger.info(
    { organizationId, provider, totalModels: visibleModels.length },
    "Returning available LLM models from database",
  );

  // Stored descriptions can still collide at read time — rows synced
  // before names were disambiguated, or keys whose catalogs each contain
  // only one member of a colliding pair — so the response gets its own
  // pass to keep picker rows tellable-apart.
  return withDistinctDisplayNames(visibleModels);
}

/**
 * Build the flagged per-user-provider model entries for the available-models
 * response. Per-user providers (GitHub Copilot) are advertised to every member
 * — connected or not — because the credential is resolved per-user at request
 * time; the `requiresUserConnection`/`isConnected` flags let the UI prompt a
 * member to connect instead of hiding the model or showing it as unavailable.
 */
async function getPerUserProviderModels(params: {
  organizationId: string;
  provider?: SupportedProvider;
  isEmbedding?: boolean;
  connectedProviders: Set<SupportedProvider>;
}): Promise<Array<z.infer<typeof LlmModelSchema>>> {
  const { organizationId, provider, isEmbedding, connectedProviders } = params;

  // Per-user providers don't expose embeddings, so never inject for embeddings.
  if (isEmbedding) {
    return [];
  }

  // Per-user providers are org-wide and resolved per-user at request time, so
  // they're always offered (regardless of any single-key `apiKeyId` scoping) —
  // the picker should let any member pick a Copilot model and connect on send.
  const providers = provider
    ? providerRequiresPerUserCredential(provider)
      ? [provider]
      : []
    : SupportedProviders.filter(providerRequiresPerUserCredential);

  if (providers.length === 0) {
    return [];
  }

  const perProvider = await Promise.all(
    providers.map(async (perUserProvider) => {
      const orgModels =
        await LlmProviderApiKeyModelLinkModel.getOrgModelsForPerUserProvider(
          organizationId,
          perUserProvider,
        );
      const isConnected = connectedProviders.has(perUserProvider);
      return orgModels
        .filter(({ model }) => ModelModel.supportsTextChat(model))
        .map(({ model, isBest }) => ({
          id: model.modelId,
          dbId: model.id,
          displayName: model.description || model.modelId,
          provider: model.provider,
          capabilities: ModelModel.toCapabilities(model),
          isBest,
          isFree: isFreeModel(model),
          embeddingDimensions: model.embeddingDimensions,
          requiresUserConnection: true,
          isConnected,
        }));
    }),
  );

  return perProvider.flat();
}

/**
 * Shape a model row into the models-with-API-keys response, attaching the
 * computed effective pricing (input/output + cache) and price sources, plus the
 * context window the model actually enforces.
 */
function toModelWithApiKeysResponse(params: {
  model: Model;
  isBest: boolean;
  apiKeys: LinkedApiKey[];
  teams: ModelTeamDetail[];
  users: Array<{ id: string; name: string; email: string }>;
  labels: LabelWithDetails[];
}) {
  const { model, isBest, apiKeys, teams, users, labels } = params;
  const capabilities = ModelModel.toCapabilities(model);
  return {
    ...model,
    isBest,
    apiKeys,
    teams,
    users,
    labels,
    // The spread above carries the architectural `contextLength`, which stays
    // the ceiling for `num_ctx` validation. Displaying it would over-promise
    // when Ollama enforces a smaller window, so the resolved one rides along.
    effectiveContextLength: capabilities.contextLength,
    embeddingClientImageCapable: embeddingClientImageCapable(model),
    pricePerMillionInput: capabilities.pricePerMillionInput,
    pricePerMillionOutput: capabilities.pricePerMillionOutput,
    isCustomPrice: capabilities.isCustomPrice,
    priceSource: capabilities.priceSource,
    pricePerMillionCacheRead: capabilities.pricePerMillionCacheRead,
    pricePerMillionCacheWrite: capabilities.pricePerMillionCacheWrite,
    cachePriceSource: capabilities.cachePriceSource,
    isFree: isFreeModel(model),
  };
}

/**
 * Whether the platform's embedding client can send images to this model —
 * `null` when the client imposes no per-model limit (Gemini). Drives the edit
 * dialog's image-modality restriction; the PATCH route enforces the same rule.
 */
function embeddingClientImageCapable(model: Model): boolean | null {
  const clientModalities = getEmbeddingClientInputModalities(
    model.provider,
    model.modelId,
  );
  return clientModalities === null ? null : clientModalities.includes("image");
}

/** Proxy-discovered models that no provider key serves. */
async function findUnlinkedLlmProxyModels(
  linked: Array<{ model: { id: string } }>,
): Promise<Model[]> {
  const linkedModelIds = new Set(linked.map((item) => item.model.id));
  return (await ModelModel.findLlmProxyModels()).filter(
    (model) => !linkedModelIds.has(model.id),
  );
}

/**
 * Keep the models the caller may read: all of them with `llmModel:read`,
 * otherwise those an `llmModel` read grant names.
 */
async function filterReadableModels<T extends { id: string }>(params: {
  models: T[];
  userId: string;
  organizationId: string;
}): Promise<T[]> {
  const { models, userId, organizationId } = params;
  if (await userHasPermission(userId, organizationId, "llmModel", "read"))
    return models;
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const grants = await ResourcePermissions.resolveAll({
    organizationId,
    userId,
  });
  // SPDX-SnippetEnd
  return models.filter((model) =>
    grants.some(
      (grant) =>
        grant.resource === "llmModel" &&
        grant.action === "read" &&
        (grant.scope === "*" || grant.scope === model.id),
    ),
  );
}
