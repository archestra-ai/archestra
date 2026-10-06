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
  AgentAdoptionSchema,
  AgentAdoptionUsageSchema,
  ConnectedClientIdSchema,
  ConnectedClientSchema,
  ConnectionEventActionSchema,
  ConnectionEventSchema,
  ConnectionSetupClientIdSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
} from "@/types";

/** Traffic this recent counts as active; older traffic is read this far back. */
const ADOPTION_ACTIVE_DAYS = 7;
const ADOPTION_LOOKBACK_DAYS = 30;

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
          "Log of the organization's agent connections, newest first: an event each time a member connected a coding client through the Connect page, with the machine and what the setup included, each time one was disconnected, and each agent's first OAuth sign-in to the gateway under the name it registered.",
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

  app.get(
    "/api/connected-clients/adoption",
    {
      schema: {
        operationId: RouteId.GetAgentAdoption,
        description:
          "Every organization member with their agent adoption: agents set up through the Connect page, and the last MCP gateway, LLM proxy and skill use seen from their agents. A member counts as active when their agents made gateway or LLM proxy calls in the last 7 days; setups alone only show the installer ran.",
        tags: ["Connection Setups"],
        response: constructResponseSchema(AgentAdoptionSchema),
      },
    },
    async ({ organizationId }) =>
      ConnectedClientModel.getAdoption({
        organizationId,
        activeDays: ADOPTION_ACTIVE_DAYS,
        lookbackDays: ADOPTION_LOOKBACK_DAYS,
      }),
  );

  app.get(
    "/api/connected-clients/adoption/usage",
    {
      schema: {
        operationId: RouteId.GetAgentAdoptionUsage,
        description:
          "MCP gateway and LLM proxy calls from members' agents per day over the last 30 days, for one member or the whole organization. Counts the same traffic as the adoption summary.",
        tags: ["Connection Setups"],
        querystring: z.object({
          userId: z
            .string()
            .optional()
            .describe(
              "Only this member's calls; the whole organization when left out",
            ),
        }),
        response: constructResponseSchema(AgentAdoptionUsageSchema),
      },
    },
    async ({ organizationId, query }) =>
      ConnectedClientModel.getAdoptionUsage({
        organizationId,
        lookbackDays: ADOPTION_LOOKBACK_DAYS,
        userId: query.userId,
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
