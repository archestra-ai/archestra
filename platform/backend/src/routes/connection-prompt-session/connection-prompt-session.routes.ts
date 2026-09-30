import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { beginConnectionPromptSession } from "@/services/connection-prompt-session";
import { ApiError, constructResponseSchema } from "@/types";
import { ConnectionSetupClientIdSchema } from "@/types/connection-setup";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/api/connection-setups/prompt-session",
    {
      schema: {
        operationId: RouteId.BeginConnectionPromptSession,
        tags: ["Connection Setups"],
        description:
          "Begin a 10-minute connection setup window for the signed-in user without changing the prompt.",
        body: z.object({
          clientId: ConnectionSetupClientIdSchema,
          origin: z.url(),
        }),
        response: constructResponseSchema(
          z.object({
            expiresAt: z.string(),
          }),
        ),
      },
    },
    async (request, reply) => {
      if (request.headers.origin !== request.body.origin) {
        throw new ApiError(400, "Connection origin does not match this page");
      }
      reply.header("Cache-Control", "no-store");
      const session = await beginConnectionPromptSession({
        userId: request.user.id,
        organizationId: request.organizationId,
        clientId: request.body.clientId,
        origin: request.body.origin,
      });
      request.auditAfter = {
        clientId: request.body.clientId,
        expiresAt: session.expiresAt,
      };
      return session;
    },
  );
};

export default routes;
