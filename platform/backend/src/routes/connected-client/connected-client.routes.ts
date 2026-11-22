import {
  CursorQuerySchema,
  createCursorPaginatedResponseSchema,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import config from "@/config";
import { ConnectedClientModel } from "@/models";
import { lastDays } from "@/models/connected-client";
import { agentAdoptionReports } from "@/services/agent-adoption";
import {
  disconnectClient,
  listConnectedClients,
} from "@/services/connected-client";
import { issueDisconnectReference } from "@/services/connection-disconnect-reference";
import {
  AdoptionMemberSortBySchema,
  AgentAdoptionMemberSchema,
  AgentAdoptionSchema,
  AgentAdoptionStatusSchema,
  AgentAdoptionUsageSchema,
  ApiError,
  ConnectedClientIdSchema,
  ConnectedClientSchema,
  ConnectionEventActionSchema,
  ConnectionEventSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SortDirectionSchema,
} from "@/types";

/** The window when none is picked; calls in the window make a member active. */
const DEFAULT_WINDOW_DAYS = 30;

const WindowQuerySchema = z.object({
  startDate: z
    .string()
    .datetime()
    .optional()
    .describe(
      "Traffic on or after this date (ISO 8601); the last 30 days when left out",
    ),
  endDate: z
    .string()
    .datetime()
    .optional()
    .describe("Traffic on or before this date (ISO 8601); now when left out"),
});

function adoptionWindow(query: z.infer<typeof WindowQuerySchema>) {
  const until = query.endDate ? new Date(query.endDate) : new Date();
  return query.startDate
    ? { since: new Date(query.startDate), until }
    : lastDays(DEFAULT_WINDOW_DAYS, until);
}

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
          "Log of agent connections, newest first (the caller's own clients unless they hold `clientConnection:admin`): an event each time a member connected a coding client through the Connect page, with the machine and what the setup included, each time one was disconnected, and each agent's first OAuth sign-in to the gateway under the name it registered.",
        tags: ["Connection Setups"],
        querystring: CursorQuerySchema.extend({
          userId: z
            .string()
            .optional()
            .describe("Only events for this user's clients"),
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
      user,
      query: { limit, cursor, userId, action, startDate, endDate },
    }) => {
      // clientConnection:read scopes the log to the caller's own clients;
      // clientConnection:admin lifts it to the whole organization.
      const canSeeEveryone = await userHasPermission(
        user.id,
        organizationId,
        "clientConnection",
        "admin",
      );
      return ConnectedClientModel.listEvents({
        organizationId,
        pagination: { limit, cursor },
        userId: canSeeEveryone ? userId : user.id,
        action,
        startDate,
        endDate,
      });
    },
  );

  app.get(
    "/api/connected-clients/adoption",
    {
      schema: {
        operationId: RouteId.GetAgentAdoption,
        description:
          "How many organization members there are, and each member with agents or traffic: their agents (set up through the Connect page, signed in to the gateway, or seen calling it or the LLM proxy) and the last MCP gateway and LLM proxy use seen from them. A member is active when their agents made gateway or LLM proxy calls in the window (the last 30 days unless picked); setups and sign-ins alone only show the installer ran. Every other member is not connected; the adoption members endpoint lists every member a page at a time.",
        tags: ["Connection Setups"],
        querystring: WindowQuerySchema,
        response: constructResponseSchema(AgentAdoptionSchema),
      },
    },
    async ({ organizationId, query }) =>
      agentAdoptionReports.get({
        organizationId,
        range: query,
        window: adoptionWindow(query),
      }),
  );

  app.get(
    "/api/connected-clients/adoption/members",
    {
      schema: {
        operationId: RouteId.GetAgentAdoptionMembers,
        description:
          "Every organization member a page at a time, as the adoption summary describes them over the same window: members without an agent or traffic are not connected. Filter by state and search names, emails and agent names; sort by state (members without an agent first), name, or last MCP or LLM proxy call (newest first).",
        tags: ["Connection Setups"],
        querystring: WindowQuerySchema.extend(
          PaginationQuerySchema.shape,
        ).extend({
          // Large enough for an export to page through quickly.
          limit: z.coerce.number().int().min(1).max(1000).default(25),
          state: AgentAdoptionStatusSchema.optional().describe(
            "Only members in this state",
          ),
          search: z
            .string()
            .optional()
            .describe("Matches names, emails and agent names"),
          sortBy: AdoptionMemberSortBySchema.default("state"),
          sortDirection: SortDirectionSchema.default("asc"),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(AgentAdoptionMemberSchema),
        ),
      },
    },
    async ({ organizationId, query }) => {
      const { startDate, endDate, limit, offset, ...list } = query;
      const adoption = await agentAdoptionReports.get({
        organizationId,
        range: { startDate, endDate },
        window: adoptionWindow({ startDate, endDate }),
      });
      return ConnectedClientModel.listAdoptionMembers({
        organizationId,
        adoption,
        ...list,
        pagination: { limit, offset },
      });
    },
  );

  app.get(
    "/api/connected-clients/adoption/usage",
    {
      schema: {
        operationId: RouteId.GetAgentAdoptionUsage,
        description:
          "MCP gateway and LLM proxy calls from members' agents per UTC day over the window (the last 30 days unless picked), for one member or the whole organization. Counts the same traffic as the adoption summary.",
        tags: ["Connection Setups"],
        querystring: WindowQuerySchema.extend({
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
        window: adoptionWindow(query),
        userId: query.userId,
      }),
  );

  app.get(
    "/api/connected-clients/disconnect-reference",
    {
      schema: {
        operationId: RouteId.GetDisconnectReference,
        // Listed in the API reference once the docs for it ship.
        hide: true,
        description:
          "A reference for the signed-in user's cleanup prompt. Guardrails leave the first conversation of that user that presents it unchecked until it expires, so the cleanup can remove the gateway and the Guardrails helpers without depending on them. Only a browser session gets one: an API key or a service account cannot exempt a conversation.",
        tags: ["Connection Setups"],
        response: constructResponseSchema(
          z.object({
            reference: z.string(),
            expiresAt: z.string().datetime(),
          }),
        ),
      },
    },
    async ({ organizationId, user, authMethod }, reply) => {
      if (authMethod !== "session")
        throw new ApiError(
          403,
          "A disconnect reference is only issued to a signed-in browser session",
        );
      const { reference, expiresAt } = issueDisconnectReference({
        organizationId,
        userId: user.id,
        secret: config.auth.secret,
      });
      reply.header("Cache-Control", "no-store");
      return { reference, expiresAt: new Date(expiresAt).toISOString() };
    },
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
