import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createGithubAppConfig,
  deleteGithubAppConfig,
  getGithubAppConfig,
  listGithubAppConfigs,
  updateGithubAppConfig,
} from "@/services/github-app-config";
import {
  CreateGithubAppConfigRequestSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  PublicGithubAppConfigSchema,
  UpdateGithubAppConfigRequestSchema,
  UuidIdSchema,
} from "@/types";

const githubAppConfigRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/github-app-configs",
    {
      schema: {
        operationId: RouteId.ListGithubAppConfigs,
        description:
          "List organization GitHub App configurations. The private key is never returned.",
        tags: ["GitHub App Configs"],
        response: constructResponseSchema(z.array(PublicGithubAppConfigSchema)),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(await listGithubAppConfigs(organizationId));
    },
  );

  fastify.get(
    "/api/github-app-configs/:id",
    {
      schema: {
        operationId: RouteId.GetGithubAppConfig,
        description:
          "Get a GitHub App configuration. The private key is never returned.",
        tags: ["GitHub App Configs"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(PublicGithubAppConfigSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      return reply.send(
        await getGithubAppConfig({ id: params.id, organizationId }),
      );
    },
  );

  fastify.post(
    "/api/github-app-configs",
    {
      schema: {
        operationId: RouteId.CreateGithubAppConfig,
        description:
          "Create a GitHub App configuration. The private key is stored as a secret and never returned.",
        tags: ["GitHub App Configs"],
        body: CreateGithubAppConfigRequestSchema,
        response: constructResponseSchema(PublicGithubAppConfigSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      return reply.send(
        await createGithubAppConfig({ organizationId, data: body }),
      );
    },
  );

  fastify.put(
    "/api/github-app-configs/:id",
    {
      schema: {
        operationId: RouteId.UpdateGithubAppConfig,
        description:
          "Update a GitHub App configuration. Provide a private key only to rotate it.",
        tags: ["GitHub App Configs"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateGithubAppConfigRequestSchema,
        response: constructResponseSchema(PublicGithubAppConfigSchema),
      },
    },
    async ({ organizationId, params, body }, reply) => {
      return reply.send(
        await updateGithubAppConfig({
          id: params.id,
          organizationId,
          data: body,
        }),
      );
    },
  );

  fastify.delete(
    "/api/github-app-configs/:id",
    {
      schema: {
        operationId: RouteId.DeleteGithubAppConfig,
        description:
          "Delete a GitHub App configuration and its stored private key.",
        tags: ["GitHub App Configs"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      await deleteGithubAppConfig({ id: params.id, organizationId });
      return reply.send({ success: true });
    },
  );
};

export default githubAppConfigRoutes;
