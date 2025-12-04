import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { SecretsManagerType, secretManager } from "@/secretsmanager";
import { constructResponseSchema } from "@/types";

const SecretsManagerTypeSchema = z.nativeEnum(SecretsManagerType);

const secretsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/secrets/type",
    {
      schema: {
        operationId: RouteId.GetSecretsType,
        description: "Get the secrets manager type",
        tags: ["Secrets"],
        response: constructResponseSchema(
          z.object({
            type: SecretsManagerTypeSchema,
          }),
        ),
      },
    },
    async (_request, reply) => {
      return reply.send({
        type: secretManager.type,
      });
    },
  );

  fastify.post(
    "/api/secrets/check-connectivity",
    {
      schema: {
        operationId: RouteId.CheckSecretsConnectivity,
        description:
          "Check connectivity to the secrets storage and return secret count",
        tags: ["Secrets"],
        response: constructResponseSchema(
          z.object({
            type: SecretsManagerTypeSchema,
            connected: z.literal(true),
            secretCount: z.number(),
          }),
        ),
      },
    },
    async (_request, reply) => {
      const result = await secretManager.checkConnectivity();
      return reply.send(result);
    },
  );
};

export default secretsRoutes;
