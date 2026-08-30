import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isAnyRunnerBackendEnabled } from "@/services/runners/backends";
import {
  createExecutionCredentialDefinition,
  deleteExecutionCredentialConnection,
  deleteExecutionCredentialDefinition,
  getExecutionCredentialConnectionAuditSnapshot,
  getExecutionCredentialUsage,
  listExecutionCredentialDefinitions,
  setExecutionCredentialConnection,
  updateExecutionCredentialDefinition,
} from "@/services/runners/execution-credentials";
import {
  ApiError,
  constructResponseSchema,
  ExecutionCredentialDefinitionViewSchema,
  ExecutionCredentialUsageSchema,
  InsertExecutionCredentialDefinitionSchema,
  SelectExecutionCredentialDefinitionSchema,
  UpdateExecutionCredentialDefinitionSchema,
} from "@/types";

const executionCredentialRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("preHandler", async () => {
    if (!isAnyRunnerBackendEnabled()) throw new ApiError(404, "Not found");
  });

  fastify.get(
    "/api/execution-credentials",
    {
      schema: {
        operationId: RouteId.ListExecutionCredentials,
        description: "List execution credentials available to Agents",
        tags: ["Agents"],
        response: constructResponseSchema(
          z.array(ExecutionCredentialDefinitionViewSchema),
        ),
      },
    },
    async (request, reply) =>
      reply.send(
        await listExecutionCredentialDefinitions({
          organizationId: request.organizationId,
          userId: request.user.id,
        }),
      ),
  );

  fastify.post(
    "/api/execution-credentials",
    {
      schema: {
        operationId: RouteId.CreateExecutionCredential,
        description: "Create an execution credential definition",
        tags: ["Agents"],
        body: InsertExecutionCredentialDefinitionSchema,
        response: constructResponseSchema(
          SelectExecutionCredentialDefinitionSchema,
        ),
      },
    },
    async (request, reply) => {
      const definition = await createExecutionCredentialDefinition({
        organizationId: request.organizationId,
        userId: request.user.id,
        definition: request.body,
      });
      return reply.send(definition);
    },
  );

  fastify.get(
    "/api/execution-credentials/:key/usage",
    {
      schema: {
        operationId: RouteId.GetExecutionCredentialUsage,
        description: "List Agents using an execution credential",
        tags: ["Agents"],
        params: CredentialKeyParamsSchema,
        response: constructResponseSchema(ExecutionCredentialUsageSchema),
      },
    },
    async (request, reply) =>
      reply.send(
        await getExecutionCredentialUsage({
          organizationId: request.organizationId,
          key: request.params.key,
        }),
      ),
  );

  fastify.patch(
    "/api/execution-credentials/:key",
    {
      schema: {
        operationId: RouteId.UpdateExecutionCredential,
        description: "Update an execution credential definition",
        tags: ["Agents"],
        params: CredentialKeyParamsSchema,
        body: UpdateExecutionCredentialDefinitionSchema,
        response: constructResponseSchema(
          SelectExecutionCredentialDefinitionSchema,
        ),
      },
    },
    async (request, reply) =>
      reply.send(
        await updateExecutionCredentialDefinition({
          organizationId: request.organizationId,
          key: request.params.key,
          definition: request.body,
        }),
      ),
  );

  fastify.delete(
    "/api/execution-credentials/:key",
    {
      schema: {
        operationId: RouteId.DeleteExecutionCredential,
        description: "Delete an execution credential definition",
        tags: ["Agents"],
        params: CredentialKeyParamsSchema,
        response: constructResponseSchema(
          z.object({ deleted: z.literal(true) }),
        ),
      },
    },
    async (request, reply) => {
      await deleteExecutionCredentialDefinition({
        organizationId: request.organizationId,
        key: request.params.key,
      });
      return reply.send({ deleted: true as const });
    },
  );

  fastify.put(
    "/api/execution-credentials/:key/personal",
    {
      schema: {
        operationId: RouteId.SetPersonalExecutionCredentialConnection,
        description: "Connect a personal execution credential",
        tags: ["Agents"],
        params: CredentialKeyParamsSchema,
        body: ConnectionValueSchema,
        response: constructResponseSchema(
          z.object({ configured: z.literal(true) }),
        ),
      },
    },
    async (request, reply) => {
      request.auditSkip = true;
      await setExecutionCredentialConnection({
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
    "/api/execution-credentials/:key/personal",
    {
      schema: {
        operationId: RouteId.DeletePersonalExecutionCredentialConnection,
        description: "Disconnect a personal execution credential",
        tags: ["Agents"],
        params: CredentialKeyParamsSchema,
        response: constructResponseSchema(z.object({ deleted: z.boolean() })),
      },
    },
    async (request, reply) => {
      request.auditSkip = true;
      const deleted = await deleteExecutionCredentialConnection({
        organizationId: request.organizationId,
        userId: request.user.id,
        credentialId: request.params.key,
        scope: "personal",
      });
      return reply.send({ deleted });
    },
  );

  fastify.put(
    "/api/execution-credentials/:key/organization",
    {
      schema: {
        operationId: RouteId.SetOrganizationExecutionCredentialConnection,
        description: "Connect an organization execution credential",
        tags: ["Agents"],
        params: CredentialKeyParamsSchema,
        body: ConnectionValueSchema,
        response: constructResponseSchema(
          z.object({ configured: z.literal(true) }),
        ),
      },
    },
    async (request, reply) => {
      const before = await getExecutionCredentialConnectionAuditSnapshot({
        organizationId: request.organizationId,
        credentialId: request.params.key,
        scope: "organization",
      });
      await setExecutionCredentialConnection({
        organizationId: request.organizationId,
        userId: request.user.id,
        credentialId: request.params.key,
        scope: "organization",
        value: request.body.value,
      });
      request.auditBefore = before;
      request.auditAfter = await getExecutionCredentialConnectionAuditSnapshot({
        organizationId: request.organizationId,
        credentialId: request.params.key,
        scope: "organization",
      });
      return reply.send({ configured: true as const });
    },
  );

  fastify.delete(
    "/api/execution-credentials/:key/organization",
    {
      schema: {
        operationId: RouteId.DeleteOrganizationExecutionCredentialConnection,
        description: "Disconnect an organization execution credential",
        tags: ["Agents"],
        params: CredentialKeyParamsSchema,
        response: constructResponseSchema(z.object({ deleted: z.boolean() })),
      },
    },
    async (request, reply) => {
      request.auditBefore = await getExecutionCredentialConnectionAuditSnapshot(
        {
          organizationId: request.organizationId,
          credentialId: request.params.key,
          scope: "organization",
        },
      );
      const deleted = await deleteExecutionCredentialConnection({
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

export default executionCredentialRoutes;

// ===================== Internals =====================

const CredentialKeyParamsSchema = z.object({
  key: z.string().min(1).max(128),
});

const ConnectionValueSchema = z.object({
  value: z.string().min(1).max(20_000),
});
