import { randomUUID } from "node:crypto";
import {
  parseLabelsParam,
  ResourcePermissionGrantSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireOauthClientAccess } from "@/auth/oauth-client-permissions";
import {
  AgentModel,
  McpOauthClientModel,
  OauthClientLabelModel,
} from "@/models";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  ApiError,
  constructResponseSchema,
  LabelWithDetailsSchema,
  McpOauthClientGrantTypeSchema,
  McpOauthClientSchema,
  McpOauthClientWithSecretSchema,
} from "@/types";
import { registerEntityLabelRoutes } from "./entity-labels";

/**
 * Both grant types share one body shape. `grantType` defaults to
 * `client_credentials` so existing callers keep working unchanged.
 * - client_credentials: requires `allowedGatewayIds` (the sole authority for the
 *   token); `redirectUris` is ignored.
 * - authorization_code: requires `redirectUris`. `allowedGatewayIds` is optional
 *   here and acts as an additive, admin-controlled grant — users who
 *   authenticate through the client may reach those gateways on top of their own
 *   RBAC. Empty means pure identity passthrough.
 *
 * Who can see and manage the client is its grants, edited on its Permissions
 * tab; nothing here decides what its tokens can reach beyond the gateways.
 */
const McpOauthClientFields = z
  .object({
    name: z.string().min(1).max(256),
    grantType: McpOauthClientGrantTypeSchema.default("client_credentials"),
    allowedGatewayIds: z.array(z.string().uuid()).optional(),
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

const validateMcpOauthClientBody = (
  value: z.infer<typeof McpOauthClientFields>,
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
  } else if (!value.allowedGatewayIds || value.allowedGatewayIds.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["allowedGatewayIds"],
      message:
        "At least one gateway is required for client_credentials clients",
    });
  }
};

const CreateMcpOauthClientBodySchema = McpOauthClientFields.extend({
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
}).superRefine(validateMcpOauthClientBody);
const UpdateMcpOauthClientBodySchema = McpOauthClientFields.superRefine(
  validateMcpOauthClientBody,
);

const mcpOauthClientsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  registerEntityLabelRoutes(fastify, {
    basePath: "/api/mcp-oauth-clients",
    tag: "MCP OAuth Clients",
    entityNamePlural: "MCP OAuth clients",
    model: OauthClientLabelModel,
    keysOperationId: RouteId.GetMcpOauthClientLabelKeys,
    valuesOperationId: RouteId.GetMcpOauthClientLabelValues,
  });

  fastify.get(
    "/api/mcp-oauth-clients",
    {
      schema: {
        operationId: RouteId.GetMcpOauthClients,
        description: "List MCP OAuth clients that can access MCP gateways",
        tags: ["MCP OAuth Clients"],
        querystring: z.object({
          search: z.string().trim().min(1).optional(),
          labels: z
            .string()
            .optional()
            .describe(
              "Filter by labels. Format: key1:val1|val2;key2:val3. AND across keys, OR within values.",
            ),
        }),
        response: constructResponseSchema(z.array(McpOauthClientSchema)),
      },
    },
    async ({ user, organizationId, query }, reply) => {
      const oauthClients = await McpOauthClientModel.findAllByOrganization({
        organizationId,
        search: query.search,
        labels: parseLabelsParam(query.labels),
        viewer: { userId: user.id },
      });
      return reply.send(oauthClients);
    },
  );

  fastify.post(
    "/api/mcp-oauth-clients",
    {
      schema: {
        operationId: RouteId.CreateMcpOauthClient,
        description:
          "Create an MCP OAuth client and return its client secret once",
        tags: ["MCP OAuth Clients"],
        body: CreateMcpOauthClientBodySchema,
        response: constructResponseSchema(McpOauthClientWithSecretSchema),
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
          resource: "mcpOauthClient",
          grants: body.initialGrants,
          target: {
            id: randomUUID(),
            name: body.name,
            authorId: user.id,
          },
        });
        // SPDX-SnippetEnd
      }

      if (body.allowedGatewayIds && body.allowedGatewayIds.length > 0) {
        await validateMcpOauthClientConfig({
          organizationId,
          allowedGatewayIds: body.allowedGatewayIds,
        });
      }
      const { oauthClient, clientSecret } = await McpOauthClientModel.create({
        organizationId,
        name: body.name,
        grantType: body.grantType,
        allowedGatewayIds: body.allowedGatewayIds,
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
    "/api/mcp-oauth-clients/:id",
    {
      schema: {
        operationId: RouteId.UpdateMcpOauthClient,
        description: "Update an MCP OAuth client",
        tags: ["MCP OAuth Clients"],
        params: z.object({ id: z.string() }),
        body: UpdateMcpOauthClientBodySchema,
        response: constructResponseSchema(McpOauthClientSchema),
      },
    },
    async ({ params, body, user, organizationId }, reply) => {
      await requireOauthClientAccess({
        organizationId,
        userId: user.id,
        resource: "mcpOauthClient",
        id: params.id,
        action: "update",
      });

      if (body.allowedGatewayIds && body.allowedGatewayIds.length > 0) {
        await validateMcpOauthClientConfig({
          organizationId,
          allowedGatewayIds: body.allowedGatewayIds,
        });
      }
      const oauthClient = await McpOauthClientModel.update({
        id: params.id,
        organizationId,
        name: body.name,
        allowedGatewayIds: body.allowedGatewayIds,
        redirectUris: body.redirectUris,
      });
      if (!oauthClient) {
        throw new ApiError(404, "MCP OAuth client not found");
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
    "/api/mcp-oauth-clients/:id/rotate-secret",
    {
      schema: {
        operationId: RouteId.RotateMcpOauthClientSecret,
        description: "Rotate an MCP OAuth client's client secret",
        tags: ["MCP OAuth Clients"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(McpOauthClientWithSecretSchema),
      },
    },
    async ({ params, user, organizationId }, reply) => {
      await requireOauthClientAccess({
        organizationId,
        userId: user.id,
        resource: "mcpOauthClient",
        id: params.id,
        action: "update",
      });
      const result = await McpOauthClientModel.rotateSecret({
        id: params.id,
        organizationId,
      });
      if (!result) {
        throw new ApiError(404, "MCP OAuth client not found");
      }
      return reply.send({
        ...result.oauthClient,
        clientSecret: result.clientSecret,
      });
    },
  );

  fastify.delete(
    "/api/mcp-oauth-clients/:id",
    {
      schema: {
        operationId: RouteId.DeleteMcpOauthClient,
        description: "Delete an MCP OAuth client",
        tags: ["MCP OAuth Clients"],
        params: z.object({ id: z.string() }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, user, organizationId }, reply) => {
      await requireOauthClientAccess({
        organizationId,
        userId: user.id,
        resource: "mcpOauthClient",
        id: params.id,
        action: "delete",
      });
      const success = await McpOauthClientModel.delete({
        id: params.id,
        organizationId,
      });
      if (!success) {
        throw new ApiError(404, "MCP OAuth client not found");
      }
      return reply.send({ success });
    },
  );
};

export default mcpOauthClientsRoutes;

async function validateMcpOauthClientConfig(params: {
  organizationId: string;
  allowedGatewayIds: string[];
}) {
  for (const gatewayId of params.allowedGatewayIds) {
    const agent = await AgentModel.findById(gatewayId);
    // An OAuth client may be scoped to MCP gateways and/or A2A agents (both are
    // reached by id through validateMCPGatewayToken). llm_proxy agents have
    // their own LLM OAuth clients and are not eligible here.
    if (
      !agent ||
      agent.organizationId !== params.organizationId ||
      (agent.agentType !== "mcp_gateway" && agent.agentType !== "agent")
    ) {
      throw new ApiError(404, "MCP gateway or agent not found");
    }
  }
}
