import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createRuntimeCredentialDefinition,
  deleteRuntimeCredentialConnection,
  deleteRuntimeCredentialDefinition,
  getRuntimeCredentialConnectionAuditSnapshot,
  getRuntimeCredentialUsage,
  listRuntimeCredentialDefinitions,
  setRuntimeCredentialConnection,
  updateRuntimeCredentialDefinition,
} from "@/services/agent-runtime/runtime-credentials";
import { githubUserConnectionManager } from "@/services/github-user-connection";
import {
  constructResponseSchema,
  InsertRuntimeCredentialDefinitionSchema,
  RuntimeCredentialDefinitionViewSchema,
  RuntimeCredentialUsageSchema,
  SelectRuntimeCredentialDefinitionSchema,
  UpdateRuntimeCredentialDefinitionSchema,
} from "@/types";

const runtimeCredentialRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/credentials/:key/github/start",
    {
      schema: {
        operationId: RouteId.StartGitHubUserConnection,
        tags: ["Credentials"],
        params: CredentialKeyParamsSchema,
        response: constructResponseSchema(
          z.object({ authorizationUrl: z.string() }),
        ),
      },
    },
    async (request) => {
      request.auditSkip = true;
      return githubUserConnectionManager.start({
        organizationId: request.organizationId,
        userId: request.user.id,
        credentialId: request.params.key,
      });
    },
  );

  fastify.post(
    "/api/credentials/github/callback",
    {
      schema: {
        operationId: RouteId.CompleteGitHubUserConnection,
        tags: ["Credentials"],
        body: z.object({
          state: z.string().min(1).max(256),
          code: z.string().min(1).max(512),
        }),
        response: constructResponseSchema(
          z.object({
            id: z.string(),
            login: z.string(),
            configured: z.literal(true),
          }),
        ),
      },
    },
    async (request) => {
      const result = await githubUserConnectionManager.complete({
        organizationId: request.organizationId,
        userId: request.user.id,
        ...request.body,
      });
      request.auditBefore = result.before;
      request.auditAfter = result.after;
      return {
        id: result.credentialId,
        login: result.login,
        configured: true as const,
      };
    },
  );

  fastify.get(
    "/api/credentials",
    {
      schema: {
        operationId: RouteId.ListRuntimeCredentials,
        description:
          "List reusable credentials available to platform integrations",
        tags: ["Credentials"],
        response: constructResponseSchema(
          z.array(RuntimeCredentialDefinitionViewSchema),
        ),
      },
    },
    async (request, reply) =>
      reply.send(
        await listRuntimeCredentialDefinitions({
          organizationId: request.organizationId,
          userId: request.user.id,
        }),
      ),
  );

  fastify.post(
    "/api/credentials",
    {
      schema: {
        operationId: RouteId.CreateRuntimeCredential,
        description: "Create a credential definition",
        tags: ["Credentials"],
        body: InsertRuntimeCredentialDefinitionSchema,
        response: constructResponseSchema(
          SelectRuntimeCredentialDefinitionSchema,
        ),
      },
    },
    async (request, reply) => {
      const definition = await createRuntimeCredentialDefinition({
        organizationId: request.organizationId,
        userId: request.user.id,
        definition: request.body,
      });
      return reply.send(definition);
    },
  );

  fastify.get(
    "/api/credentials/:key/usage",
    {
      schema: {
        operationId: RouteId.GetRuntimeCredentialUsage,
        description: "List resources using a saved credential",
        tags: ["Credentials"],
        params: CredentialKeyParamsSchema,
        response: constructResponseSchema(RuntimeCredentialUsageSchema),
      },
    },
    async (request, reply) =>
      reply.send(
        await getRuntimeCredentialUsage({
          organizationId: request.organizationId,
          key: request.params.key,
        }),
      ),
  );

  fastify.patch(
    "/api/credentials/:key",
    {
      schema: {
        operationId: RouteId.UpdateRuntimeCredential,
        description: "Update a credential definition",
        tags: ["Credentials"],
        params: CredentialKeyParamsSchema,
        body: UpdateRuntimeCredentialDefinitionSchema,
        response: constructResponseSchema(
          SelectRuntimeCredentialDefinitionSchema,
        ),
      },
    },
    async (request, reply) =>
      reply.send(
        await updateRuntimeCredentialDefinition({
          organizationId: request.organizationId,
          key: request.params.key,
          definition: request.body,
        }),
      ),
  );

  fastify.delete(
    "/api/credentials/:key",
    {
      schema: {
        operationId: RouteId.DeleteRuntimeCredential,
        description: "Delete a credential definition",
        tags: ["Credentials"],
        params: CredentialKeyParamsSchema,
        response: constructResponseSchema(
          z.object({ deleted: z.literal(true) }),
        ),
      },
    },
    async (request, reply) => {
      await deleteRuntimeCredentialDefinition({
        organizationId: request.organizationId,
        key: request.params.key,
      });
      return reply.send({ deleted: true as const });
    },
  );

  fastify.put(
    "/api/credentials/:key/personal",
    {
      schema: {
        operationId: RouteId.SetPersonalRuntimeCredentialConnection,
        description: "Connect a personal credential",
        tags: ["Credentials"],
        params: CredentialKeyParamsSchema,
        body: ConnectionValueSchema,
        response: constructResponseSchema(
          z.object({ configured: z.literal(true) }),
        ),
      },
    },
    async (request, reply) => {
      request.auditSkip = true;
      await setRuntimeCredentialConnection({
        organizationId: request.organizationId,
        userId: request.user.id,
        credentialId: request.params.key,
        scope: "personal",
        value: request.body.value,
      });
      return reply.send({ configured: true as const });
    },
  );

  fastify.delete(
    "/api/credentials/:key/personal",
    {
      schema: {
        operationId: RouteId.DeletePersonalRuntimeCredentialConnection,
        description: "Disconnect a personal credential",
        tags: ["Credentials"],
        params: CredentialKeyParamsSchema,
        response: constructResponseSchema(z.object({ deleted: z.boolean() })),
      },
    },
    async (request, reply) => {
      request.auditBefore = await getRuntimeCredentialConnectionAuditSnapshot({
        organizationId: request.organizationId,
        userId: request.user.id,
        credentialId: request.params.key,
        scope: "personal",
      });
      const deleted = await deleteRuntimeCredentialConnection({
        organizationId: request.organizationId,
        userId: request.user.id,
        credentialId: request.params.key,
        scope: "personal",
      });
      if (!deleted) request.auditSkip = true;
      request.auditAfter = null;
      return reply.send({ deleted });
    },
  );

  fastify.put(
    "/api/credentials/:key/organization",
    {
      schema: {
        operationId: RouteId.SetOrganizationRuntimeCredentialConnection,
        description: "Connect an organization credential",
        tags: ["Credentials"],
        params: CredentialKeyParamsSchema,
        body: ConnectionValueSchema,
        response: constructResponseSchema(
          z.object({ configured: z.literal(true) }),
        ),
      },
    },
    async (request, reply) => {
      const before = await getRuntimeCredentialConnectionAuditSnapshot({
        organizationId: request.organizationId,
        credentialId: request.params.key,
        scope: "organization",
      });
      await setRuntimeCredentialConnection({
        organizationId: request.organizationId,
        userId: request.user.id,
        credentialId: request.params.key,
        scope: "organization",
        value: request.body.value,
      });
      request.auditBefore = before;
      request.auditAfter = await getRuntimeCredentialConnectionAuditSnapshot({
        organizationId: request.organizationId,
        credentialId: request.params.key,
        scope: "organization",
      });
      return reply.send({ configured: true as const });
    },
  );

  fastify.delete(
    "/api/credentials/:key/organization",
    {
      schema: {
        operationId: RouteId.DeleteOrganizationRuntimeCredentialConnection,
        description: "Disconnect an organization credential",
        tags: ["Credentials"],
        params: CredentialKeyParamsSchema,
        response: constructResponseSchema(z.object({ deleted: z.boolean() })),
      },
    },
    async (request, reply) => {
      request.auditBefore = await getRuntimeCredentialConnectionAuditSnapshot({
        organizationId: request.organizationId,
        credentialId: request.params.key,
        scope: "organization",
      });
      const deleted = await deleteRuntimeCredentialConnection({
        organizationId: request.organizationId,
        userId: request.user.id,
        credentialId: request.params.key,
        scope: "organization",
      });
      if (!deleted) request.auditSkip = true;
      request.auditAfter = null;
      return reply.send({ deleted });
    },
  );
};

export default runtimeCredentialRoutes;

// ===================== Internals =====================

const CredentialKeyParamsSchema = z.object({
  key: z.string().min(1).max(128),
});

const ConnectionValueSchema = z.object({
  value: z.string().min(1).max(20_000),
});
