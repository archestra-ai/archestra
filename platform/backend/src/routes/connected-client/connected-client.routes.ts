import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ConnectedClientModel } from "@/models";
import {
  disconnectClient,
  listConnectedClients,
} from "@/services/connected-client";
import {
  ConnectedClientIdSchema,
  ConnectedClientSchema,
  ConnectionLogEntrySchema,
  ConnectionSetupClientIdSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
} from "@/types";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/api/connected-clients",
    {
      schema: {
        operationId: RouteId.GetConnectedClients,
        description:
          "List the coding clients the signed-in user connected through the Connect page, from their redeemed setup tickets and, for clients the gateway can tell apart, their gateway sign-in.",
        tags: ["Connection Setups"],
        response: constructResponseSchema(z.array(ConnectedClientSchema)),
      },
    },
    async ({ organizationId, user }) =>
      listConnectedClients({ organizationId, userId: user.id }),
  );

  app.get(
    "/api/connected-clients/log",
    {
      schema: {
        operationId: RouteId.GetConnectedClientLog,
        description:
          "Log of the organization's agent connections, newest first: one entry each time a member connected a coding client through the Connect page, with the machine and what the setup included.",
        tags: ["Connection Setups"],
        querystring: PaginationQuerySchema.extend({
          search: z
            .string()
            .optional()
            .describe(
              "Search by user name or email. Case-insensitive: every whitespace-separated word must appear in the name or the email.",
            ),
          clientId: ConnectionSetupClientIdSchema.optional().describe(
            "Only connections of this client",
          ),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(ConnectionLogEntrySchema),
        ),
      },
    },
    async ({ organizationId, query: { limit, offset, search, clientId } }) =>
      ConnectedClientModel.listLog({
        organizationId,
        pagination: { limit, offset },
        search: search || undefined,
        clientId,
      }),
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
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, user, params }) => {
      await disconnectClient({
        organizationId,
        userId: user.id,
        clientId: params.clientId,
        actorUserId: user.id,
      });
      return { success: true };
    },
  );
};

export default routes;
