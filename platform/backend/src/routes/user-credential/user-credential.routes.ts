import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { UserCredentialModel } from "@/models";
import { ApiError, constructResponseSchema } from "@/types";

/**
 * A person's own credentials, for agents that must act with their upstream
 * identity (a personal Claude token, a personal GitHub PAT).
 *
 * Every route is scoped to the caller. There is deliberately no administrative
 * read path and no way to retrieve a stored value — an owner may replace or
 * delete their credential, and nothing else.
 */
const CredentialSummarySchema = z.object({
  key: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const userCredentialRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/account/credentials",
    {
      schema: {
        operationId: RouteId.GetAllUserCredentials,
        description: "List the credentials the current user has supplied",
        tags: ["Account"],
        response: constructResponseSchema(z.array(CredentialSummarySchema)),
      },
    },
    async ({ organizationId, user }, reply) => {
      const credentials = await UserCredentialModel.listForUser({
        organizationId,
        userId: user.id,
      });
      // Values never leave the secrets manager; only their existence does.
      return reply.send(
        credentials.map(({ key, createdAt, updatedAt }) => ({
          key,
          createdAt,
          updatedAt,
        })),
      );
    },
  );

  fastify.put(
    "/api/account/credentials/:key",
    {
      schema: {
        operationId: RouteId.UpsertUserCredential,
        description: "Store or replace one of the current user's credentials",
        tags: ["Account"],
        params: z.object({
          key: z
            .string()
            .min(1)
            .max(128)
            .regex(
              /^[A-Z_][A-Z0-9_]*$/,
              "Credential keys are environment variable names (A-Z, 0-9, underscore)",
            ),
        }),
        body: z.object({ value: z.string().min(1).max(20_000) }),
        response: constructResponseSchema(CredentialSummarySchema),
      },
    },
    async ({ params, body, organizationId, user }, reply) => {
      const credential = await UserCredentialModel.upsert({
        organizationId,
        userId: user.id,
        key: params.key,
        value: body.value,
      });
      return reply.send({
        key: credential.key,
        createdAt: credential.createdAt,
        updatedAt: credential.updatedAt,
      });
    },
  );

  fastify.delete(
    "/api/account/credentials/:key",
    {
      schema: {
        operationId: RouteId.DeleteUserCredential,
        description: "Delete one of the current user's credentials",
        tags: ["Account"],
        params: z.object({ key: z.string().min(1).max(128) }),
        response: constructResponseSchema(z.object({ deleted: z.boolean() })),
      },
    },
    async ({ params, organizationId, user }, reply) => {
      const deleted = await UserCredentialModel.delete({
        organizationId,
        userId: user.id,
        key: params.key,
      });
      if (!deleted) {
        throw new ApiError(404, "Credential not found");
      }
      return reply.send({ deleted });
    },
  );
};

export default userCredentialRoutes;
