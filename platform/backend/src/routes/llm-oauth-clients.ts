import { randomUUID } from "node:crypto";
import {
  createPaginatedResponseSchema,
  credentialRequiresPerUserScope,
  PaginationQuerySchema,
  parseLabelsParam,
  perUserCredentialLabel,
  providerRequiresPerUserCredential,
  ResourcePermissionGrantSchema,
  RouteId,
  SupportedProvidersSchema,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireOauthClientAccess } from "@/auth/oauth-client-permissions";
import {
  LlmOauthClientModel,
  LlmProviderApiKeyModel,
  OauthClientLabelModel,
} from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  ApiError,
  constructResponseSchema,
  LabelWithDetailsSchema,
  LlmOauthClientGrantTypeSchema,
  LlmOauthClientSchema,
  LlmOauthClientWithSecretSchema,
} from "@/types";
import { BulkDeleteBodySchema, BulkOutcomeSchema, runBulk } from "./bulk-route";
import { registerEntityLabelRoutes } from "./entity-labels";

const LlmOauthClientProviderKeyBodySchema = z.object({
  provider: SupportedProvidersSchema,
  providerApiKeyId: z.string().uuid(),
});

/**
 * Both grant types share one body shape. `grantType` defaults to
 * `client_credentials` so existing callers keep working unchanged.
 * - client_credentials: a shared application credential scoped to the
 *   organization; requires `providerApiKeys`. `redirectUris` is ignored.
 * - authorization_code: requires `redirectUris`; its tokens are user-bound, so
 *   the proxy resolves the acting user's own provider keys, cost limits, and
 *   policies. `providerApiKeys` never apply — the acting user's own keys
 *   resolve at call time.
 *
 * Who can see and manage the client is its grants, edited on its Permissions
 * tab; they never change what its tokens can reach.
 */
const LlmOauthClientFields = z
  .object({
    name: z.string().min(1).max(256),
    grantType: LlmOauthClientGrantTypeSchema.default("client_credentials"),
    providerApiKeys: z.array(LlmOauthClientProviderKeyBodySchema).optional(),
    redirectUris: z.array(z.string().url()).optional(),
    labels: z
      .array(LabelWithDetailsSchema)
      .optional()
      .describe(
        "Key/value labels. Omit to leave existing labels untouched; pass [] " +
          "to clear them.",
      ),
  })
  .strict();

const validateLlmOauthClientBody = (
  value: z.infer<typeof LlmOauthClientFields>,
  ctx: z.RefinementCtx,
) => {
  if (value.grantType === "authorization_code") {
    if (!value.redirectUris || value.redirectUris.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["redirectUris"],
        message:
          "At least one redirect URI is required for authorization_code clients",
      });
    }
    return;
  }
  if (!value.providerApiKeys || value.providerApiKeys.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["providerApiKeys"],
      message:
        "At least one provider API key is required for client_credentials clients",
    });
  }
};

const CreateLlmOauthClientBodySchema = LlmOauthClientFields.extend({
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  initialGrants: z
    .array(ResourcePermissionGrantSchema)
    .max(200)
    .optional()
    .describe(
      "Who else starts with access, beside the creator who always gets full access.",
    ),
  // SPDX-SnippetEnd
}).superRefine(validateLlmOauthClientBody);
const UpdateLlmOauthClientBodySchema = LlmOauthClientFields.superRefine(
  validateLlmOauthClientBody,
);

const llmOauthClientsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  registerEntityLabelRoutes(fastify, {
    basePath: "/api/llm-oauth-clients",
    tag: "LLM OAuth Clients",
    entityNamePlural: "LLM OAuth clients",
    model: OauthClientLabelModel,
    keysOperationId: RouteId.GetLlmOauthClientLabelKeys,
    valuesOperationId: RouteId.GetLlmOauthClientLabelValues,
  });

  fastify.get(
    "/api/llm-oauth-clients",
    {
      schema: {
        operationId: RouteId.GetLlmOauthClients,
        description: "List LLM OAuth clients that can access LLM proxies",
        tags: ["LLM OAuth Clients"],
        querystring: PaginationQuerySchema.extend({
          search: z.string().trim().min(1).optional(),
          providerApiKeyId: z.string().uuid().optional(),
          grantType: LlmOauthClientGrantTypeSchema.optional(),
          labels: z
            .string()
            .optional()
            .describe(
              "Filter by labels. Format: key1:val1|val2;key2:val3. AND across keys, OR within values.",
            ),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(LlmOauthClientSchema),
        ),
      },
    },
    async ({ user, organizationId, query }, reply) => {
      const result = await LlmOauthClientModel.findPageByOrganization({
        organizationId,
        pagination: { limit: query.limit, offset: query.offset },
        search: query.search,
        providerApiKeyId: query.providerApiKeyId,
        grantType: query.grantType,
        labels: parseLabelsParam(query.labels),
        viewer: { userId: user.id },
      });
      return reply.send(result);
    },
  );

  fastify.post(
    "/api/llm-oauth-clients",
    {
      schema: {
        operationId: RouteId.CreateLlmOauthClient,
        description:
          "Create an LLM OAuth client and return its client secret once",
        tags: ["LLM OAuth Clients"],
        body: CreateLlmOauthClientBodySchema,
        response: constructResponseSchema(LlmOauthClientWithSecretSchema),
      },
    },
    async ({ body, user, organizationId }, reply) => {
      if (body.initialGrants?.length) {
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        await ResourcePermissions.validateInitialGrants({
          organizationId,
          userId: user.id,
          resource: "llmOauthClient",
          grants: body.initialGrants,
          target: {
            id: randomUUID(),
            name: body.name,
            authorId: user.id,
          },
        });
        // SPDX-SnippetEnd
      }

      await validateLlmOauthClientConfig({
        organizationId,
        // provider keys only apply to client_credentials clients.
        providerApiKeys:
          body.grantType === "client_credentials"
            ? (body.providerApiKeys ?? [])
            : [],
      });
      const { oauthClient, clientSecret } = await LlmOauthClientModel.create({
        organizationId,
        name: body.name,
        grantType: body.grantType,
        providerApiKeys: body.providerApiKeys,
        redirectUris: body.redirectUris,
        authorId: user.id,
        initialGrants: body.initialGrants,
      });
      if (body.labels?.length) {
        await OauthClientLabelModel.syncLabels(oauthClient.id, body.labels);
      }
      return reply.send({
        ...oauthClient,
        labels: await OauthClientLabelModel.getLabelsFor(oauthClient.id),
        clientSecret,
      });
    },
  );

  fastify.put(
    "/api/llm-oauth-clients/:id",
    {
      schema: {
        operationId: RouteId.UpdateLlmOauthClient,
        description: "Update an LLM OAuth client",
        tags: ["LLM OAuth Clients"],
        params: z.object({ id: z.string() }),
        body: UpdateLlmOauthClientBodySchema,
        response: constructResponseSchema(LlmOauthClientSchema),
      },
    },
    async ({ params, body, user, organizationId }, reply) => {
      await requireOauthClientAccess({
        organizationId,
        userId: user.id,
        resource: "llmOauthClient",
        id: params.id,
        action: "update",
      });

      await validateLlmOauthClientConfig({
        organizationId,
        // provider keys only apply to client_credentials clients.
        providerApiKeys:
          body.grantType === "client_credentials"
            ? (body.providerApiKeys ?? [])
            : [],
      });
      const oauthClient = await LlmOauthClientModel.update({
        id: params.id,
        organizationId,
        name: body.name,
        providerApiKeys: body.providerApiKeys,
        redirectUris: body.redirectUris,
      });
      if (!oauthClient) {
        throw new ApiError(404, "LLM OAuth client not found");
      }
      // Only touch labels when the caller sent them, so an update that omits
      // the field leaves existing labels alone.
      if (body.labels !== undefined) {
        await OauthClientLabelModel.syncLabels(params.id, body.labels);
        return reply.send({
          ...oauthClient,
          labels: await OauthClientLabelModel.getLabelsFor(params.id),
        });
      }
      return reply.send(oauthClient);
    },
  );

  fastify.post(
    "/api/llm-oauth-clients/:id/rotate-secret",
    {
      schema: {
        operationId: RouteId.RotateLlmOauthClientSecret,
        description: "Rotate an LLM OAuth client's client secret",
        tags: ["LLM OAuth Clients"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(LlmOauthClientWithSecretSchema),
      },
    },
    async ({ params, user, organizationId }, reply) => {
      await requireOauthClientAccess({
        organizationId,
        userId: user.id,
        resource: "llmOauthClient",
        id: params.id,
        action: "update",
      });
      const result = await LlmOauthClientModel.rotateSecret({
        id: params.id,
        organizationId,
      });
      if (!result) {
        throw new ApiError(404, "LLM OAuth client not found");
      }
      return reply.send({
        ...result.oauthClient,
        clientSecret: result.clientSecret,
      });
    },
  );

  fastify.delete(
    "/api/llm-oauth-clients/:id",
    {
      schema: {
        operationId: RouteId.DeleteLlmOauthClient,
        description: "Delete an LLM OAuth client",
        tags: ["LLM OAuth Clients"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, user, organizationId }, reply) => {
      await requireOauthClientAccess({
        organizationId,
        userId: user.id,
        resource: "llmOauthClient",
        id: params.id,
        action: "delete",
      });
      const success = await LlmOauthClientModel.delete({
        id: params.id,
        organizationId,
      });
      if (!success) {
        throw new ApiError(404, "LLM OAuth client not found");
      }
      return reply.send({ success });
    },
  );

  fastify.delete(
    "/api/llm-oauth-clients/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteLlmOauthClients,
        description:
          "Delete several LLM OAuth clients in one request. Each id is " +
          "authorized exactly as the single-client delete authorizes its " +
          "own, so a client the caller cannot see or manage is reported in " +
          "`failed` while the rest of the batch still applies.",
        tags: ["LLM OAuth Clients"],
        body: BulkDeleteBodySchema,
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId, user, body } = request;

      const snapshot = async (ids: string[]) => {
        const clients = await LlmOauthClientModel.findByIds({
          ids,
          organizationId,
        });
        return {
          llmOauthClients: clients
            .map(({ id, name }) => ({ id, name }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        };
      };

      const outcome = await runBulk({
        ids: body.ids,
        logLabel: "LLM OAuth clients bulk delete",
        notFoundMessage: "LLM OAuth client not found",
        unexpectedMessage: "Could not delete this LLM OAuth client",
        load: async (ids) =>
          new Map(
            (
              await LlmOauthClientModel.findByIds({
                ids,
                organizationId,
                viewer: { userId: user.id },
              })
            ).map((client) => [client.id, client]),
          ),
        describe: (client) => client.name,
        authorize: async (client) => {
          await requireOauthClientAccess({
            organizationId,
            userId: user.id,
            resource: "llmOauthClient",
            id: client.id,
            action: "delete",
          });
        },
        applyEach: async (_client, id) => {
          const deleted = await LlmOauthClientModel.delete({
            id,
            organizationId,
          });
          if (!deleted) {
            throw new ApiError(404, "LLM OAuth client not found");
          }
        },
        audit: { target: request, snapshot },
      });

      return reply.send(outcome);
    },
  );
};

export default llmOauthClientsRoutes;

async function validateLlmOauthClientConfig(params: {
  organizationId: string;
  providerApiKeys: Array<{
    provider: z.infer<typeof SupportedProvidersSchema>;
    providerApiKeyId: string;
  }>;
}) {
  const seenProviders = new Set<string>();
  for (const mapping of params.providerApiKeys) {
    if (seenProviders.has(mapping.provider)) {
      throw new ApiError(
        400,
        `Only one provider API key can be mapped for provider "${mapping.provider}"`,
      );
    }
    seenProviders.add(mapping.provider);
  }

  for (const mapping of params.providerApiKeys) {
    const apiKey = await LlmProviderApiKeyModel.findById(
      mapping.providerApiKeyId,
    );
    if (!apiKey || apiKey.organizationId !== params.organizationId) {
      throw new ApiError(404, "LLM provider API key not found");
    }
    if (apiKey.provider !== mapping.provider) {
      throw new ApiError(
        400,
        `Provider API key "${apiKey.name}" is for ${apiKey.provider}, not ${mapping.provider}`,
      );
    }
    // OAuth client credentials are a shared service credential with no acting
    // user. Resolve credential-level markers as well as provider-level cases:
    // OpenAI/xAI may contain either a normal API key or one person's subscription.
    const secret =
      apiKey.secretId && !providerRequiresPerUserCredential(mapping.provider)
        ? ((await getSecretValueForLlmProviderApiKey(apiKey.secretId)) as
            | string
            | undefined)
        : undefined;
    if (
      credentialRequiresPerUserScope({
        provider: mapping.provider,
        apiKey: secret,
      })
    ) {
      throw new ApiError(
        400,
        `${perUserCredentialLabel({ provider: mapping.provider, apiKey: secret })} is per-user and cannot be mapped to an OAuth client; each user connects their own account.`,
      );
    }
  }
}
