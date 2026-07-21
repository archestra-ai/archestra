import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createGithubPat,
  deleteGithubPat,
  listGithubPats,
  updateGithubPat,
} from "@/services/github-pat";
import {
  CreateGithubPatRequestSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  PublicGithubPatSchema,
  UpdateGithubPatRequestSchema,
  UuidIdSchema,
} from "@/types";

/**
 * Stored GitHub personal access tokens, managed at /settings/github alongside
 * GitHub App configs (same RBAC resource). The token value is stored in the
 * secret manager and is never returned by any endpoint. Stored tokens
 * authenticate skill imports and recurring skill sync.
 */
const githubPatRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/github-pats",
    {
      schema: {
        operationId: RouteId.ListGithubPats,
        description:
          "List organization GitHub personal access tokens. The token value is never returned.",
        tags: ["GitHub PATs"],
        response: constructResponseSchema(z.array(PublicGithubPatSchema)),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(await listGithubPats(organizationId));
    },
  );

  fastify.post(
    "/api/github-pats",
    {
      schema: {
        operationId: RouteId.CreateGithubPat,
        description:
          "Store a GitHub personal access token. The token is stored as a secret and never returned.",
        tags: ["GitHub PATs"],
        body: CreateGithubPatRequestSchema,
        response: constructResponseSchema(PublicGithubPatSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      return reply.send(await createGithubPat({ organizationId, data: body }));
    },
  );

  fastify.put(
    "/api/github-pats/:id",
    {
      schema: {
        operationId: RouteId.UpdateGithubPat,
        description:
          "Rename a stored GitHub token. Provide a token only to rotate it.",
        tags: ["GitHub PATs"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateGithubPatRequestSchema,
        response: constructResponseSchema(PublicGithubPatSchema),
      },
    },
    async ({ organizationId, params, body }, reply) => {
      return reply.send(
        await updateGithubPat({ id: params.id, organizationId, data: body }),
      );
    },
  );

  fastify.delete(
    "/api/github-pats/:id",
    {
      schema: {
        operationId: RouteId.DeleteGithubPat,
        description:
          "Delete a stored GitHub token and its secret. Rejected while synced skills authenticate with it.",
        tags: ["GitHub PATs"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      await deleteGithubPat({ id: params.id, organizationId });
      return reply.send({ success: true });
    },
  );
};

export default githubPatRoutes;
