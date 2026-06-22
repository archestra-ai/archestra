import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentModel, McpOauthClientModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  McpOauthClientGrantTypeSchema,
  McpOauthClientSchema,
  McpOauthClientWithSecretSchema,
} from "@/types";

/**
 * Both grant types share one body shape. `grantType` defaults to
 * `client_credentials` so existing callers keep working unchanged.
 * - client_credentials: requires `allowedGatewayIds` (the sole authority for the
 *   token); `redirectUris` is ignored.
 * - authorization_code: requires `redirectUris`. `allowedGatewayIds` is optional
 *   here and acts as an additive, admin-controlled grant — users who
 *   authenticate through the client may reach those gateways on top of their own
 *   RBAC. Empty means pure identity passthrough.
 */
const McpOauthClientBodySchema = z
  .object({
    name: z.string().min(1).max(256),
    grantType: McpOauthClientGrantTypeSchema.default("client_credentials"),
    allowedGatewayIds: z.array(z.string().uuid()).optional(),
    redirectUris: z.array(z.string().url()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.grantType === "authorization_code") {
      if (!value.redirectUris || value.redirectUris.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["redirectUris"],
          message:
            "At least one redirect URI is required for authorization_code clients",
        });
      }
    } else if (
      !value.allowedGatewayIds ||
      value.allowedGatewayIds.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["allowedGatewayIds"],
        message:
          "At least one gateway is required for client_credentials clients",
      });
    }
  });

const CreateMcpOauthClientBodySchema = McpOauthClientBodySchema;
const UpdateMcpOauthClientBodySchema = McpOauthClientBodySchema;

const mcpOauthClientsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/mcp-oauth-clients",
    {
      schema: {
        operationId: RouteId.GetMcpOauthClients,
        description: "List MCP OAuth clients that can access MCP gateways",
        tags: ["MCP OAuth Clients"],
        querystring: z.object({
          search: z.string().trim().min(1).optional(),
        }),
        response: constructResponseSchema(z.array(McpOauthClientSchema)),
      },
    },
    async ({ organizationId, query }, reply) => {
      const oauthClients = await McpOauthClientModel.findAllByOrganization({
        organizationId,
        search: query.search,
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
    async ({ body, organizationId }, reply) => {
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
      });
      return reply.send({ ...oauthClient, clientSecret });
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
    async ({ params, body, organizationId }, reply) => {
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
    async ({ params, organizationId }, reply) => {
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
    async ({ params, organizationId }, reply) => {
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
    if (
      !agent ||
      agent.organizationId !== params.organizationId ||
      agent.agentType !== "mcp_gateway"
    ) {
      throw new ApiError(404, "MCP gateway not found");
    }
  }
}
