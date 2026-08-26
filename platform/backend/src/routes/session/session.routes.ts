import { MAX_BULK_IDS, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { SessionModel } from "@/models";
import { ApiError, constructResponseSchema } from "@/types";
import { BulkOutcomeSchema, runBulk } from "../bulk-route";

const BulkRevokeSessionsBodySchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_BULK_IDS)
    .describe("Session ids to revoke. Duplicates are collapsed."),
});

const sessionRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.delete(
    "/api/sessions/bulk",
    {
      schema: {
        operationId: RouteId.BulkRevokeSessions,
        description:
          "Revoke several non-current sessions belonging to the authenticated " +
          "user in one request. Sessions belonging to another user and the " +
          "current session are reported in `failed`; the rest are revoked.",
        tags: ["Sessions"],
        body: BulkRevokeSessionsBodySchema,
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const userId = request.user.id;
      if (request.authMethod !== "session" || !request.sessionInfo) {
        throw new ApiError(401, "Session authentication required");
      }
      const currentSession = await SessionModel.findByIdsForUser({
        ids: [request.sessionInfo.id],
        userId,
      });
      if (currentSession.length === 0) {
        throw new ApiError(401, "Session is no longer active");
      }
      const snapshot = async (ids: string[]) => ({
        sessionIds: (await SessionModel.findByIdsForUser({ ids, userId }))
          .map(({ id }) => id)
          .sort(),
      });

      const outcome = await runBulk({
        ids: request.body.ids,
        logLabel: "sessions bulk revoke",
        notFoundMessage: "Session not found",
        unexpectedMessage: "Could not revoke this session",
        load: async (ids) =>
          new Map(
            (await SessionModel.findByIdsForUser({ ids, userId })).map(
              (session) => [session.id, session] as const,
            ),
          ),
        describe: (session) => session.id,
        authorize: (_session, id) => {
          if (id === request.sessionInfo?.id) {
            throw new ApiError(400, "Current session cannot be revoked");
          }
        },
        applyAll: async (sessions) => {
          const deleted = await SessionModel.deleteByIdsForUser({
            ids: sessions.map(({ id }) => id),
            userId,
          });
          return deleted.map(({ id }) => id);
        },
        audit: { target: request, snapshot },
      });

      if (outcome.succeeded.length === 0) request.auditSkip = true;

      return reply.send(outcome);
    },
  );
};

export default sessionRoutes;
