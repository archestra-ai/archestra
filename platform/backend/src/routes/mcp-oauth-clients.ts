import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentModel, McpOauthClientModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  McpOauthClientSchema,
  McpOauthClientWithSecretSchema,
} from "@/types";

const CreateMcpOauthClientBodySchema = z.object({
  name: z.string().min(1).max(256),
  allowedGatewayIds: z.array(z.string().uuid()).min(1),
});

const UpdateMcpOauthClientBodySchema = CreateMcpOauthClientBodySchema;

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
      await validateMcpOauthClientConfig({ ...body, organizationId });
      const { oauthClient, clientSecret } = await McpOauthClientModel.create({
        organizationId,
        name: body.name,
        allowedGatewayIds: body.allowedGatewayIds,
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
      await validateMcpOauthClientConfig({ ...body, organizationId });
      const oauthClient = await McpOauthClientModel.update({
        id: params.id,
        organizationId,
        name: body.name,
        allowedGatewayIds: body.allowedGatewayIds,
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
