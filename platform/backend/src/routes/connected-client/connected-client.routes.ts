import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  disconnectClient,
  listConnectedClients,
  listMemberConnections,
} from "@/services/connected-client";
import {
  ConnectedClientIdSchema,
  ConnectedClientSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  MemberConnectionStatusSchema,
  MemberConnectionsSchema,
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
    "/api/connected-clients/members",
    {
      schema: {
        operationId: RouteId.GetMemberConnectedClients,
        description:
          "List the organization's members with the coding clients each connected through the Connect page and when, most recently connected first and never-connected members last. The summary counts every member, whatever the filters.",
        tags: ["Connection Setups"],
        querystring: PaginationQuerySchema.extend({
          name: z
            .string()
            .optional()
            .describe(
              "Search by user name or email. Case-insensitive: every whitespace-separated word must appear in the name or the email.",
            ),
          status: MemberConnectionStatusSchema.optional().describe(
            "Only members who connected at least one client, or only those who never did",
          ),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(MemberConnectionsSchema).extend({
            summary: z.object({
              memberCount: z.number().int(),
              connectedCount: z.number().int(),
            }),
          }),
        ),
      },
    },
    async ({ organizationId, query: { limit, offset, name, status } }) =>
      listMemberConnections({
        organizationId,
        pagination: { limit, offset },
        name: name || undefined,
        status,
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
