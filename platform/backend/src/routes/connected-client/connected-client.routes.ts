import {
  CursorQuerySchema,
  createCursorPaginatedResponseSchema,
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
  ConnectionEventActionSchema,
  ConnectionEventSchema,
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
          "Log of the organization's agent connections, newest first: an event each time a member connected a coding client through the Connect page, with the machine and what the setup included, and each time one was disconnected.",
        tags: ["Connection Setups"],
        querystring: CursorQuerySchema.extend({
          userId: z
            .string()
            .optional()
            .describe("Only events for this user's clients"),
          clientId: ConnectionSetupClientIdSchema.optional().describe(
            "Only events for this client",
          ),
          action: ConnectionEventActionSchema.optional().describe(
            "Only connects or only disconnects",
          ),
          startDate: z
            .string()
            .datetime()
            .optional()
            .describe("Events on or after this date (ISO 8601)"),
          endDate: z
            .string()
            .datetime()
            .optional()
            .describe("Events on or before this date (ISO 8601)"),
        }),
        response: constructResponseSchema(
          createCursorPaginatedResponseSchema(ConnectionEventSchema),
        ),
      },
    },
    async ({
      organizationId,
      query: { limit, cursor, userId, clientId, action, startDate, endDate },
    }) =>
      ConnectedClientModel.listEvents({
        organizationId,
        pagination: { limit, cursor },
        userId,
        clientId,
        action,
        startDate,
        endDate,
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
