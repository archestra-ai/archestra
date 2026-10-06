import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ConnectedClientModel } from "@/models";
import { disconnectClient } from "@/services/connected-client";
import {
  ConnectedClientIdSchema,
  ConnectedClientSchema,
  ConnectedUserSchema,
  constructResponseSchema,
} from "@/types";

const DisconnectResultSchema = z.object({
  setups: z.number().int(),
  oauthClients: z.number().int(),
  tokens: z.number().int(),
  shareLinks: z.number().int(),
});

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/api/connected-clients",
    {
      schema: {
        operationId: RouteId.GetConnectedClients,
        description:
          "List the coding clients the signed-in user connected through the Connect page, from their redeemed setup tickets.",
        tags: ["Connection Setups"],
        response: constructResponseSchema(z.array(ConnectedClientSchema)),
      },
    },
    async ({ organizationId, user }) =>
      ConnectedClientModel.listForUser({ organizationId, userId: user.id }),
  );

  app.get(
    "/api/connected-clients/users",
    {
      schema: {
        operationId: RouteId.GetConnectedUsers,
        description:
          "List members who connected a coding client, with their MCP gateway and LLM proxy use over the last 30 days.",
        tags: ["Connection Setups"],
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(ConnectedUserSchema),
        ),
      },
    },
    async ({ organizationId, query }) =>
      ConnectedClientModel.listConnectedUsers({ organizationId, ...query }),
  );

  app.delete(
    "/api/connected-clients/:clientId",
    {
      schema: {
        operationId: RouteId.DisconnectConnectedClient,
        description:
          "Disconnect one of the signed-in user's coding clients: it leaves the connected list and the skill share links its setups created are revoked. Where the gateway can tell the client apart by its OAuth client (Claude Code, Amp), the user's tokens and consent for it are deleted too; other clients keep their gateway sign-in until it expires. Local client configuration is removed separately by /disconnect.md.",
        tags: ["Connection Setups"],
        params: z.object({ clientId: ConnectedClientIdSchema }),
        response: constructResponseSchema(DisconnectResultSchema),
      },
    },
    async ({ organizationId, user, params }) =>
      disconnectClient({
        organizationId,
        userId: user.id,
        clientId: params.clientId,
        actorUserId: user.id,
      }),
  );

  app.delete(
    "/api/connected-clients/users/:userId/:clientId",
    {
      schema: {
        operationId: RouteId.DisconnectConnectedUserClient,
        description:
          "Disconnect a member's coding client, as DELETE /api/connected-clients/:clientId does for the caller's own.",
        tags: ["Connection Setups"],
        params: z.object({
          userId: z.string(),
          clientId: ConnectedClientIdSchema,
        }),
        response: constructResponseSchema(DisconnectResultSchema),
      },
    },
    async ({ organizationId, user, params }) =>
      disconnectClient({
        organizationId,
        userId: params.userId,
        clientId: params.clientId,
        actorUserId: user.id,
      }),
  );
};

export default routes;
